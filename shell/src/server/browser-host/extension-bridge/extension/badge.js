// career-bridge：右下角连接状态角标（低调、pointer-events:none）。
;(function () {
  if (window.self !== window.top) return;
  const d = document.createElement('div');
  d.textContent = 'career-bridge: 已连接';
  d.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#4CAF50;color:white;padding:4px 7px;border-radius:4px;font-size:11px;font-weight:bold;z-index:99999;box-shadow:0 2px 4px rgba(0,0,0,0.2);opacity:0.2;pointer-events:none;';
  const S = { connected: ['已连接', '#4CAF50'], connecting: ['重连中', '#FF9800'], disconnected: ['未连接', '#F44336'] };
  const R = s => { const [t, c] = S[s] || S.disconnected; d.textContent = 'career-bridge: ' + t; d.style.background = c; };
  chrome.runtime.sendMessage({ cmd: 'status' }, r => R(r?.ok ? r.data : 'disconnected'));
  chrome.runtime.onMessage.addListener(m => { if (m?.type === 'cb_status') R(m.data); });
  (document.body || document.documentElement).appendChild(d);
})();
