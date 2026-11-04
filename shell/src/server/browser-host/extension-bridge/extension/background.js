// career-bridge background service worker
// 架构移植自 lsdefine/GenericAgent 的 assets/tmwd_cdp_bridge/background.js（MIT）：
// 主动连出 WebSocket 到本地 Node 服务，页面零自动化痕迹；MV3 service worker
// 会被休眠，用 chrome.alarms 轮询探活 + keepalive 保活。

importScripts('connection.js');
const wsUrl = globalThis.CAREER_BRIDGE_CONFIG.url;
const connectionToken = globalThis.CAREER_BRIDGE_CONFIG.token;
let ws = null;
let disconnecting = false;
let announced = false;
const PROBE_MS = 2000;
const KEEPALIVE_MS = 20000;
const PROBE_TIMEOUT_MS = 2000;
let probeTimer = null;
let keepaliveTimer = null;

function log(...a) { try { console.log('[career-bridge]', ...a); } catch {} }

// ---------- 标签同步 ----------

// newPage() creates about:blank before goto(). Keep it in tab snapshots or the
// proxy would be marked closed between creation and navigation.
const isScriptable = url => url && (/^https?:/.test(url) || url === 'about:blank');

async function currentTabs() {
  const tabs = (await chrome.tabs.query({})).map(t => ({ id: t.id,
    url: t.pendingUrl || t.url || (t.status === 'loading' ? 'about:blank' : ''), title: t.title || '' }));
  return tabs.filter(t => isScriptable(t.url));
}

let updatingTabs = false;
let tabsDirty = false;
async function sendTabsUpdate() {
  tabsDirty = true;
  if (updatingTabs) return;
  updatingTabs = true;
  try {
    while (tabsDirty && announced && ws?.readyState === WebSocket.OPEN) {
      tabsDirty = false;
      const tabs = await currentTabs();
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tabs_update', tabs }));
    }
  } catch (e) { log('tab synchronization failed', e.message); }
  finally { updatingTabs = false; }
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => { if (changeInfo.status === 'complete') sendTabsUpdate(); });
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());

// ---------- 扩展能力命令（tabs / cookies / cdp / batch）----------

async function handleCookies(msg) {
  try {
    let url = msg.url;
    if (!url && msg.tabId) url = (await chrome.tabs.get(msg.tabId)).url;
    if (!url) return { ok: false, error: 'no url' };
    const origin = url.match(/^https?:\/\/[^\/]+/)[0];
    const all = await chrome.cookies.getAll({ url });
    const part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }).catch(() => []);
    const merged = [...all];
    for (const c of part) if (!merged.some(x => x.name === c.name && x.domain === c.domain)) merged.push(c);
    return { ok: true, data: merged };
  } catch (e) { return { ok: false, error: e.message }; }
}

const NAVIGATION_TIMEOUT_MS = 18000; // Finishes before the host's 20s command deadline.
async function navigateTab(tabId, url) {
  if (!(url === 'about:blank' || /^https?:\/\//.test(url))) throw new Error('Unsupported navigation URL');
  return new Promise((resolve, reject) => {
    const finish = (error, tab) => {
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve({ ok: true, data: { id: tab.id, url: tab.url, title: tab.title } });
    };
    const updated = (id, change, tab) => { if (id === tabId && change.status === 'complete') finish(null, tab); };
    const removed = id => { if (id === tabId) finish(new Error('Navigation tab closed')); };
    // 到点放行：页面早就打开了，只是一直有资源在加载、等不到 complete（2026-11-04 中国中车）。已经跳到目标站就算导航成功
    const timer = setTimeout(() => {
      chrome.tabs.get(tabId).then(tab => {
        const arrived = (() => { try { return new URL(tab.url || tab.pendingUrl || '').origin === new URL(url).origin; } catch { return false; } })();
        finish(arrived ? null : new Error('Navigation timed out'), tab);
      }).catch(() => finish(new Error('Navigation timed out')));
    }, NAVIGATION_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(updated); chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.update(tabId, { url }).then(tab => {
      if (tab.status === 'complete' && tab.url === url) finish(null, tab);
    }).catch(error => finish(error));
  });
}

async function handleTabs(msg) {
  try {
    if (msg.method === 'create') {
      const tab = await chrome.tabs.create({ url: msg.url, active: msg.active !== undefined ? msg.active : false, index: msg.index });
      return { ok: true, data: { id: tab.id, url: tab.pendingUrl || tab.url || msg.url || 'about:blank', title: tab.title || '' } };
    }
    if (msg.method === 'navigate') return await navigateTab(msg.tabId, msg.url);
    if (msg.method === 'switch') {
      const tab = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    if (msg.method === 'close') {
      await chrome.tabs.remove(msg.tabId);
      return { ok: true };
    }
    return { ok: true, data: await currentTabs() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 持久 attach 的标签页（screencast 等需要持续事件流的场景）。attach 期间 Chrome 顶部
// 会显示"正在调试此浏览器"黄条（Chrome 的固定设计，无法隐藏）；用完必须 detach。
const attachedTabs = new Set();

// CDP 事件上行：只转发我们自己持久 attach 的标签页（chrome.debugger.onEvent 本来就
// 只对自己 attach 的 target 触发，双保险）。screencast 帧从这里回服务端。
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attachedTabs.has(source.tabId)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: 'cdp_event', tabId: source.tabId, method, params })); } catch {}
});
// 用户点了黄条上的"取消"/关掉标签页 → 告诉服务端持久会话没了
chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'cdp_detached', tabId: source.tabId, reason: source.reason || '' })); } catch {}
  }
});

async function handleCdp(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'no tabId' };
  const kept = attachedTabs.has(tabId);
  try {
    if (!kept) await chrome.debugger.attach({ tabId }, '1.3');
    let result;
    try { result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {}); }
    catch (sendErr) {
      // attachedTabs 标记还在但真实调试器已掉（infobar 被关 / Chrome 单方面 detach）：重挂一次再发，不把假活状态抛给上层
      if (!/not attached/i.test(sendErr.message || '')) throw sendErr;
      await chrome.debugger.attach({ tabId }, '1.3');
      if (kept) attachedTabs.add(tabId);
      result = await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {});
    }
    if (!kept) await chrome.debugger.detach({ tabId });
    return { ok: true, data: result };
  } catch (e) {
    if (!kept) { try { await chrome.debugger.detach({ tabId }); } catch {} }
    return { ok: false, error: e.message };
  }
}

// 持久 attach / detach：screencast 之类要持续收事件的能力用（产品内"现场画面"）。
async function handleCdpAttach(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'no tabId' };
  try {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function handleCdpDetach(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { ok: false, error: 'no tabId' };
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// batch：一次请求多命令；CDP 懒 attach 复用；$N.path 引用第 N 个结果字段（文件上传链常用）
async function handleBatch(msg) {
  const R = [];
  let attached = null;
  const resolve$N = params => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => { let v = R[+i]; for (const k of path.split('.')) v = v?.[k]; return JSON.stringify(v); }));
  try {
    for (const c of msg.commands) {
      if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
      if (c.cmd === 'cookies') R.push(await handleCookies(c));
      else if (c.cmd === 'tabs') R.push(await handleTabs(c));
      else if (c.cmd === 'cdp') {
        const tabId = c.tabId;
        const kept = attachedTabs.has(tabId); // 持久会话（screencast）复用，不 attach/detach
        if (!kept && attached !== tabId) {
          if (attached) { await chrome.debugger.detach({ tabId: attached }); attached = null; }
          await chrome.debugger.attach({ tabId }, '1.3');
          attached = tabId;
        }
        R.push(await chrome.debugger.sendCommand({ tabId }, c.method, resolve$N(c.params)));
      } else R.push({ ok: false, error: 'unknown cmd: ' + c.cmd });
    }
    if (attached) await chrome.debugger.detach({ tabId: attached });
    return { ok: true, results: R };
  } catch (e) {
    if (attached) try { await chrome.debugger.detach({ tabId: attached }); } catch {}
    return { ok: false, error: e.message, results: R };
  }
}

async function handleExtMessage(msg) {
  if (msg.cmd === 'tabs') return await handleTabs(msg);
  if (msg.cmd === 'cookies') return await handleCookies(msg);
  if (msg.cmd === 'cdp') return await handleCdp(msg);
  if (msg.cmd === 'cdp_attach') return await handleCdpAttach(msg);
  if (msg.cmd === 'cdp_detach') return await handleCdpDetach(msg);
  if (msg.cmd === 'batch') return await handleBatch(msg);
  return { ok: false, error: 'unknown cmd: ' + msg.cmd };
}

// ---------- 页内脚本执行（主世界 + CDP 兜底）----------
// 结果序列化：DOM → outerHTML；jQuery/NodeList → 数组；循环引用 → 占位

function buildPageScript(code) {
  const codeJson = JSON.stringify(code);
  return `(async () => {
    function smartProcessResult(result) {
      if (result === null || result === undefined || typeof result !== 'object') return result;
      try { if (result.window === result && result.document) return '[Window: ' + (result.location?.href || 'about:blank') + ']'; } catch(_){}
      if (typeof jQuery !== 'undefined' && result instanceof jQuery) {
        const els = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) els.push(result[i].outerHTML); } return els;
      }
      if (result instanceof NodeList || result instanceof HTMLCollection) {
        const els = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) els.push(result[i].outerHTML); } return els;
      }
      if (result.nodeType === 1) return result.outerHTML;
      try { return JSON.parse(JSON.stringify(result, function(key, value) {
        if (typeof value === 'object' && value !== null) {
          if (value.nodeType === 1) return value.outerHTML;
          if (value === window || value === document) return '[Object]';
          try { if (value.window === value && value.document) return '[Window]'; } catch(_){}
        }
        return value;
      })); } catch (e) { return '[unserializable: ' + e.message + ']'; }
    }
    try {
      const jsCode = ${codeJson}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      let r;
      if (lastLine.startsWith('return')) { r = await (new AsyncFunction(jsCode))(); }
      else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; }
        catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', message: errMsg, stack: e.stack || '' },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
    }
  })()`;
}

function buildCdpScript(code) {
  const codeJson = JSON.stringify(code);
  return `(async () => {
    try {
      const jsCode = ${codeJson}.trim();
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const r = await (new AsyncFunction(jsCode))();
      const s = (v) => { try { return JSON.parse(JSON.stringify(v, function(key, value) {
        if (typeof value === 'object' && value !== null) { if (value.nodeType === 1) return value.outerHTML; if (value === window || value === document) return '[Object]'; }
        return value; })); } catch { return String(v); } };
      return { ok: true, data: s(r) };
    } catch (e) { return { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }; }
  })()`;
}

async function handleWsExec(data) {
  const tabId = data.tabId;
  ws.send(JSON.stringify({ type: 'ack', id: data.id }));
  if (!tabId) { ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' })); return; }
  const newTabIds = new Set();
  const onCreated = tab => { newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async s => await eval(s),
        args: [buildPageScript(data.code)],
      });
      res = result[0]?.result;
      if (res === null || res === undefined) res = { ok: false, error: { name: 'Error', message: 'executeScript returned null (possible CSP or context issue)', stack: '' }, csp: true };
    } catch (e) {
      res = { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' }, csp: true };
    }
    // CSP 拦了主世界 eval → CDP Runtime.evaluate 兜底
    if (res && !res.ok && res.csp) {
      const wrappedCode = buildCdpScript(data.code);
      // 现场画面已经持久挂着这个标签页：借它的调试器，不另挂、用完也不卸（否则「已有调试器」报错，还会把现场画面拆掉）
      const kept = attachedTabs.has(tabId);
      try {
        if (!kept) await chrome.debugger.attach({ tabId }, '1.3');
        const cdpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: wrappedCode, awaitPromise: true, returnByValue: true,
        });
        if (!kept) await chrome.debugger.detach({ tabId });
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP Error';
          res = { ok: false, error: { name: 'Error', message: desc, stack: desc } };
        } else res = cdpRes.result.value;
      } catch (cdpErr) {
        if (!kept) { try { await chrome.debugger.detach({ tabId }); } catch {} }
        res = { ok: false, error: { name: 'Error', message: 'CDP fallback failed: ' + cdpErr.message, stack: '' } };
      }
    }
    if (newTabIds.size === 0) await new Promise(r => setTimeout(r, 200));
    const newTabs = [];
    for (const id of newTabIds) { try { const t = await chrome.tabs.get(id); newTabs.push({ id: t.id, url: t.url, title: t.title }); } catch {} }
    if (res?.ok) ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.data, newTabs }));
    else ws.send(JSON.stringify({ type: 'error', id: data.id, error: res?.error || 'Unknown error', newTabs }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

// ---------- WS 连接管理（MV3 休眠对抗）----------

let status = 'connecting';
function setStatus(s) {
  if (s === status) return;
  status = s;
  chrome.tabs.query({}).then(T => T.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'cb_status', data: s }).catch(() => {})));
}

// 扩展内部消息（角标查状态）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === 'status') sendResponse({ ok: true, data: ws && ws.readyState === WebSocket.OPEN ? 'connected' : status });
  return false;
});


function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => connectWS(), PROBE_MS);
  chrome.alarms.create('cb-ws-probe', { delayInMinutes: 0.5 }); // MV3 wake-up fallback
}
function scheduleKeepalive() {
  clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send('{"type":"ping"}'); scheduleKeepalive(); }
    else scheduleProbe();
  }, KEEPALIVE_MS);
  chrome.alarms.create('cb-ws-keepalive', { delayInMinutes: 0.5 });
}

async function isServerAlive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const health = new URL(wsUrl); health.protocol = 'http:';
      await fetch(health.origin, { signal: ctrl.signal });
      return true;
    } finally { clearTimeout(timer); }
  } catch { return false; }
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'cb-ws-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send('{"type":"ping"}'); } catch {} scheduleKeepalive(); }
    else { ws = null; scheduleProbe(); }
  }
  if (alarm.name === 'cb-ws-probe') {
    if (ws && ws.readyState <= 1) return;
    if (await isServerAlive()) connectWS();
    else scheduleProbe();
  }
});

function connectWS() {
  if (disconnecting || (ws && ws.readyState <= 1)) return;
  ws = null;
  try { ws = new WebSocket(wsUrl); } catch { scheduleProbe(); return; }
  ws.onopen = async () => {
    log('connected to', wsUrl);
    setStatus('connected');
    scheduleKeepalive();
    ws.send(JSON.stringify({ type: 'ext_ready', token: connectionToken ?? undefined, tabs: await currentTabs() }));
    announced = true;
    await sendTabsUpdate();
  };
  ws.onmessage = async event => {
    try {
      const data = JSON.parse(event.data);
      if (!data.id) return;
      if (typeof data.code === 'string') { await handleWsExec(data); return; }
      if (data.cmd) {
        const res = await handleExtMessage(data);
        ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
      }
    } catch (e) { log('message parse error', e); }
  };
  ws.onclose = async () => {
    log('disconnected'); clearTimeout(keepaliveTimer); ws = null; announced = false; disconnecting = true;
    // Sidecar is gone: don't leave a debugger/hidden file dialog/stream attached
    // to the user's Chrome. Reconnect only after the old attachments drain.
    const ids = [...attachedTabs]; attachedTabs.clear();
    await Promise.allSettled(ids.map(tabId => chrome.debugger.detach({ tabId })));
    disconnecting = false; setStatus('connecting'); scheduleProbe();
  };
  ws.onerror = () => { /* onclose 会跟着触发 */ };
}

chrome.runtime.onInstalled.addListener(() => {
  // 削掉响应里的 CSP 头：让自动化脚本能在任意站的主世界 eval（移植自 tmwd_cdp_bridge）
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9999],
    addRules: [{
      id: 9999, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' },
      ]},
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] },
    }],
  });
  connectWS();
});
chrome.runtime.onStartup.addListener(() => connectWS());
connectWS();
