import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 窗口不在前台时 WebKit 暂停 CSS 动画；speech-in 的起始帧若是 opacity:0，整段字会一直看不见。
const styles = readFileSync(resolve(import.meta.dirname, 'index.css'), 'utf8');

function keyframesBody(name: string): string {
  const start = styles.indexOf(`@keyframes ${name}`);
  if (start < 0) throw new Error(`missing @keyframes ${name}`);
  let depth = 0;
  for (let i = styles.indexOf('{', start); i < styles.length; i += 1) {
    if (styles[i] === '{') depth += 1;
    if (styles[i] === '}') depth -= 1;
    if (depth === 0) return styles.slice(start, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

describe('speech-block motion', () => {
  it('never starts from an invisible frame', () => {
    const body = keyframesBody('speech-in');
    expect(body).not.toMatch(/opacity\s*:\s*0(?![.\d])/);
    expect(body).toContain('transform');
  });

  it('keeps reduced-motion turning the animation off', () => {
    expect(styles).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.speech-block, \.speech-dot \{ animation: none; \}/);
  });
});
