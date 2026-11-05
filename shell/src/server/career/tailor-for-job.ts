/**
 * 按岗位定制简历的管线（一份）：解析 JD → resume-tailor 技能 → 改动只留简历 schema 里的位置 → 防编造闸门（只用已确认主张）
 * → 写出定制版并确认（10-18 定：定制不用用户审）。
 *
 * 两个调用方：对话里的 resume_tailor 工具（之后出一张「改了什么」卡）；批量投（运行器开跑前 packet-prepare，不出卡——每份一张会刷屏）。
 * 批量这边用 tailorJobs：每份有超时，定制不成就退回主简历并留日志，绝不打断这一批。
 */
import type { JdParsed, Job, Repos, ResumeMaster, ResumeTailored } from '@career/core';
import { z } from 'zod';

import type { CareerStore } from './store';
import { applyJsonPatch, describeTailorChanges, parseTailorProposal, placeOf, sanitizeTailorOps, type TailorChange } from './tailor';
import { guardTailorOps, type BlockedOp } from './tailor-guard';

export type TailorStrength = ResumeTailored['strength'];

export interface TailorForJobDeps {
  repos: Repos;
  store: CareerStore;
  askSkill: <T>(skill: string, user: string, opts?: { refs?: string[]; temperature?: number }) => Promise<T>;
  /** 岗位有 JD 原文但还没解析时调它（解析并存回 job.jd_parsed_json）。 */
  parseJd: (jobId: string) => Promise<JdParsed>;
}

export type TailorForJobOutcome =
  | { ok: true; tailored: ResumeTailored; changes: TailorChange[]; unresolved: unknown[]; blocked: Array<BlockedOp & { place: string }> }
  | { ok: false; reason: 'no_jd' };

const strList = z.array(z.string()).catch([]);
const optStr = z.string().nullish().transform(v => v ?? undefined);
/** job.jd_parsed_json（jd-parse 技能的输出，存库）：缺的列表补空，字段类型不对的当没有。 */
const JdParsedSchema = z.object({
  company: optStr, title: optStr, degree: optStr, cohort: optStr, deadline: optStr,
  location: z.array(z.string()).optional().catch(undefined),
  hard_requirements: strList.default([]), responsibilities: strList.default([]), nice_to_have: strList.default([]),
  keywords: z.object({ covered: strList.default([]), diggable: strList.default([]), missing: strList.default([]) }).catch({ covered: [], diggable: [], missing: [] }),
  notes: z.array(z.string()).optional().catch(undefined),
});

function parsedJdOf(job: Job): JdParsed | undefined {
  if (!job.jd_parsed_json) return undefined;
  try {
    const parsed = JdParsedSchema.safeParse(JSON.parse(job.jd_parsed_json));
    if (parsed.success) return parsed.data;
    console.warn(`[career] job ${job.id} jd_parsed_json not a JdParsed, will re-parse: ${parsed.error.message.slice(0, 200)}`);
  } catch (error) {
    console.warn(`[career] job ${job.id} jd_parsed_json unreadable, will re-parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

/** 定制一份：没有 JD（原文也没有）返回 no_jd，由调用方决定怎么说；模型出错照常抛出。 */
export async function tailorForJob(d: TailorForJobDeps, input: { master: ResumeMaster; job: Job; strength?: TailorStrength }): Promise<TailorForJobOutcome> {
  const { master, job } = input;
  let jd = parsedJdOf(job);
  if (!jd && job.jd_raw?.trim()) jd = await d.parseJd(job.id);
  if (!jd) return { ok: false, reason: 'no_jd' };
  const strength = input.strength ?? 'keywords';
  const claims = d.repos.listClaims().filter(c => c.status !== 'pending').map(c => `- [${c.id}] ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '（无）';
  const raw = await d.askSkill<Record<string, unknown>>('resume-tailor', `母版简历 schema：\n${master.schema_json}\n\nJdParsed：\n${JSON.stringify(jd)}\n\n可用主张（仅 user_confirmed / verified）：\n${claims}\n\n强度：${strength}`, { refs: ['风格库', '岗位速查'], temperature: 0.2 });
  const proposal = parseTailorProposal(raw);
  const sane = sanitizeTailorOps(proposal.ops, proposal.reasons);
  if (sane.dropped.length) console.warn(`[resume-tailor] dropped ${sane.dropped.length} ops outside resume schema: ${sane.dropped.slice(0, 5).join(', ')}`);
  const before: unknown = JSON.parse(master.schema_json);
  const { ops, blocked } = guardTailorOps(before, sane.ops, sane.reasons, d.repos.listClaims());
  if (blocked.length) console.warn(`[resume-tailor] blocked ${blocked.length} unsupported ops: ${blocked.slice(0, 5).map(b => `${b.path}(${b.why})`).join(', ')}`);
  const created = d.store.createTailored({ master_id: master.id, job_id: job.id, schema_json: master.schema_json, strength });
  const tailored = d.store.confirmTailored(created.id, applyJsonPatch(before, ops));
  return {
    ok: true, tailored, unresolved: proposal.unresolved,
    changes: describeTailorChanges(before, ops, sane.reasons),
    blocked: blocked.map(b => ({ ...b, place: placeOf(before, b.path.split('/').slice(1)) })),
  };
}

// ---------- 批量：几份并行、有超时、不成就退回主简历 ----------

/**
 * 一份定制最多等多久：DeepSeek 解析 JD + 定制两次调用通常 20–40 秒（D.0.3），超过就退回主简历，不拖住这一份。
 * 超时后模型调用不会被中止（ShellLLM.complete 不收 AbortSignal），晚到的定制版照常落库、下一次投这个岗位时用上。
 */
export const TAILOR_TIMEOUT_MS = 45_000;
/** 同时定制几份：模型网关并发够用，又不至于一批 30 家同时打出去被限流。 */
export const TAILOR_CONCURRENCY = 3;

export type TailorRunner = (input: { jobId: string; masterId: string }) => Promise<{ tailored_id: string; changes: number }>;
export type TailorFailure = 'tailor_failed' | 'tailor_timeout';
export type TailorAttempt = { ok: true; tailored_id: string; changes: number } | { ok: false; reason: TailorFailure };

export interface TailorJobsOptions { timeoutMs?: number; concurrency?: number }

class TailorTimeout extends Error { constructor(ms: number) { super(`定制超过 ${ms}ms`); this.name = 'TailorTimeout'; } }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TailorTimeout(ms)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function attemptOne(runner: TailorRunner, item: { jobId: string; masterId: string }, timeoutMs: number): Promise<TailorAttempt> {
  try {
    const r = await withTimeout(runner(item), timeoutMs);
    console.log(`[career] tailor ok job=${item.jobId} tailored=${r.tailored_id} changes=${r.changes}`);
    return { ok: true, ...r };
  } catch (error) {
    const reason: TailorFailure = error instanceof TailorTimeout ? 'tailor_timeout' : 'tailor_failed';
    console.warn(`[career] tailor FAILED job=${item.jobId} reason=${reason} detail=${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason };
  }
}

/** 按岗位定制一批：返回每个岗位的结果（定制成了 / 为什么没成），从不抛错。 */
export async function tailorJobs(runner: TailorRunner, items: ReadonlyArray<{ jobId: string; masterId: string }>, opts: TailorJobsOptions = {}): Promise<Map<string, TailorAttempt>> {
  const out = new Map<string, TailorAttempt>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      out.set(item.jobId, await attemptOne(runner, item, opts.timeoutMs ?? TAILOR_TIMEOUT_MS));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? TAILOR_CONCURRENCY, items.length) }, worker));
  return out;
}

/** 批量投时默认的定制：用壳里的共享模型（和对话里的工具同一个）跑 tailorForJob，不出卡。 */
export function defaultTailorRunner(repos: Repos, store: CareerStore): TailorRunner {
  return async ({ jobId, masterId }) => {
    const [{ getShellLLM }, { loadSkillPrompt }, { loadCore }, { parseAndStoreJd }] = await Promise.all([import('./llm'), import('./skills'), import('./core-module'), import('./intake')]);
    const [core, llm] = [await loadCore(), getShellLLM()];
    const askSkill = async <T>(skill: string, user: string, o: { refs?: string[]; temperature?: number } = {}): Promise<T> => {
      const res = await llm.complete({ system: await loadSkillPrompt(skill, o.refs ?? []), messages: [{ role: 'user', content: user }], json: true, temperature: o.temperature ?? 0.3 });
      return core.extractJson<T>(res.text);
    };
    const parseJd = async (id: string) => (await parseAndStoreJd({ repos, core, llm, broadcast: () => undefined, sessionId: () => 'batch' }, { job_id: id })).parsed;
    const master = store.getResume(masterId);
    const job = repos.getJob(jobId);
    if (master?.kind !== 'master') throw new Error(`主简历不存在：${masterId}`);
    if (!job) throw new Error(`岗位不存在：${jobId}`);
    const out = await tailorForJob({ repos, store, askSkill, parseJd }, { master: master.row, job });
    if (!out.ok) throw new Error('这个岗位没有岗位描述');
    return { tailored_id: out.tailored.id, changes: out.changes.length };
  };
}
