/**
 * 登录准备阶段的慢调用埋点：真实 Chrome 桥接下一家要折腾 3 分钟才判出「要滑块 / 只能扫码」（2026-11-05），
 * 包一层把超过阈值的页面调用记进日志，看时间花在哪一步。只记，不改行为。
 */
export const SLOW_CALL_MS = 2000;

export function logSlowCalls<T extends object>(target: T, label: string, thresholdMs = SLOW_CALL_MS, log: (line: string) => void = line => console.log(line)): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const started = Date.now();
        const out = (value as (...a: unknown[]) => unknown).apply(obj, args);
        if (!(out instanceof Promise)) return out;
        const note = () => {
          const ms = Date.now() - started;
          if (ms >= thresholdMs) {
            const arg = typeof args[0] === 'string' ? ` ${args[0].slice(0, 60)}` : '';
            log(`[career] slow-call ${label} ${String(prop)}${arg} ${ms}ms`);
          }
        };
        return out.then(v => { note(); return v; }, (e: unknown) => { note(); throw e; });
      };
    },
  });
}
