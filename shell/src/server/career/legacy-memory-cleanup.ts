/**
 * 撤掉基座工作区记忆留下的自动加载规则（.claude/rules/02-SOUL / 03-USER / 04-MEMORY）。
 *
 * 这三份是记忆演化开着时由 Rust 按默认模板创建的，每轮都会被 SDK 当项目规则加载：SOUL 是通用英文人设，
 * 会把模型往"翻文件、写记忆文件"上引，而求职产品禁用了这些工具。
 * 只删和默认模板逐字节相同的（按 sha256 比对）；用户改过的一律保留。
 */
import { createHash } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';

/** src/shared/default-{soul,user,memory}.md 的 sha256。 */
export const LEGACY_RULE_TEMPLATES: Record<string, string> = {
  '02-SOUL.md': '8008bb96b04f10bcb876f36956c1aad0bf7778b1cacccd2851af1c2e93e3392c',
  '03-USER.md': '1e00dffa1a972a07c68e1feee9fa29d79b81aff99ed8f00a745364339c4db853',
  '04-MEMORY.md': '7c8359101488edda5cbae104e6480991d9e17650a67f1515795e5e6ace41b2ba',
};

export async function removePristineLegacyMemoryRules(workspace: string): Promise<string[]> {
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(LEGACY_RULE_TEMPLATES)) {
    const path = join(workspace, '.claude', 'rules', name);
    let content: Buffer;
    try { content = await readFile(path); } catch { continue; }
    if (createHash('sha256').update(content).digest('hex') !== hash) continue;
    try { await unlink(path); removed.push(name); } catch { /* 下次启动再试 */ }
  }
  return removed;
}
