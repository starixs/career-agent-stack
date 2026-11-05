// 模型在环的浏览冒烟（浏览器面切面，2026-10-30）：产品内置模型 + 真实 Chrome + 真实网站，多步把事办完。
// 运行：cd app/shell && node --import tsx/esm scripts/career-browse-agent-smoke.mjs [--headed] [--only=url,search,company,login,article,pdf,captcha] [--max-steps=14]
// --headed 时遇到扫码登录，脚本会真的等你在弹出的 Chrome 里扫（最多 2 分钟），扫完模型接着办。
// 模型与搜索 Key 和产品一致：只认 CAREER_LLM_API_KEY / CAREER_SEARCH_API_KEY 环境变量（脚本不打印任何 Key），没有搜索 Key 时 web_search 返回「暂时不可用」。
// 外网、真实模型：不进默认测试。结果写到 $OUT_DIR（缺省系统临时目录）下的 browse-agent-<时间>.json，人看结论。
//
// 模型协议：每轮只输出一个 JSON 工具调用 {"tool","args","reason"}，用 finish{answer} 交卷、handoff{what} 交给用户。
// 系统提示 = assistant-core 技能 + 产品系统提示的 <career-tools> 段 + 产品工具原文描述（与 evals 的 chat_first_step 同源）。
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browse = await import('../src/server/career/browse.ts');
const { formatBrowse, formatWaitUser, formatSolveCaptcha } = await import('../src/server/career/browse-format.ts');
const { fetchPage } = await import('../src/server/career/web-fetch.ts');
const { waitForUser, hintSampleInPage } = await import('../src/server/career/browse-handoff.ts');
const solver = await import('../src/server/career/captcha-solver.ts');
const { overlayMarks } = await import('../src/server/career/captcha-overlay.ts');
const { getShellLLM } = await import('../src/server/career/llm.ts');
const { getSearchProvider } = await import('../src/server/career/search.ts');
const { isSubmitText, classifyCaptcha } = await import('@career/apply');
const { extractJson, loadSkill, skillPrompt } = await import('@career/core');
const { careerToolsBlock, toolCatalog } = await import('../../evals/provider.mjs');

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const MAX_STEPS = Number(arg('max-steps') ?? 14);
/** 一次观察 / 读取给模型的字数上限，和产品 browser_observe 缺省一致。 */
const OBS_TEXT_MAX = 1500;

const TASKS = {
  url: 'https://jobs.bytedance.com/campus/position 帮我看看这里有没有北京的大模型相关校招岗位，挑 3 个给我，说清楚岗位名和要求。',
  search: '帮我搜一下拼多多 2027 秋招笔试大概什么时候，给我出处。',
  company: '帮我看看米哈游这家公司怎么样：现在校招在招什么方向、公司基本情况、大家怎么评价。',
  login: '登上牛客帮我看看校招中心里现在推荐给我的岗位有哪些。',
  article: 'https://www.nowcoder.com/discuss 这个讨论区最近大家在聊哪些公司的笔试？挑三条说说。',
  pdf: 'https://arxiv.org/pdf/1706.03762 这个 PDF 主要讲了什么？三句话。',
  // 搜狗网页搜索在自动化 Chrome 里会出点选验证码（2026-10-30 有头实测）：看模型能不能自己过
  captcha: `https://www.sogou.com/web?query=${encodeURIComponent('拼多多 2027 秋招 笔试时间')} 用这个搜索结果帮我看看拼多多笔试大概什么时候。`,
};
/** 等用户扫码的上限：脚本里人就坐在旁边，2 分钟够了。 */
const WAIT_USER_SMOKE_MS = 120_000;

const TOOLS = ['web_search', 'web_fetch', 'browser_open', 'browser_observe', 'browser_act', 'browser_read', 'browser_solve_captcha', 'browser_wait_user'];
const system = [
  skillPrompt(loadSkill(new URL('../../skills', import.meta.url).pathname, 'assistant-core')),
  careerToolsBlock(),
  `# 可用工具（产品原文描述）\n${toolCatalog(TOOLS)}\n- finish{answer}：事情办完，给用户的最终回答（带出处链接）；办不成也用它照实说卡在哪。`,
  '每轮只输出一个工具调用 JSON：{"tool":"...","args":{...},"reason":"一句话"}。',
].join('\n\n');

const llm = getShellLLM();
const search = await getSearchProvider().catch(e => { console.warn(`[agent-smoke] 搜索不可用：${String(e).slice(0, 120)}`); return null; });
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed'), args: ['--disable-blink-features=AutomationControlled'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'zh-CN' });
const deps = { isSubmitText, hasPlaceholder: t => /\{\{\s*vault:/.test(t), resolveVault: t => t };

async function runTool(state, call) {
  const a = call.args ?? {};
  switch (call.tool) {
    case 'web_search': {
      if (!search) return '搜索不可用：没有配置搜索服务。要查资料可以用 browser_open 打开网页。';
      const hits = await search.search(String(a.query ?? ''), { count: 8 });
      return hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n') || '没有结果';
    }
    case 'browser_open': case 'browser_act': {
      const req = call.tool === 'browser_open' ? { action: 'navigate', url: a.url } : a;
      const receipt = await browse.act(context, state.page, req, deps);
      state.page = receipt.page;
      const { page: _p, ...rest } = receipt;
      const observation = receipt.ok ? await browse.observe(context, state.page, deps, { textMax: OBS_TEXT_MAX }) : null;
      return formatBrowse({ receipt: rest, ...(observation ? { observation } : {}) });
    }
    case 'web_fetch':
      return JSON.stringify(await fetchPage(String(a.url ?? '')));
    case 'browser_solve_captcha': {
      const blocked = async () => { const h = browse.detectHints(await browse.inPage(state.page, hintSampleInPage, null), []); return h.includes('captcha') || h.includes('risk'); };
      const kind = classifyCaptcha({ title: await state.page.title(), text: (await browse.inPage(state.page, hintSampleInPage, null)).bodySample });
      const solvable = ['image_text', 'image_click', 'slider'].includes(kind);
      const r = solvable ? await solver.solveCaptcha(state.page, kind, { llm, overlay: overlayMarks }, blocked) : { status: 'needs_user', attempts: 0, steps: [`${kind} 要本人处理`] };
      state.captcha.push({ kind, ...r });
      const observation = await browse.observe(context, state.page, deps, { textMax: OBS_TEXT_MAX });
      return formatSolveCaptcha({ captcha: { kind, ...r, status: r.status === 'solved' ? 'solved' : 'needs_user' }, observation });
    }
    case 'browser_wait_user': {
      console.log(`  ⏳ 请你帮一下：${a.what}`);
      const blocking = a.waiting_for === 'captcha' ? ['captcha', 'risk'] : a.waiting_for === 'other' ? [] : ['login'];
      const wait = await waitForUser(state.page, { blocking, timeoutMs: process.argv.includes('--headed') ? WAIT_USER_SMOKE_MS : 3000 });
      state.waits.push({ what: a.what, ...wait });
      return formatWaitUser({ wait, observation: await browse.observe(context, state.page, deps, { textMax: OBS_TEXT_MAX }) });
    }
    case 'browser_observe':
      return formatBrowse({ observation: await browse.observe(context, state.page, deps, { textMax: a.full_text ? 6000 : OBS_TEXT_MAX }) });
    case 'browser_read':
      return JSON.stringify(await browse.read(state.page, Number(a.offset ?? 0)));
    default:
      return `没有这个工具：${call.tool}`;
  }
}

async function runTask(name, message) {
  const state = { page: await context.newPage(), captcha: [], waits: [] };
  const messages = [{ role: 'user', content: message }];
  const steps = [];
  let outcome = { kind: 'out_of_steps' };
  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await llm.complete({ system, messages, json: true, temperature: 0 });
    const call = extractJson(res.text) ?? {};
    console.log(`  [${name} ${i + 1}] ${call.tool} ${JSON.stringify(call.args ?? {}).slice(0, 100)} — ${String(call.reason ?? '').slice(0, 60)}`);
    if (call.tool === 'finish') { outcome = { kind: 'finish', text: call.args?.answer ?? '' }; steps.push({ call }); break; }
    const t0 = Date.now();
    const result = await runTool(state, call).catch(e => `工具出错：${String(e).slice(0, 300)}`);
    steps.push({ call, ms: Date.now() - t0, url: state.page.url(), result: result.slice(0, 1200) });
    messages.push({ role: 'assistant', content: JSON.stringify(call) }, { role: 'user', content: `工具结果：\n${result}` });
  }
  await state.page.close().catch(e => console.warn(`[agent-smoke] close page failed: ${e}`));
  const tools = steps.map(s => s.call.tool);
  return { name, message, outcome, steps, used: { fetch: tools.filter(t => t === 'web_fetch').length, browser: tools.filter(t => t?.startsWith('browser_')).length, search: tools.filter(t => t === 'web_search').length }, captcha: state.captcha, waits: state.waits };
}

const only = arg('only')?.split(',');
const report = [];
try {
  for (const [name, message] of Object.entries(TASKS)) {
    if (only && !only.includes(name)) continue;
    console.log(`\n== ${name}：${message}`);
    const r = await runTask(name, message);
    report.push(r);
    console.log(`  → ${r.outcome.kind}（${r.steps.length} 步；直取 ${r.used.fetch} · 浏览器 ${r.used.browser} · 搜索 ${r.used.search}；验证码 ${r.captcha.map(c => `${c.kind}:${c.status}`).join(',') || '无'}；等人 ${r.waits.map(w => w.status).join(',') || '无'}）\n${String(r.outcome.text ?? '').slice(0, 800)}`);
  }
} finally {
  await browser.close();
}
const outDir = process.env.OUT_DIR ?? tmpdir();
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `browse-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`\n结果：${file}`);
