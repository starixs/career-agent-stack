/**
 * 感知器熔断：OCR 这类外部小程序一旦坏掉（崩溃、超时），每页都会白等到超时，填表卡死在坏构件上。
 * 连续失败 N 次就熔断：之后立刻失败（组合感知器会吞掉这一层，退回 DOM 盒子；识别不了就自然交给用户接管），
 * 冷却期过后放行一次试探，成功即恢复。熔断状态按名字在进程内共享（批量、对话里的填表共用一份）。
 */
export interface BreakerOptions { failuresToTrip?: number; cooldownMs?: number; now?: () => number; log?: (msg: string) => void }
interface BreakerState { failures: number; trippedAt: number | null }

const states = new Map<string, BreakerState>();

export function breakerState(name: string): { failures: number; tripped: boolean } {
  const s = states.get(name);
  return { failures: s?.failures ?? 0, tripped: s?.trippedAt != null };
}

export function resetBreakers(): void { states.clear(); }

export function withBreaker<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, opts: BreakerOptions = {}): (...args: A) => Promise<R> {
  const trip = opts.failuresToTrip ?? 2;
  const cooldown = opts.cooldownMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;
  return async (...args: A) => {
    const s = states.get(name) ?? { failures: 0, trippedAt: null };
    states.set(name, s);
    if (s.trippedAt != null && now() - s.trippedAt < cooldown) throw new Error(`${name} 已熔断（连续出错 ${s.failures} 次），先跳过`);
    try {
      const out = await fn(...args);
      if (s.trippedAt != null) opts.log?.(`${name} 试探成功，恢复使用`);
      s.failures = 0; s.trippedAt = null;
      return out;
    } catch (error) {
      s.failures++;
      if (s.failures >= trip) {
        if (s.trippedAt == null) opts.log?.(`${name} 连续出错 ${s.failures} 次，熔断 ${Math.round(cooldown / 60_000)} 分钟：${error instanceof Error ? error.message : String(error)}`);
        s.trippedAt = now();
      }
      throw error;
    }
  };
}
