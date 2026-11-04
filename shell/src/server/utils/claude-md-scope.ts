/**
 * 产品自己的工作区（~/.keystone 下，例如求职助理的 projects/career）不该读到上级目录的 CLAUDE.md。
 * SDK 找项目说明时一路往上翻父目录，翻到 HOME 就撞见用户给开发工具写的 ~/.claude/CLAUDE.md，
 * 当成「项目说明」塞进助理上下文（2026-11-04：每次自动压缩后都带上 3 万多字符的开发规则）。
 * 用户自己的项目目录不受影响：那里往上读到 monorepo 的 CLAUDE.md 是正常用法。
 */
import { homedir } from 'os';
import { dirname, join, resolve, sep } from 'path';

/** 工作区在 ~/.keystone 里时，返回它所有上级目录的说明文件（给 SDK 的 claudeMdExcludes）；否则空。 */
export function ancestorClaudeMdExcludes(workspace: string, home: string = homedir()): string[] {
  if (!workspace) return [];
  const productRoot = resolve(home, '.keystone');
  const ws = resolve(workspace);
  if (ws !== productRoot && !ws.startsWith(productRoot + sep)) return [];
  const excludes: string[] = [];
  for (let dir = dirname(ws); ; dir = dirname(dir)) {
    excludes.push(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'), join(dir, '.claude', 'CLAUDE.md'), join(dir, '.claude', 'rules', '**'));
    if (dirname(dir) === dir) break;
  }
  return excludes;
}
