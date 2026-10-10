/**
 * 求职长期记忆的会话侧编排（取代基座的工作区记忆，见 shared/careerMemoryPolicy.ts）：
 *
 *  - 读：每轮开始（SDK UserPromptSubmit hook）按本轮涉及的对象选最强 8 条，作为 additionalContext 只给模型看；
 *    不改用户消息、不叠第二个 system-reminder 信封。
 *  - 写：模型显式调 memory_remember / memory_forget；每轮结束（Stop hook）把"用户原话 + 最终回答"排进后台队列，
 *    用 memory-extract 技能提 ≤3 条候选，代码把关后写入。全程不进对话、不阻塞回答，失败只记日志。
 *  - 把关（applyRemember）：私密信息先 redact，含占位符的不收；求职条件 / 经历 / 个人信息转走不记；
 *    公司 scope 的公司名必须在本轮出现过；supersedes 只能指向同 scope 的有效记忆。
 */
import type { LLM, MemoryKind, MemoryRow, Repos, Vault } from '@career/core';

import { CAREER_CONTEXT_TAG, parseLeadingSystemReminder } from '../../shared/systemReminder';

const HUMAN_REMINDER_KINDS = new Set([CAREER_CONTEXT_TAG, 'FLOATING_BALL_CONTEXT', 'GOAL_CONTEXT']);
const KIND_LABEL: Record<MemoryKind, string> = { collaboration: '协作', preference: '偏好', fact: '事实', insight: '自我认识' };
const VALID_KINDS = new Set<MemoryKind>(['collaboration', 'preference', 'fact', 'insight']);
const PLACEHOLDER_RX = /\{\{\s*vault:/;
const MAX_EXTRACTED = 3;

export interface TurnInput { visible: string; human: boolean; refs: Record<string, string> }

/** 拆开本轮用户消息：可见文字、是否真人输入、面板带来的对象 id。 */
export function parseTurn(prompt: string): TurnInput {
  const parsed = parseLeadingSystemReminder(prompt);
  const visible = (parsed.hasReminder ? parsed.visibleText : prompt).trim();
  const human = !!visible && (!parsed.hasReminder || HUMAN_REMINDER_KINDS.has(parsed.kind ?? ''));
  const refs: Record<string, string> = {};
  if (parsed.hasReminder && parsed.kind === CAREER_CONTEXT_TAG) {
    for (const m of parsed.body.matchAll(/<ref name="([^"]+)">([^<]*)<\/ref>/g)) refs[m[1]] = m[2].trim();
  }
  return { visible, human, refs };
}

/** 本轮涉及的 scope：面板带来的投递 / 岗位 → 投递与公司；消息里出现的已知公司名。 */
export function turnScopes(repos: Repos, turn: TurnInput, extraText = ''): string[] {
  const scopes = new Set<string>();
  const companyOfJob = (jobId: string) => repos.getJob(jobId)?.company_name;
  for (const [k, v] of Object.entries(turn.refs)) {
    if (!v) continue;
    if (/application/.test(k)) {
      scopes.add(`application:${v}`);
      const app = repos.db.get<{ job_id: string }>('SELECT job_id FROM application WHERE id=?', [v]);
      const c = app ? companyOfJob(app.job_id) : undefined; if (c) scopes.add(`company:${c}`);
    } else if (/job/.test(k)) {
      const c = companyOfJob(v); if (c) scopes.add(`company:${c}`);
    } else if (/company/.test(k)) scopes.add(`company:${v}`);
  }
  const text = `${turn.visible}\n${extraText}`;
  for (const c of knownCompanies(repos)) if (c.length >= 2 && text.includes(c)) scopes.add(`company:${c}`);
  return [...scopes];
}

function knownCompanies(repos: Repos): string[] {
  const rows = repos.db.all<{ name: string }>("SELECT DISTINCT company_name AS name FROM job WHERE company_name IS NOT NULL AND company_name<>''");
  const fromMemory = repos.db.all<{ scope: string }>("SELECT DISTINCT scope FROM memory WHERE status='active' AND scope LIKE 'company:%'");
  return [...new Set([...rows.map(r => r.name), ...fromMemory.map(r => r.scope.slice('company:'.length))])];
}

/** 每轮注入的记忆块；没有记忆时返回 undefined。 */
export function buildMemoryContext(repos: Repos, prompt: string): string | undefined {
  const turn = parseTurn(prompt);
  if (!turn.human) return undefined;
  const picked = repos.memories.forContext({ scopes: turnScopes(repos, turn), q: turn.visible, limit: 8 });
  if (!picked.length) return undefined;
  const lines = picked.map(m => `- [${KIND_LABEL[m.kind] ?? m.kind}${m.scope === 'user' ? '' : ` · ${m.scope}`}] ${m.content}（${m.id}）`);
  return [
    '<career-memory>',
    '你之前记下的关于这位用户的记忆（只是上下文，可能过时；和用户现在的说法冲突时以用户为准，涉及事实时用工具核实）。',
    '照着协作习惯做事，但不要逐条复述这些记忆，也不要提"记忆系统"。用户说"记住 / 别记 / 改一下"时用 memory_remember / memory_forget。',
    ...lines,
    '</career-memory>',
  ].join('\n');
}

export interface RememberRequest { kind: string; content: string; scope?: string | null; importance?: number; supersedes?: string[] | null; source: 'explicit' | 'extracted'; source_ref?: string | null }
export type RememberOutcome = { ok: true; action: 'created' | 'reinforced' | 'superseded'; memory: MemoryRow } | { ok: false; reason: string };

/** 写入把关（工具与自动提炼共用）。companies：允许的公司名（自动提炼时 = 本轮出现过的）。 */
export function applyRemember(repos: Repos, vault: Pick<Vault, 'redact'> | null, req: RememberRequest, opts: { companies?: string[] } = {}): RememberOutcome {
  const kind = req.kind as MemoryKind;
  if (!VALID_KINDS.has(kind)) return { ok: false, reason: `未知的记忆类型：${req.kind}` };
  const raw = (req.content ?? '').trim();
  if (!raw) return { ok: false, reason: '内容为空' };
  const content = vault ? vault.redact(raw) : raw;
  if (PLACEHOLDER_RX.test(content)) return { ok: false, reason: '含私密信息（姓名 / 手机 / 邮箱等），这类内容只存私密信息库，不记成记忆' };
  let scope = (req.scope ?? 'user').trim() || 'user';
  if (scope.startsWith('company:') && opts.companies) {
    const name = scope.slice('company:'.length).trim();
    if (!opts.companies.some(c => c === name || c.includes(name) || name.includes(c))) scope = 'user';
  }
  const input = { kind, scope, content, importance: req.importance, source: req.source, source_ref: req.source_ref ?? null };
  const olds = (req.supersedes ?? []).map(id => repos.memories.get(id)).filter((m): m is MemoryRow => !!m && m.status === 'active');
  if (olds.length) {
    const memory = repos.memories.supersede(olds.map(m => m.id), { ...input, scope: olds[0].scope });
    return { ok: true, action: 'superseded', memory };
  }
  const r = repos.memories.remember(input);
  return { ok: true, action: r.action, memory: r.memory };
}

export interface ExtractDeps { repos: Repos; vault: Pick<Vault, 'redact'> | null; llm: LLM; systemPrompt: () => Promise<string>; extractJson: <T>(text: string) => T; log?: (msg: string) => void }
export interface ExtractResult { written: RememberOutcome[]; forgotten: string[]; routed: number; dropped: number }

interface Candidate { kind?: string; scope?: string; content?: string; importance?: number; supersedes?: string | string[] | null; route?: string | null }

/** 一轮的提炼：模型提候选，代码把关后写入。 */
export async function extractMemories(deps: ExtractDeps, turn: { userText: string; assistantText: string; sourceRef?: string }): Promise<ExtractResult> {
  const result: ExtractResult = { written: [], forgotten: [], routed: 0, dropped: 0 };
  const userText = turn.userText.trim();
  if (userText.length < 2) return result;
  const { repos } = deps;
  const parsedTurn: TurnInput = { visible: userText, human: true, refs: {} };
  const companies = turnScopes(repos, parsedTurn, turn.assistantText).filter(s => s.startsWith('company:')).map(s => s.slice('company:'.length));
  const existing = repos.memories.forContext({ scopes: companies.map(c => `company:${c}`), q: userText, limit: 12 });
  const redact = (s: string) => (deps.vault ? deps.vault.redact(s) : s);
  const user = [
    `本轮用户原话：\n${redact(userText).slice(0, 4000)}`,
    `本轮助理最终回答：\n${redact(turn.assistantText).slice(0, 4000)}`,
    `已有的相关记忆：\n${existing.length ? existing.map(m => `${m.id} [${m.kind} · ${m.scope}] ${m.content}`).join('\n') : '（无）'}`,
  ].join('\n\n');
  const res = await deps.llm.complete({ system: await deps.systemPrompt(), messages: [{ role: 'user', content: user }], json: true, temperature: 0.1 });
  const out = deps.extractJson<{ memories?: Candidate[]; forget?: string[] }>(res.text);
  const known = new Set(existing.map(m => m.id));
  for (const id of out.forget ?? []) if (known.has(id) && repos.memories.forget(id)) result.forgotten.push(id);
  for (const c of out.memories ?? []) {
    if (c.route) { result.routed++; continue; }
    // 每轮最多写 MAX_EXTRACTED 条：所有候选都过把关，写满后其余算丢弃
    if (result.written.length >= MAX_EXTRACTED) { result.dropped++; continue; }
    const supersedes = (Array.isArray(c.supersedes) ? c.supersedes : c.supersedes ? [c.supersedes] : []).filter(id => known.has(id));
    const outcome = applyRemember(repos, deps.vault, {
      kind: c.kind ?? '', content: (c.content ?? '').slice(0, 160), scope: c.scope, importance: Math.min(c.importance ?? 2, 4),
      supersedes, source: 'extracted', source_ref: turn.sourceRef ?? null,
    }, { companies });
    if (outcome.ok) result.written.push(outcome); else { result.dropped++; deps.log?.(`丢弃候选：${outcome.reason}`); }
  }
  return result;
}

// ---------- 会话侧：hook 之间传递本轮用户原话 + 串行提炼队列 ----------
const pendingTurns = new Map<string, { visible: string; promptId?: string }>();
let chain: Promise<unknown> = Promise.resolve();

/** UserPromptSubmit：记下本轮真人原话（供 Stop 时提炼），返回要注入的记忆块。 */
export async function onUserPrompt(input: { session_id: string; prompt: string; prompt_id?: string; agent_id?: string }, getRepos: () => Promise<Repos>): Promise<string | undefined> {
  if (input.agent_id) return undefined;
  const turn = parseTurn(input.prompt);
  if (!turn.human) { pendingTurns.delete(input.session_id); return undefined; }
  pendingTurns.set(input.session_id, { visible: turn.visible, promptId: input.prompt_id });
  return buildMemoryContext(await getRepos(), input.prompt);
}

/** Stop：把本轮排进后台提炼队列（不阻塞）。 */
export function onTurnStop(input: { session_id: string; last_assistant_message?: string; stop_hook_active?: boolean; agent_id?: string }, run: (turn: { userText: string; assistantText: string; sourceRef?: string }) => Promise<unknown>): void {
  if (input.agent_id || input.stop_hook_active) return;
  const pending = pendingTurns.get(input.session_id);
  pendingTurns.delete(input.session_id);
  if (!pending || !input.last_assistant_message) return;
  const turn = { userText: pending.visible, assistantText: input.last_assistant_message, sourceRef: pending.promptId ? `prompt:${pending.promptId}` : undefined };
  chain = chain.then(() => run(turn)).catch(error => console.warn('[career-memory] 提炼失败（不影响对话）：', error instanceof Error ? error.message : error));
}

/** 仅测试用：等队列跑完。 */
export function memoryQueueIdle(): Promise<unknown> { return chain; }
