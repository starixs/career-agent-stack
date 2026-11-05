/** 操作后的结果核验：一旦页面通过就立即继续，不为固定 sleep 等满。 */
export async function waitForVerification(
  check: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 1600,
  pollMs = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}
