/**
 * 主链路「交简历 → 按岗位定制」的两个工具（立场 9：每一步要用户做的，以卡片出现在眼前）。
 * - resume_import：拖进简历 → 基本信息补进私密库、经历按段落进经历库 → 对话里一张预填好的卡，点一下生成主简历。
 * - resume_tailor：给一个岗位 → 改动先过防编造闸门（tailor-guard）→ 写出定制版 → 对话里一张「改了什么」卡，逐处原文 → 新文。
 */
import { basename } from 'path';

import type { tool as SdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { Claim, Job, JdParsed, Repos, ResumeMaster, Vault } from '@career/core';
import type { z as Zod } from 'zod/v4';

import { importResume, INTAKE_CORE_FIELDS, parseResumeParse } from '../career/resume-intake';
import type { CareerStore } from '../career/store';
import type { TailorChange } from '../career/tailor';
import type { BlockedOp } from '../career/tailor-guard';
import { tailorForJob } from '../career/tailor-for-job';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ProfileFieldDef = { field: string; label: string; sensitive: boolean; hint?: string };

/** 读出的简历正文最多喂给模型多少字：一两页简历远小于这个数，超长的多半是附带了作品集。 */
const MAX_RESUME_CHARS = 30_000;
/** 「改了什么」卡最多列几处：再多就不是「一眼看出」了，其余在编辑器里看。 */
const MAX_CHANGES_ON_CARD = 12;

export interface ResumeChainToolDeps {
  tool: typeof SdkTool;
  z: typeof Zod;
  repos: () => Repos;
  vault: () => Vault;
  store: () => CareerStore;
  profileFields: readonly ProfileFieldDef[];
  /** 私密值的打码预览（和私密库 status 同一套规则）。 */
  mask: (field: string, value: string) => string;
  wrap: (fn: () => Promise<ToolResult> | ToolResult) => () => Promise<ToolResult>;
  text: (data: unknown) => ToolResult;
  err: (message: unknown) => ToolResult;
  changed: (...tables: string[]) => void;
  card: (id: string, kind: string, title: string, data: Record<string, unknown>) => void;
  progress: (phase: string, message: string) => void;
  askSkill: <T>(skill: string, user: string, opts?: { refs?: string[]; temperature?: number }) => Promise<T>;
  readDocument: (absPath: string) => Promise<{ ok: boolean; text: string; attempts: string[] }>;
  workspacePath: (path: string) => string;
  fileExists: (absPath: string) => boolean;
  resolveMaster: (masterId?: string) => ResumeMaster;
  requireJob: (jobId: string) => Job;
  /** 已不用：定制管线（career/tailor-for-job.ts）自己读 jd_parsed_json 和已确认主张；留着是为了调用方不用同步改。 */
  jdOf?: (job: Job) => JdParsed | undefined;
  parseJd: (jobId: string) => Promise<JdParsed>;
  /** 已不用，同 jdOf。 */
  confirmedClaims?: () => Claim[];
}

const label = (defs: readonly ProfileFieldDef[], field: string) => defs.find(f => f.field === field)?.label ?? field;

export function createResumeChainTools(d: ResumeChainToolDeps) {
  const { tool, z } = d;

  /** 卡片数据：读到的基本信息只给脱敏预览（明文在私密库），缺的核心项带输入框，经历连同说法默认全勾。 */
  const intakeCard = (out: ReturnType<typeof importResume>) => {
    const status = d.vault().status();
    const core = new Set<string>(INTAKE_CORE_FIELDS);
    d.card(`resume_intake:${out.draft.id}`, 'resume_intake', '从你的简历里读到这些', {
      intake_id: out.draft.id,
      source: out.draft.source,
      profile: status.profile.filled.filter(f => (core.has(f.field) || out.filled.includes(f.field)) && !out.conflicts.includes(f.field)).map(f => ({ field: f.field, label: f.label, preview: f.preview, from_resume: out.filled.includes(f.field) })),
      missing: out.missing.map(field => { const def = d.profileFields.find(f => f.field === field); return { field, label: def?.label ?? field, hint: def?.hint ?? null, sensitive: def?.sensitive ?? false }; }),
      conflicts: out.conflicts.map(field => {
        const def = d.profileFields.find(f => f.field === field);
        const value = out.draft.pending_profile?.[field] ?? '';
        return { field, label: def?.label ?? field, resume_preview: def?.sensitive === false ? value : d.mask(field, value), vault_preview: status.profile.filled.find(f => f.field === field)?.preview ?? '' };
      }),
      education: out.draft.education.map(e => ({ school: e.school, degree: e.degree, major: e.major, start: e.start, end: e.end })),
      experiences: out.experiences.map(({ experience: e, claims }) => ({
        id: e.id, title: e.title, org: e.org, role: e.role, start: e.start_date, end: e.end_date,
        claims: claims.map(c => ({ id: c.id, text: c.text, result_metric: c.result_metric })),
      })),
    });
  };

  const tailorCard = (args: { tailoredId: string; masterId: string; job: Job; changes: TailorChange[]; unresolved: unknown[]; blocked: Array<BlockedOp & { place: string }> }) => {
    const needs = args.unresolved.map(u => (typeof u === 'string' ? u : u && typeof u === 'object' && typeof (u as { need?: unknown }).need === 'string' ? (u as { need: string }).need : '')).filter(Boolean);
    d.card(`tailor:${args.tailoredId}`, 'tailor_diff', `为「${[args.job.company_name, args.job.title].filter(Boolean).join(' · ')}」定制好了`, {
      tailored_id: args.tailoredId, master_id: args.masterId, job_id: args.job.id, company: args.job.company_name, title: args.job.title,
      total: args.changes.length, changes: args.changes.slice(0, MAX_CHANGES_ON_CARD), needs,
      blocked: args.blocked.slice(0, MAX_CHANGES_ON_CARD).map(b => ({ place: b.place, after: b.after, why: b.why })),
    });
  };

  return [
    tool('resume_import', '用户拖进 / 上传自己的简历（PDF、Word、截图）时用它，一次收完：简历上的姓名、手机、邮箱、学校、专业、学历、毕业时间直接补进私密库（不覆盖用户填过的）；每段实习 / 项目 / 校园经历各建一条经历，说法待确认；教育、技能存成草稿。对话里会出一张预填好的卡，用户勾一下就生成主简历。之后不要再在对话里问简历上已有的信息（日期、学校全名、联系方式），缺的项卡片里已经带了输入框。', {
      path: z.string().describe('简历文件路径：绝对路径，或对话附件给出的工作区相对路径'),
    }, async (args) => d.wrap(async () => {
      const abs = d.workspacePath(args.path);
      if (!d.fileExists(abs)) return d.err(`找不到文件：${args.path}`);
      d.progress('resume_import', `正在读简历 ${basename(abs)}`);
      const doc = await d.readDocument(abs);
      if (!doc.ok || !doc.text.trim()) return d.err(`没读出文字。依次尝试过：${doc.attempts.join('；') || '无'}。如实告诉用户没读到，请他换成可复制文字的 PDF / Word，或直接截图拖进来。`);
      const parsed = parseResumeParse(await d.askSkill<unknown>('resume-import', `以下是用户上传的简历《${basename(abs)}》读出的文字：\n\n${doc.text.slice(0, MAX_RESUME_CHARS)}`, { temperature: 0.1 }));
      if (!parsed.entries.length && !parsed.education.length) return d.err('这份文件里没认出教育或经历，看起来不是简历。是证明材料或项目报告的话用 ingest_document。');
      const out = importResume({ repos: d.repos(), vault: d.vault() }, { text: doc.text, source: basename(abs), locator: abs, parsed });
      d.changed('experience', 'claim', 'evidence', 'vault', 'kv');
      intakeCard(out);
      const claims = out.experiences.reduce((n, x) => n + x.claims.length, 0);
      return d.text({
        intake_id: out.draft.id, experiences: out.experiences.length, claims, education: out.draft.education.length,
        filled_from_resume: out.filled.map(f => label(d.profileFields, f)), still_missing: out.missing.map(f => label(d.profileFields, f)),
        differs_from_profile: out.conflicts.map(f => label(d.profileFields, f)),
        note: `对话里已出一张「从你的简历里读到这些」卡：基本信息已预填、缺的项带输入框、每段经历的说法默认全勾，用户点一下就生成主简历。${out.conflicts.length ? `简历和基本资料有 ${out.conflicts.length} 项不一样，卡片里已经并排列出、默认以这份简历为准，选一下全部同步；不要在对话里列表对账，也不要追问哪个是真的。` : ''}回复一两句：读到了几段经历，卡片里看一眼、点一下就行。不要复述简历内容，不要在对话里问任何字段，不要让用户发东西。`,
      });
    })()),

    tool('resume_tailor', '按岗位定制简历：只用已确认主张生成改动并直接写进一份新的定制简历（不需要用户审核）。岗位有 JD 原文但还没解析时会自动解析。对话里会出一张「改了什么」卡（逐处原文 → 新文、理由），用户一眼就能看出改了哪里。', {
      master_id: z.string().optional().describe('缺省取唯一的主简历；没有主简历时先调用 resume_master_create'),
      job_id: z.string(),
      strength: z.enum(['nudge', 'keywords', 'full']).optional(),
    }, async (args) => d.wrap(async () => {
      const masterRow = d.resolveMaster(args.master_id);
      const job = d.requireJob(args.job_id);
      const strength = args.strength ?? 'keywords';
      const out = await tailorForJob({ repos: d.repos(), store: d.store(), askSkill: d.askSkill, parseJd: d.parseJd }, { master: masterRow, job, strength });
      if (!out.ok) {
        return d.err(job.url
          ? `这个岗位还没有 JD 正文。用 browser_open 打开 ${job.url} 读；要登录就 browser_wait_user 请用户登录一下（这是一步，不是失败），读到后 browser_capture_job 收录，再调 resume_tailor。不要让用户复制粘贴 JD。`
          : '这个岗位既没有链接也没有 JD 正文：用 web_search 按公司 + 岗位名找到招聘页，再 browser_open / browser_capture_job 收录。不要让用户复制粘贴 JD。');
      }
      const { tailored, changes, blocked, unresolved } = out;
      d.changed('resume_tailored', 'resume_snapshot');
      tailorCard({ tailoredId: tailored.id, masterId: masterRow.id, job, changes, unresolved, blocked });
      return d.text({
        tailored_id: tailored.id, job_title: job.title ?? null, company: job.company_name ?? null, applied_ops: changes.length,
        changes: changes.slice(0, MAX_CHANGES_ON_CARD).map(c => ({ place: c.place, reason: c.reason })),
        unresolved, blocked: blocked.length,
        note: '定制版已写好，对话里已出一张「改了什么」卡（逐处原文 → 新文、对上哪条 JD；unresolved 和被拦下的没依据改动也列在卡上，已经不在简历里，不用你再自查回退）。回复一句话说改动方向即可，不要逐条复述，不要以让用户发东西收尾。用户想改回某处时用 resume_save 改。',
      });
    })()),
  ];
}
