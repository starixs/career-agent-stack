/**
 * 把助理的一段 Markdown 拆成几个短对话块（主线体验：小芽一段一段地说，不一口气打一大块）。
 *
 * 只在代码块之外的空行处切；列表、表格、引用的续行并回上一块，标题和它后面那段合成一块，
 * 这样拆出来的每块都能单独渲染成合法的 Markdown。
 */

const FENCE = /^\s*(```|~~~)/;
const CONTINUATION = /^\s*([-*+]\s|\d+[.)]\s|\||>)/;
const HEADING = /^\s*#{1,6}\s/;

function splitOnBlankLines(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length) parts.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

export function splitSpeechSegments(text: string): string[] {
  const segments: string[] = [];
  for (const part of splitOnBlankLines(text)) {
    const prev = segments[segments.length - 1];
    const joinsPrev = prev !== undefined
      && ((CONTINUATION.test(part) && CONTINUATION.test(prev.split('\n').pop() ?? ''))
        || HEADING.test(prev.split('\n').pop() ?? ''));
    if (joinsPrev) segments[segments.length - 1] = `${prev}\n\n${part}`;
    else segments.push(part);
  }
  return segments;
}
