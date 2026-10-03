/** 文本归一与模糊比较（interpret / perception / normalize 共用，避免循环依赖）。 */

/** 归一化：小写、去空白与常见标点 / 全角符号。 */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s*＊:：（）()\[\]【】.,，。、?？!！\-_/]/g, '')
}

/** 编辑距离（短文本用）。 */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/**
 * OCR / 文案容错的"等于"：归一化后相等；或两者都是短文本（≤ 12 字）且编辑距离 ≤ max(1, 长度/4)。
 * 例："提交申谱" ≈ "提交申请"，"下-步" ≈ "下一步"；但 "提交" ≠ "提交申请"（长度差太大）。
 */
export function fuzzyEquals(a: string, b: string): boolean {
  const x = normKey(a), y = normKey(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length > 12 || y.length > 12) return false
  const tol = Math.max(1, Math.floor(Math.max(x.length, y.length) / 4))
  return Math.abs(x.length - y.length) <= tol && editDistance(x, y) <= tol
}
