/**
 * 话术护栏（真北第 9 条 + 10-30 全新实例复盘）：工具返回给模型的话、技能提示词里，不能出现让用户打字 / 粘贴、
 * 或拿缺口挡路的说法——模型会照搬给用户。assistant-core 里以「不说「…」」的形式列出这些话，是禁令本身，不算。
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const BANNED = /发给我|粘给我|粘贴给我|复制.{0,4}给我|请把 ?JD|先别急|投了也是白投|这份还不能投|回卡片改|改卡片再/;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const SKILLS = join(ROOT, 'skills');

/** 去掉「不说 / 不以 / 不给 / 绝不」后面引号里的禁令原文。 */
const stripProhibitions = (text: string) => text.replace(/(不说|不以|不给|绝不|不让他?)[^。\n]*/g, '');

function hits(file: string, text: string): string[] {
  return stripProhibitions(text).split('\n').filter(l => BANNED.test(l)).map(l => `${file}: ${l.trim().slice(0, 80)}`);
}

describe('话术护栏：不让用户打字、不拿缺口挡路', () => {
  it('技能提示词里没有', () => {
    const files = readdirSync(SKILLS).map(name => join(SKILLS, name, 'SKILL.md')).filter(existsSync);
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap(f => hits(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('career 工具和领域代码返回给模型的话里没有', () => {
    const dirs = [HERE, join(HERE, '..', 'career')];
    // suggest-lint.ts 里的 SEND_ME 正则是拦这类话的 lint，本身就是禁令，不算
    const isGuard = (f: string) => f === 'suggest-lint.ts';
    const found = dirs.flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.ts') && !f.includes('.test.') && !isGuard(f)).flatMap(f => hits(f, readFileSync(join(dir, f), 'utf8'))));
    expect(found).toEqual([]);
  });
});
