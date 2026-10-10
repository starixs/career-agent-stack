/**
 * 长期记忆后台巩固（Global 侧车，不进任何对话）：
 *  1. 衰减 / 遗忘：纯函数（MemoryRepo.applyDecay），不靠模型。
 *  2. 合并：代码先挑"同 scope、同类型、文字相近"的候选组（二字组 Jaccard），模型只判断是不是同一件事并给出合并说法；
 *     结果再过代码闸（长度、私密信息、组内 id 必须是候选），旧条目标 superseded 指向新条。
 *     置顶的、用户手改过的记忆不参与合并。每次最多 5 组。
 *  节奏：每小时看一眼，距上次超过 24 小时才跑（kv `memory:consolidated_at`）。失败只记日志。
 */
import type { LLM, MemoryRow, Repos, Vault } from '@career/core';

const KV_KEY = 'memory:consolidated_at';
const MAX_GROUPS = 5;
const SIMILARITY = 0.45;
const MERGED_MAX = 120;

function bigrams(key: string): Set<string> {
  const out = new Set<string>();
  const chars = [...key];
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  if (chars.length === 1) out.add(chars[0]);
  return out;
}
export function similarity(a: string, b: string): number {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 候选组：同 scope 同 kind，两两相似度过线的连成一组（不含置顶 / 用户手改的）。 */
export function mergeCandidates(rows: MemoryRow[]): MemoryRow[][] {
  const eligible = rows.filter(r => r.status === 'active' && !r.pinned && r.source !== 'user_edit');
  const groups: MemoryRow[][] = [];
  const used = new Set<string>();
  for (const r of eligible) {
    if (used.has(r.id)) continue;
    const group = [r];
    for (const o of eligible) {
      if (o.id === r.id || used.has(o.id) || o.scope !== r.scope || o.kind !== r.kind) continue;
      if (group.some(g => similarity(g.content_key, o.content_key) >= SIMILARITY)) group.push(o);
    }
    if (group.length > 1) { for (const g of group) used.add(g.id); groups.push(group); }
  }
  return groups.slice(0, MAX_GROUPS);
}

export interface ConsolidateDeps { repos: Repos; vault: Pick<Vault, 'redact'> | null; llm: LLM | null; systemPrompt: () => Promise<string>; extractJson: <T>(text: string) => T; now?: () => Date; log?: (msg: string) => void }
export interface ConsolidateResult { decayed: number; forgotten: number; merged: number; groups: number; skipped?: string }

export async function consolidateMemories(deps: ConsolidateDeps, opts: { force?: boolean } = {}): Promise<ConsolidateResult> {
  const at = deps.now?.() ?? new Date();
  const last = deps.repos.kvGet<string>(KV_KEY);
  if (!opts.force && last && at.getTime() - Date.parse(last) < 24 * 3_600_000) return { decayed: 0, forgotten: 0, merged: 0, groups: 0, skipped: 'recent' };
  const decay = deps.repos.memories.applyDecay(at);
  const groups = mergeCandidates(deps.repos.memories.list({ limit: 1000 }));
  let merged = 0;
  if (groups.length && deps.llm) {
    const byId = new Map(groups.flat().map(r => [r.id, r]));
    const user = groups.map((g, i) => `第 ${i + 1} 组（scope=${g[0].scope}，类型=${g[0].kind}）：\n${g.map(r => `${r.id} | ${r.content} | 重要度 ${r.importance} | 证据 ${r.evidence_count} | 更新 ${r.updated_at}`).join('\n')}`).join('\n\n');
    try {
      const res = await deps.llm.complete({ system: await deps.systemPrompt(), messages: [{ role: 'user', content: user }], json: true, temperature: 0.1 });
      const out = deps.extractJson<{ groups?: Array<{ ids?: string[]; action?: string; content?: string }> }>(res.text);
      for (const g of out.groups ?? []) {
        if (g.action !== 'merge' || !g.content) continue;
        const members = (g.ids ?? []).map(id => byId.get(id)).filter((r): r is MemoryRow => !!r);
        // 组内成员必须同 scope 同 kind，且都还是有效记忆
        if (members.length < 2 || new Set(members.map(m => `${m.scope}|${m.kind}`)).size !== 1) continue;
        if (members.some(m => deps.repos.memories.get(m.id)?.status !== 'active')) continue;
        const content = (deps.vault ? deps.vault.redact(g.content) : g.content).trim();
        if (!content || content.length > MERGED_MAX || /\{\{\s*vault:/.test(content)) continue;
        deps.repos.memories.supersede(members.map(m => m.id), {
          kind: members[0].kind, scope: members[0].scope, content, source: 'consolidation',
          importance: Math.max(...members.map(m => m.importance)),
        });
        merged++;
      }
    } catch (error) {
      deps.log?.(`合并失败（下次再试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  deps.repos.kvSet(KV_KEY, at.toISOString());
  return { ...decay, merged, groups: groups.length };
}

// ---------- Global 定时 ----------
let timer: ReturnType<typeof setInterval> | null = null;
export function startMemoryConsolidation(intervalMs = 3_600_000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const [{ getRepos }, { getVault }, { getShellLLM }, { loadSkillPrompt }, { loadCore }] = await Promise.all([
        import('./db'), import('./vault'), import('./llm'), import('./skills'), import('./core-module'),
      ]);
      const core = await loadCore();
      const r = await consolidateMemories({
        repos: await getRepos(), vault: await getVault().catch(() => null), llm: getShellLLM(),
        systemPrompt: () => loadSkillPrompt('memory-consolidate'), extractJson: text => core.extractJson(text),
        log: msg => console.warn(`[career-memory] ${msg}`),
      });
      if (!r.skipped && (r.decayed || r.forgotten || r.merged)) console.log(`[career-memory] 巩固：降级 ${r.decayed}、遗忘 ${r.forgotten}、合并 ${r.merged}/${r.groups} 组`);
    } catch (error) {
      console.warn('[career-memory] 巩固失败（下次再试）：', error instanceof Error ? error.message : error);
    }
  };
  setTimeout(() => void tick(), 60_000).unref?.();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}
