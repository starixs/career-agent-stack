// career-bridge：document_start 在页面主世界删掉 navigator.webdriver、
// 中和 alert/confirm/prompt（弹窗会阻塞整个浏览器 JS 执行，等价自动化死锁）。
// 移植自 lsdefine/GenericAgent assets/tmwd_cdp_bridge/disable_dialogs.js（MIT）。
try { delete Navigator.prototype.webdriver; delete navigator.webdriver; } catch (e) {}
(function () {
  const _log = console.log.bind(console);
  function toast(type, msg) {
    _log('[career-bridge] ' + type + ' suppressed:', msg);
    try {
      const d = document.createElement('div');
      d.textContent = '[' + type + '] ' + msg;
      Object.assign(d.style, {
        position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
        background: '#222', color: '#fff', padding: '10px 18px', borderRadius: '8px',
        fontSize: '14px', maxWidth: '420px', wordBreak: 'break-all',
        boxShadow: '0 4px 16px rgba(0,0,0,.3)', opacity: '1',
        transition: 'opacity .5s', pointerEvents: 'none',
      });
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => { d.style.opacity = '0'; }, 3000);
      setTimeout(() => { d.remove(); }, 3600);
    } catch (e) {}
  }
  window.alert = function (msg) { toast('alert', msg); };
  window.confirm = function (msg) { toast('confirm', msg); return true; };
  window.prompt = function (msg, def) { toast('prompt', msg); return def || null; };
})();
