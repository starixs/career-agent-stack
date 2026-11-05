/**
 * 投递材料包：把要投的简历冻结下来——简历内容快照进 resume_snapshot，PDF 按内容哈希存到
 * `exports/packets/<sha256>.pdf`（同内容只存一份、永不覆盖），JD 原文进 application_packet.jd_snapshot_json。
 *
 * 什么时候冻结：入队（apply_prepare / prepareJobs）不再冻结；fill_form 开跑前由运行器冻结一次（packet-prepare.ts：
 * 按岗位定制 → 导 PDF → 建材料包），fill 与 submit 共用同一材料包；邮件投递（mail_compose）仍在入队时冻结。
 *  - fill_form 的批准 = 「按 payload.resume_plan 开始填」（不提交），内容哈希覆盖 resume_plan、resume_id；
 *  - submit 的批准覆盖 packet_id（冻结的 PDF 哈希 + 简历快照）与 resumeSha：上传与提交核对的是同一份。
 * 执行时（对话 apply_run、后台批量、邮件发送）一律从材料包取文件，并核对文件哈希。
 *
 * 旧动作没有 packet_id：退回"按 resume_id 现导"，行为与以前一致。
 *
 * 上传到招聘网站的文件名要能看懂（HR 看到的是一串哈希就很怪）：内部仍按哈希存，执行前复制成
 * `姓名-岗位-公司.pdf` 再交给浏览器（readableResumeFileName）。文件名只用简历本身会出现的信息。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { parseVaultPlaceholder, PROFILE_FIELDS, type ApplicationPacket, type Job, type Repos } from '@career/core';
import { z } from 'zod';

import type { ResumePlan, ResumePlanKind } from '../../shared/careerRail';
import type { CareerStore } from './store';

export type { ResumePlan, ResumePlanKind } from '../../shared/careerRail';

/** 材料包里记下的这份用了哪种简历（answers_json.resume_plan，也在 fill_form payload.resume_plan）：回执、进展读它说实话。 */
export const PacketResumePlanSchema = z.object({
  kind: z.enum(['tailored', 'master', 'will_tailor', 'no_jd']),
  changes: z.number().nullable().catch(null),
  /** tailor_failed / tailor_timeout：定制没成退回主简历；explicit：他指定的这份。 */
  reason: z.string().optional(),
});
export type PacketResumePlan = z.infer<typeof PacketResumePlanSchema>;

export interface PacketDeps {
  repos: Repos;
  store: CareerStore;
  /** 导出 PDF（渲染前解私密库占位符）；返回文件路径。 */
  exportPdf: (resumeId: string) => Promise<string>;
  exportsDir: string;
}

export interface FrozenPacket { packet: ApplicationPacket; warning?: string }

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 选要投的简历：显式指定 → 这个岗位最近一份定制简历 → 唯一一份主简历。
 * 多份主简历又没指定时返回 undefined，由调用方让用户选（不替用户猜）。
 */
export function pickResumeForJob(store: CareerStore, jobId: string | null | undefined, explicit?: string | null): { id: string; kind: 'master' | 'tailored'; reason: string } | undefined {
  if (explicit) {
    const found = store.getResume(explicit);
    return found ? { id: explicit, kind: found.kind, reason: '你指定的这份' } : undefined;
  }
  if (jobId) {
    const tailored = store.listResumeTailored().filter(t => t.job_id === jobId).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    if (tailored) return { id: tailored.id, kind: 'tailored', reason: '这个岗位的定制简历' };
  }
  const masters = store.listResumeMasters();
  if (masters.length === 1) return { id: masters[0].id, kind: 'master', reason: '唯一一份主简历' };
  return undefined;
}

type FoundResume = NonNullable<ReturnType<CareerStore['getResume']>>;
type PacketPdf = { path: string; sha: string };

/** 导出 PDF 并按内容哈希归档；失败返回 error（带原因，调用方决定是警告还是不开始）。 */
async function exportPacketPdf(deps: PacketDeps, resumeId: string): Promise<PacketPdf | { error: string }> {
  try {
    const exported = await deps.exportPdf(resumeId);
    const sha = fileSha256(exported);
    const dir = join(deps.exportsDir, 'packets');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sha}.pdf`);
    if (!existsSync(path)) copyFileSync(exported, path);
    return { path, sha };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function createPacketRow(deps: PacketDeps, input: { applicationId?: string | null; jobId?: string | null; answers?: unknown }, found: FoundResume | undefined, pdf: PacketPdf | null): ApplicationPacket {
  return deps.repos.createPacket({
    application_id: input.applicationId ?? null,
    job_id: input.jobId ?? null,
    resume_id: found?.row.id ?? null,
    resume_kind: found?.kind ?? null,
    resume_schema_json: found?.row.schema_json ?? null,
    resume_pdf_path: pdf?.path ?? null,
    resume_pdf_sha256: pdf?.sha ?? null,
    answers: input.answers,
  });
}

export async function freezePacket(deps: PacketDeps, input: { applicationId?: string | null; jobId?: string | null; resumeId?: string | null; answers?: unknown }): Promise<FrozenPacket> {
  const found = input.resumeId ? deps.store.getResume(input.resumeId) : undefined;
  let pdf: PacketPdf | null = null;
  let warning: string | undefined;
  if (found) {
    const exported = await exportPacketPdf(deps, found.row.id);
    if ('error' in exported) warning = `简历 PDF 导出失败，这次投递不会上传附件：${exported.error}`;
    else pdf = exported;
  } else if (input.resumeId) {
    warning = `简历不存在：${input.resumeId}`;
  }
  const packet = createPacketRow(deps, input, found, pdf);
  return { packet, ...(warning ? { warning } : {}) };
}

/** 批量投时 PDF 导不出来就不填这家（没附简历就投出去比不投更糟，风险 E#11）。 */
export const PDF_EXPORT_FAILED_REASON = '简历 PDF 没导出来';

/**
 * 批量投用的冻结：先导 PDF，导不出来返回 failed、不建材料包；导出来了返回一个 commit，调用方建好投递后再落材料包。
 * 分两步是为了失败的那家不留下一条空投递。
 */
export async function preparePacketPdf(deps: PacketDeps, resumeId: string): Promise<{ failed: string } | { commit: (input: { applicationId: string; jobId: string; answers?: unknown }) => ApplicationPacket }> {
  const found = deps.store.getResume(resumeId);
  if (!found) return { failed: `简历不存在：${resumeId}` };
  const pdf = await exportPacketPdf(deps, resumeId);
  if ('error' in pdf) {
    console.warn(`[career] packet FAILED resume=${resumeId} reason=pdf_export detail=${pdf.error}`);
    return { failed: PDF_EXPORT_FAILED_REASON };
  }
  return { commit: input => createPacketRow(deps, input, found, pdf) };
}

/**
 * 简历里引用了、私密库里却没有的资料项（「手机号」「邮箱」）：这些占位符导出时会原样留在简历上（风险 E#10）。
 * unresolved 是私密库的 Vault.unresolved（列出库里没有的占位符）。
 */
export function missingVaultFields(schemaJson: string, unresolved: (text: string) => string[]): string[] {
  if (!schemaJson.includes('{{')) return [];
  const labels = new Set<string>();
  for (const token of unresolved(schemaJson)) {
    const p = parseVaultPlaceholder(token);
    labels.add(p?.scope === 'profile' ? PROFILE_FIELDS.find(f => f.field === p.field)?.label ?? p.field : '经历里的信息');
  }
  return [...labels];
}

/** 岗位描述至少这么长才算真 JD：校招汇总的元数据只有几行（公司 / 批次 / 链接），一份真 JD 远长于此。 */
const REAL_JD_MIN_CHARS = 200;
const JD_WORDS_RX = /(职责|要求|岗位描述|职位描述|工作内容|任职)/;
/** 校招汇总导入时拼的元数据以「公司：」开头（bridges/campusRadar.ts mapCampusJob），不是岗位描述。 */
const CAMPUS_META_RX = /^\s*公司：/;

/** 这个岗位有没有真的岗位描述（能拿来定制简历）。没有就用主简历并如实标出，不按岗位名假定制（立场 3）。 */
export function hasRealJd(job: Pick<Job, 'jd_raw'> | null | undefined): boolean {
  const raw = job?.jd_raw?.trim();
  if (!raw || CAMPUS_META_RX.test(raw)) return false;
  return raw.length > REAL_JD_MIN_CHARS || JD_WORDS_RX.test(raw);
}

/** 简历 JSON 的每个文字叶子：路径 → 文字。 */
function textLeaves(value: unknown, path: string, out: Map<string, string>): Map<string, string> {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out.set(path, String(value));
  else if (Array.isArray(value)) value.forEach((v, i) => textLeaves(v, `${path}/${i}`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) textLeaves(v, `${path}/${k}`, out);
  return out;
}

/** 两版简历之间改了几处（加、删、改的文字叶子数）。 */
export function countResumeChanges(before: unknown, after: unknown): number {
  const a = textLeaves(before, '', new Map());
  const b = textLeaves(after, '', new Map());
  let n = 0;
  for (const [k, v] of a) if (b.get(k) !== v) n++;
  for (const k of b.keys()) if (!a.has(k)) n++;
  return n;
}

/** 定制版相对它生成时的主简历改了几处：基准是确认前快照（= 生成时的主简历），没有就用主简历现在的内容。 */
export function tailoredChangeCount(repos: Repos, tailoredId: string): number | null {
  const row = repos.db.get<{ schema_json: string; master_id: string }>('SELECT schema_json, master_id FROM resume_tailored WHERE id=?', [tailoredId]);
  if (!row) return null;
  const base = repos.db.get<{ schema_json: string }>("SELECT schema_json FROM resume_snapshot WHERE resume_id=? AND note='确认前快照' ORDER BY created_at ASC, rowid ASC LIMIT 1", [tailoredId])
    ?? repos.db.get<{ schema_json: string }>('SELECT schema_json FROM resume_master WHERE id=?', [row.master_id]);
  if (!base) return null;
  try {
    return countResumeChanges(JSON.parse(base.schema_json), JSON.parse(row.schema_json));
  } catch (error) {
    console.warn(`[career] tailored ${tailoredId} change count failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 这个岗位投的时候用哪份简历（纯查询，不调模型）：已有定制版 → tailored；有真 JD 没定制 → will_tailor；没 JD → no_jd（主简历）。
 * 主简历：只有一份时用它；好几份时用 masterId（确认时选好的），都没有为 null，由调用方让他选。
 */
export function resumePlanForJob(store: CareerStore, repos: Repos, jobId: string, masterId?: string | null): ResumePlan {
  const picked = pickResumeForJob(store, jobId);
  if (picked?.kind === 'tailored') return { kind: 'tailored', resume_id: picked.id, name: resumeMasterOf(repos, picked.id)?.name ?? null, changes: tailoredChangeCount(repos, picked.id) };
  const master = picked ?? (masterId ? pickResumeForJob(store, null, masterId) : undefined);
  const kind: ResumePlanKind = hasRealJd(repos.getJob(jobId)) ? 'will_tailor' : 'no_jd';
  return { kind, resume_id: master?.id ?? null, name: master ? resumeMasterOf(repos, master.id)?.name ?? null : null, changes: null };
}

/** 文件名里的一段：去掉文件系统不允许的字符与首尾的点 / 空白，过长截断。 */
function fileNamePart(value: string | null | undefined, max = 40): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex -- 文件名里不能有控制字符
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  return [...cleaned].slice(0, max).join('').trim();
}

/**
 * 岗位库里的合集标题（「软件类 / 通信类 / IC类」「智能研发类 汽车研发类 测试类 等8个岗位」）不是一个岗位：
 * 放进上传文件名会让 HR 看到一串类目（2026-10-31 小鹏），这时用简历的求职方向（「后端开发」）。
 */
const COUNT_RX = /等\s*\d+\s*个岗位/;
/** 合集标题：写着「等 N 个岗位」，或者分隔开的每一段都是「XX类」（单个岗位名里也可能有斜杠，如「算法/推荐」）。 */
function isAggregateTitle(title: string): boolean {
  if (COUNT_RX.test(title)) return true;
  const parts = title.split(/[/／、|]+/).map(p => p.trim()).filter(Boolean);
  return parts.length >= 2 && parts.every(p => /类$/.test(p));
}

/** `姓名-岗位-公司.pdf`；姓名缺失时用简历名，全部缺失时叫「简历.pdf」。 */
/** 一份材料包用的简历属于哪份主简历（主简历本身或它的定制版），取名字和方向。 */
export function resumeMasterOf(repos: Repos, resumeId: string): { name: string; direction: string | null } | undefined {
  return repos.db.get<{ name: string; direction: string | null }>('SELECT name, direction FROM resume_master WHERE id=?', [resumeId])
    ?? repos.db.get<{ name: string; direction: string | null }>('SELECT m.name AS name, m.direction AS direction FROM resume_tailored t JOIN resume_master m ON m.id=t.master_id WHERE t.id=?', [resumeId]);
}

export function readableResumeFileName(parts: { person?: string | null; resumeName?: string | null; jobTitle?: string | null; company?: string | null; direction?: string | null }): string {
  const who = fileNamePart(parts.person) || fileNamePart(parts.resumeName);
  const raw = parts.jobTitle?.trim() ?? '';
  // 方向写了几个（「后端开发 / 数据开发 / AI 应用开发」）只取第一个：文件名要短
  const title = !raw || raw === '未命名岗位' ? '' : isAggregateTitle(raw) ? fileNamePart(parts.direction?.split(/[/／、|,，]+/)[0]) : fileNamePart(raw);
  const name = [who, title, fileNamePart(parts.company)].filter(Boolean).join('-');
  return `${name || '简历'}.pdf`;
}

export interface ResumeFileOptions {
  /** 把简历里的私密库占位符（如姓名）换成明文；只在 Node 侧用于生成上传文件名。 */
  resolveText?: (text: string) => string;
}

function packetFileNameParts(repos: Repos, packet: ApplicationPacket, resolveText?: (text: string) => string) {
  let person: string | undefined;
  try {
    const snap = packet.resume_snapshot_id ? repos.db.get<{ schema_json: string }>('SELECT schema_json FROM resume_snapshot WHERE id=?', [packet.resume_snapshot_id]) : undefined;
    const raw = (JSON.parse(snap?.schema_json ?? 'null') as { basics?: { name?: unknown } } | null)?.basics?.name;
    if (typeof raw === 'string' && raw.trim()) {
      const resolved = resolveText ? resolveText(raw) : raw;
      if (!resolved.includes('{{vault:')) person = resolved;
    }
  } catch { /* 快照损坏：退回简历名 */ }
  let resumeName: string | undefined;
  let direction: string | undefined;
  try {
    if (packet.resume_id) {
      const master = resumeMasterOf(repos, packet.resume_id);
      resumeName = master?.name;
      direction = master?.direction ?? undefined;
    }
  } catch (error) { console.warn(`[career] packet ${packet.id} resume name lookup failed: ${error instanceof Error ? error.message : String(error)}`); }
  let jd: { title?: string | null; company_name?: string | null } = {};
  try { jd = JSON.parse(packet.jd_snapshot_json || '{}') as typeof jd; } catch { /* ignore */ }
  return { person, resumeName, jobTitle: jd.title ?? null, company: jd.company_name ?? null, direction };
}

/** 材料包 PDF 的可读副本：`<packets>/upload/<packet_id>/<可读名>.pdf`，内容与哈希存档一致才复用。失败时返回 undefined。 */
function readableCopy(repos: Repos, packet: ApplicationPacket, source: string, opts: ResumeFileOptions): string | undefined {
  try {
    const name = readableResumeFileName(packetFileNameParts(repos, packet, opts.resolveText));
    const dir = join(dirname(source), 'upload', packet.id);
    const target = join(dir, name);
    if (!existsSync(target) || !packet.resume_pdf_sha256 || fileSha256(target) !== packet.resume_pdf_sha256) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(source, target);
    }
    if (packet.resume_pdf_sha256 && fileSha256(target) !== packet.resume_pdf_sha256) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

/**
 * 执行时取材料包里的简历文件：文件还在且哈希对得上才用；对不上说明被改过，拒绝上传（返回 error）。
 * 返回的是可读文件名的副本（内容同一份）；复制失败时退回哈希命名的存档文件。
 * 没有材料包的旧动作走 legacy（按 resume_id 现导）。
 */
export async function packetResumeFile(
  repos: Repos,
  payload: Record<string, unknown>,
  legacy?: (resumeId: unknown) => Promise<string | undefined>,
  opts: ResumeFileOptions = {},
): Promise<{ path?: string; error?: string }> {
  const packetId = typeof payload.packet_id === 'string' ? payload.packet_id : undefined;
  if (!packetId) return { path: await legacy?.(payload.resume_id) };
  const packet = repos.getPacket(packetId);
  if (!packet) return { error: `投递材料包不存在：${packetId}` };
  if (!packet.resume_pdf_path) return {};
  if (!existsSync(packet.resume_pdf_path)) return { error: `材料包里的简历文件不见了：${packet.resume_pdf_path}` };
  if (packet.resume_pdf_sha256 && fileSha256(packet.resume_pdf_path) !== packet.resume_pdf_sha256) return { error: '材料包里的简历文件与批准时不一致，已停止上传，请重新准备这份投递' };
  return { path: readableCopy(repos, packet, packet.resume_pdf_path, opts) ?? packet.resume_pdf_path };
}

// ---------- 投的时候：这份用的哪种简历（网申进展第一步）、填表时读到的岗位描述 ----------

/** 和填表引擎交出的上限（@career/apply JD_TEXT_MAX）一致：8k 字。 */
const CAPTURED_JD_MAX_CHARS = 8000;

/** 材料包 answers_json.resume_plan（开跑前 packet-prepare 写的）；老材料包没有就返回 undefined。 */
export function packetResumePlan(repos: Pick<Repos, 'getPacket'>, packetId: string): PacketResumePlan | undefined {
  const packet = repos.getPacket(packetId);
  if (!packet) return undefined;
  try {
    const answers: unknown = JSON.parse(packet.answers_json || '{}');
    const raw = answers && typeof answers === 'object' && 'resume_plan' in answers ? answers.resume_plan : undefined;
    const plan = PacketResumePlanSchema.safeParse(raw);
    return plan.success ? plan.data : undefined;
  } catch (error) {
    console.warn(`[career] packet ${packetId} answers_json unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** 网申进展里每份的第一步：如实说这份用的是定制版还是主简历（没拿到岗位描述就直说）。 */
export function resumeStepMessage(plan: PacketResumePlan | undefined): string | null {
  if (!plan) return null;
  if (plan.kind === 'tailored') return plan.changes ? `定制简历 ✓ 改 ${plan.changes} 处` : '定制简历 ✓';
  if (plan.kind === 'no_jd') return '用主简历（没拿到岗位描述）';
  if (plan.reason === 'explicit') return '用你选的这份简历';
  return '用主简历（这次定制没成）';
}

/**
 * 填表时在岗位详情页读到的正文存成岗位描述（D.1 e）：只在岗位还没有真 JD 时写，并清掉旧的解析结果，下次定制按新 JD 重新解析。
 * 读到的也得像一份岗位描述才写（导航页、登录页的字不算）。返回是否写了。
 */
export function saveCapturedJd(repos: Repos, jobId: string, text: string): boolean {
  const job = repos.getJob(jobId);
  const jd = text.trim().slice(0, CAPTURED_JD_MAX_CHARS);
  if (!job || hasRealJd(job) || !hasRealJd({ jd_raw: jd })) return false;
  repos.db.update('job', jobId, { jd_raw: jd, jd_parsed_json: null, updated_at: new Date().toISOString() });
  console.log(`[career] jd captured job=${jobId} chars=${jd.length}`);
  return true;
}
