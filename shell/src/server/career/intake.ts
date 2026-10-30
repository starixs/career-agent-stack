/**
 * 收件箱归档（intake）：任何丢进来的内容（粘贴 / 邮件 / 文件）→ inbox_item → inbox-triage 技能判类型抽字段
 * → 自动落成结构化对象（岗位 / 面试 / 截止事件 / 关闭投递 / Offer）→ 推 focus 给面板。
 *
 * 路由（Global）与工具（Session）共用这一份实现；没有模型时只落 inbox_item，交给用户在面板处理。
 * JD 的解析入库也在这里（parseAndStoreJd），career-tools 直接复用，避免两份实现。
 */
import type { Repos, LLM, Job, JdParsed, InboxItem, InboxKind, InboxSource, DeadlineKind } from '@career/core';

import { fetchPage } from './web-fetch';
import { normalizeIso } from './dates';
import { normalizeRoundLabel, openInterviewDeadline, rescheduleDeadline, upsertInvitedInterview } from './interview-link';
import type { CoreModule } from './core-module';
import { loadSkillPrompt } from './skills';
import { CareerStore } from './store';

/**
 * 面板定位：前六个是一级入口（打开对应页签）；resume_editor / live_drawer 是聊天旁的抽屉（不跳转），
 * vault 打开私密信息页。
 */
export type FocusSurface = 'today' | 'inbox' | 'dossier' | 'material' | 'review' | 'guide' | 'vault' | 'resume_editor' | 'live_drawer';
export interface FocusHint { surface: FocusSurface; id?: string | null; application_id?: string | null; job_id?: string | null; note?: string }

export interface IntakeDeps {
  repos: Repos;
  core: CoreModule;
  /** null → 不调模型，只落收件箱。 */
  llm: LLM | null;
  broadcast: (event: string, data: unknown) => void;
  sessionId: () => string;
  /** 当前日期（测试注入）。 */
  now?: () => string;
}

export interface IntakeInput {
  text: string;
  source?: InboxSource;
  mail_message_id?: string | null;
  /** 邮件场景的附加信息，拼进提示词帮助判类型。 */
  mail?: { subject?: string | null; from?: string | null; received_at?: string | null };
  /** 用户在面板里已指定归属的投递。 */
  application_id?: string | null;
  /** 第一次连邮箱时导入的历史邮件：不推面板、不进通知中心，只把申请和卷宗建好。 */
  history?: boolean;
}

export interface TriageResult {
  kind?: InboxKind | string;
  relevance?: 'job' | 'ignored';
  confidence?: number;
  fields?: { company?: string; title?: string; round?: string; when?: string; due_at?: string; location_or_link?: string; contact?: string; referral_code?: string; notes?: string };
  match?: { application_id?: string; candidates?: string[] };
  actions?: Array<{ type: string; payload?: Record<string, unknown> }>;
  urgency?: 'urgent' | 'soon' | 'normal';
  summary?: string;
}

export interface IntakeResult {
  item: InboxItem;
  triage: TriageResult | null;
  created: { job_id?: string; application_id?: string; interview_id?: string; offer_id?: string; deadline_ids: string[]; closed_application_id?: string };
  focus: FocusHint;
  /** 面板 / 对话要告诉用户的一句话。 */
  summary: string;
}

export { normalizeIso } from './dates';

const INBOX_KIND_SET = new Set<string>(['jd', 'application_received', 'interview_invite', 'assessment', 'written_test', 'rejection', 'offer', 'referral', 'deadline', 'other']);
/** 招聘方对一份已投申请的回音：能把一份关掉的申请重新打开的那几类。 */
const REPLY_KINDS = new Set<InboxKind>(['interview_invite', 'assessment', 'written_test', 'rejection', 'offer']);

/** 技能提示词 + 模型 → JSON（与 career-tools.askSkill 同形，这里不依赖工具层）。 */
async function askSkill<T>(deps: IntakeDeps, skill: string, user: string, temperature = 0.2): Promise<T> {
  if (!deps.llm) throw new Error('模型不可用');
  const system = await loadSkillPrompt(skill);
  const res = await deps.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature });
  return deps.core.extractJson<T>(res.text);
}

export function focus(deps: Pick<IntakeDeps, 'broadcast' | 'sessionId'>, hint: FocusHint): FocusHint {
  deps.broadcast('career:focus', { sessionId: deps.sessionId(), ...hint });
  return hint;
}
export function dataChanged(deps: Pick<IntakeDeps, 'broadcast' | 'sessionId'>, tables: string[]): void {
  deps.broadcast('career:data-changed', { sessionId: deps.sessionId(), tables });
}

// ---------- JD 解析入库（原 career-tools.parseAndStoreJd） ----------
export async function parseAndStoreJd(
  deps: IntakeDeps,
  input: { jd_raw?: string; url?: string; job_id?: string; company_name?: string; title?: string; source_platform?: string },
): Promise<{ job: Job; parsed: JdParsed }> {
  const r = deps.repos;
  let job = input.job_id ? r.getJob(input.job_id) : undefined;
  if (input.job_id && !job) throw new Error(`岗位不存在：${input.job_id}`);
  const jdRaw = input.jd_raw ?? job?.jd_raw ?? undefined;
  if (!jdRaw) throw new Error('需要 jd_raw（链接导入目前只记录 url，不抓取页面；请把 JD 文本一起给我）');
  const digest = r.experienceTree().map(e => `## ${e.title}\n${e.claims.filter(c => c.status !== 'pending').map(c => `- ${c.text}`).join('\n')}`).join('\n\n') || '（经历库为空）';
  const parsed = await askSkill<JdParsed>(deps, 'jd-parse', `公司：${input.company_name ?? job?.company_name ?? '未知'}\n岗位：${input.title ?? job?.title ?? '未知'}\n\nJD 原文：\n${jdRaw}\n\n经历库摘要：\n${digest}`);
  const title = input.title ?? job?.title ?? parsed.title ?? jdRaw.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 60) ?? '未命名岗位';
  // 汇总表维度：只取解析结果的显式字段 + 原文里字面出现的批次 / 企业性质词（见 core jobs.ts JobBoardMeta），拿不到就不写
  const board = deps.core.serializeBoardMeta(deps.core.boardMetaFromJd(parsed, title, jdRaw));
  if (!job) {
    job = r.upsertJob({ source_platform: input.source_platform ?? 'manual', title, url: input.url ?? null, jd_raw: jdRaw, company_name: input.company_name ?? parsed.company ?? null, location: parsed.location?.join('/') ?? null, deadline: parsed.deadline || null, board_json: board });
  }
  const mergedBoard = board ? JSON.stringify(deps.core.mergeBoardMeta(deps.core.parseBoardJson(job.board_json), deps.core.parseBoardJson(board))) : undefined;
  r.db.update('job', job.id, { jd_parsed_json: JSON.stringify(parsed), ...(mergedBoard ? { board_json: mergedBoard } : {}), ...(parsed.deadline && !job.deadline ? { deadline: parsed.deadline } : {}), updated_at: new Date().toISOString() });
  if (parsed.deadline && !r.listDeadlines({ status: 'open' }).some(d => d.job_id === job!.id && d.kind === 'application_deadline')) {
    const due = normalizeIso(parsed.deadline, deps.now?.() ?? new Date().toISOString());
    if (due) r.createDeadline({ kind: 'application_deadline', title: `${job.company_name ?? ''} ${job.title} 网申截止`.trim(), due_at: due, job_id: job.id, source: 'job' });
  }
  dataChanged(deps, ['job', 'deadline']);
  return { job: r.getJob(job.id)!, parsed };
}

// ---------- 收件箱归档 ----------
export async function captureIntake(deps: IntakeDeps, input: IntakeInput): Promise<IntakeResult> {
  const r = deps.repos;
  const text = input.text.trim();
  if (!text) throw new Error('内容为空');
  const item = r.createInboxItem({ source: input.source ?? 'paste', raw_text: text, mail_message_id: input.mail_message_id ?? null });
  dataChanged(deps, ['inbox_item']);
  if (!deps.llm) {
    return { item, triage: null, created: { deadline_ids: [] }, focus: focus(deps, { surface: 'inbox', id: item.id }), summary: '已放进收件箱，等助理在线时归档。' };
  }
  const nowIso = deps.now?.() ?? new Date().toISOString();
  const openApps = r.applicationsWithJob().filter(a => !['rejected', 'discarded', 'skip', 'hired'].includes(a.stage));
  const appList = openApps.map(a => `- ${a.job.company_name ?? '未知'} / ${a.job.title} / 阶段 ${a.stage} / application_id=${a.id}`).join('\n') || '（没有进行中的投递）';
  let triage: TriageResult;
  try {
    triage = await askSkill<TriageResult>(deps, 'inbox-triage', [
      `当前日期：${nowIso.slice(0, 10)}`,
      `来源：${input.source ?? 'paste'}`,
      input.mail ? `邮件主题：${input.mail.subject ?? ''}\n发件人：${input.mail.from ?? ''}\n收件时间：${input.mail.received_at ?? ''}` : '',
      input.application_id ? `用户指定归属投递 application_id=${input.application_id}` : '',
      `进行中的投递：\n${appList}`,
      `原文：\n${text.slice(0, 12_000)}`,
    ].filter(Boolean).join('\n\n'));
  } catch (error) {
    const note = `归类失败：${error instanceof Error ? error.message : String(error)}`;
    const failed = r.resolveInboxItem(item.id, { kind: 'other', status: 'new', note });
    return { item: failed, triage: null, created: { deadline_ids: [] }, focus: focus(deps, { surface: 'inbox', id: item.id }), summary: note };
  }
  const applied = await applyTriage(deps, item, triage, input, nowIso);
  return applied;
}

/**
 * 已经分好类的内容直接落库，不调模型（历史邮件的规则分类用）。
 * history 时静默：调用方整批结束后自己推一次 dataChanged。
 */
export async function captureTriaged(deps: IntakeDeps, input: IntakeInput, triage: TriageResult): Promise<IntakeResult> {
  const quiet: IntakeDeps = input.history ? { ...deps, broadcast: () => undefined } : deps;
  const item = deps.repos.createInboxItem({ source: input.source ?? 'paste', raw_text: input.text.trim(), mail_message_id: input.mail_message_id ?? null });
  return applyTriage(quiet, item, triage, input, deps.now?.() ?? new Date().toISOString());
}

async function applyTriage(deps: IntakeDeps, item: InboxItem, triage: TriageResult, input: IntakeInput, nowIso: string): Promise<IntakeResult> {
  const r = deps.repos;
  const store = new CareerStore(r, deps.core);
  const kind: InboxKind = INBOX_KIND_SET.has(String(triage.kind)) ? triage.kind as InboxKind : 'other';
  const f = triage.fields ?? {};
  const created: IntakeResult['created'] = { deadline_ids: [] };
  const tables = new Set<string>(['inbox_item']);
  const company = (f.company ?? '').trim() || null;
  const title = (f.title ?? '').trim() || null;

  // 找归属投递：用户指定 > 模型匹配 > 公司名匹配（唯一时才用）
  let app = input.application_id ? r.getApplication(input.application_id) : undefined;
  if (!app && triage.match?.application_id) app = r.getApplication(triage.match.application_id);
  // Offer 来信还要算上已接受的那份：接了意向之后还会来三方、入职通知
  if (!app && company) { const hits = r.findOpenApplicationsByCompany(company, kind === 'offer' ? ['hired'] : []); if (hits.length === 1) app = hits[0]; }
  // 都没有：这家投出过、后来被关掉（多半是静默超时）的那份，迟到的回信接回它，不另起一份；重新打开放进下面的 try
  const closed = !app && company && REPLY_KINDS.has(kind) ? r.findClosedSentApplicationsByCompany(company) : [];
  if (closed.length === 1) app = closed[0];

  /**
   * 找不到投递就建岗位 + 投递；然后只往前推进到目标阶段（Repos.advanceTo）：已经在面试的投递又收到一封笔试通知，
   * 阶段不回退、也不抛错——否则整封邮件归档失败、内容全丢。
   */
  const ensureApplication = (stage: 'interview' | 'offer' | 'applied', note: string) => {
    if (!app) {
      // 邮件 / 粘贴里只有公司与岗位名；批次只在原文字面出现时才记（不猜行业）
      const board = deps.core.serializeBoardMeta({ batch: deps.core.batchFromText(title, input.mail?.subject, item.raw_text) });
      const job = r.upsertJob({ source_platform: 'manual', title: title ?? '未命名岗位', company_name: company, board_json: board });
      app = r.createApplication(job.id, null, at);
      created.job_id = job.id;
      tables.add('job').add('application');
    }
    const { app: next, moved } = r.advanceTo(app.id, stage, note, at);
    app = next;
    created.application_id = app.id;
    if (moved) tables.add('application').add('application_history');
    return app;
  };
  /** 邮件里没写年份的日期按收件时间补年份：九月的旧邮件写「9月10日」就是今年九月，不是明年。 */
  const refIso = input.mail?.received_at ?? nowIso;
  /** 阶段流转记在邮件到达的时刻，「我的求职月」才按真实月份统计。 */
  const at = input.mail?.received_at ?? undefined;
  /**
   * allowUnknownTime：笔试 / 测评通知没写时间也建一条（due_at 为 null = 时间未知），笔试记录和投递进度才看得到。
   * 导入时就已经过去的事（第一次连邮箱拉到的历史邮件）不建截止事件：它已经发生了，只留在卷宗和面试记录里，
   * 否则会以「已过期」顶到首屏最上面，盖住真正要你的事。
   */
  const addDeadline = (dk: DeadlineKind, label: string, when: string | undefined, extra: { interview_id?: string; offer_id?: string } = {}, allowUnknownTime = false) => {
    const due = normalizeIso(when, refIso);
    if (!due && !allowUnknownTime) return;
    if (due && Date.parse(due) < Date.parse(nowIso)) return;
    const d = r.createDeadline({ kind: dk, title: label, due_at: due, application_id: app?.id ?? null, job_id: app?.job_id ?? null, source: input.source === 'mail' ? 'mail' : 'inbox', url: f.location_or_link?.startsWith('http') ? f.location_or_link : null, note: f.notes ?? null, ...extra });
    created.deadline_ids.push(d.id);
    tables.add('deadline');
  };
  const noteText = triage.summary || `${company ?? ''} ${title ?? ''} ${kind}`.trim();
  const label = `${company ?? '未知公司'}${title ? ` · ${title}` : ''}`;

  try {
    if (closed.length === 1 && app) { app = r.reopenClosed(app.id, noteText); tables.add('application').add('application_history'); }
    switch (kind) {
      case 'jd': {
        const { job } = await parseAndStoreJd(deps, { jd_raw: item.raw_text, company_name: company ?? undefined, title: title ?? undefined });
        created.job_id = job.id; tables.add('job');
        break;
      }
      case 'application_received': {
        ensureApplication('applied', '收到投递确认');
        break;
      }
      case 'interview_invite': {
        const a = ensureApplication('interview', `收到面试邀请${f.round ? `（${f.round}）` : ''}`);
        // 同一场的提醒 / 改期邮件落回原来那场：只更新时间，不多建面试和时间点
        const { interview: itv } = upsertInvitedInterview(store, { application_id: a.id, company_name: company ?? r.getJob(a.job_id)?.company_name ?? null, title, round: normalizeRoundLabel(f.round), date: normalizeIso(f.when, refIso) ?? null });
        created.interview_id = itv.id; tables.add('interview');
        const known = openInterviewDeadline(r, itv.id);
        if (!known) addDeadline('interview', `${label} 面试${f.round ? `（${f.round}）` : ''}`, f.when, { interview_id: itv.id });
        else if (itv.date && itv.date !== known.due_at) { rescheduleDeadline(r, known.id, itv.date); tables.add('deadline'); }
        r.addDossierNote({ application_id: a.id, kind: 'heard', round: f.round ?? null, content: `面试邀请：${f.when ?? '时间待定'}${f.location_or_link ? `，${f.location_or_link}` : ''}${f.contact ? `，联系人 ${f.contact}` : ''}` });
        tables.add('dossier_note');
        break;
      }
      case 'assessment':
      case 'written_test': {
        const a = ensureApplication('applied', kind === 'assessment' ? '收到测评' : '收到笔试通知');
        addDeadline(kind, `${label} ${kind === 'assessment' ? '测评' : '笔试'}`, f.due_at || f.when, {}, true);
        r.addDossierNote({ application_id: a.id, kind: 'heard', content: `${kind === 'assessment' ? '测评' : '笔试'}：${f.due_at || f.when || '时间见原文'}${f.location_or_link ? `，${f.location_or_link}` : ''}` });
        tables.add('dossier_note');
        break;
      }
      case 'rejection': {
        // 没见过的公司来了拒信，说明投过：先补建这份投递再关掉，漏斗才完整
        if (!app && company) ensureApplication('applied', '收到拒信（之前的投递）');
        if (app) {
          app = r.jumpTo(app.id, 'rejected', '收到拒信', {}, at);
          created.closed_application_id = app.id; tables.add('application').add('application_history');
          r.addDossierNote({ application_id: app.id, kind: 'heard', content: `拒信：${triage.summary ?? ''}` });
          tables.add('dossier_note');
        }
        break;
      }
      case 'offer': {
        const a = ensureApplication('offer', '收到 Offer');
        // 同一份申请只有一个 Offer：意向书之后的正式 offer、三方通知都落在它上面
        const existing = store.listOffers().find(o => o.application_id === a.id);
        const signing = isSigningNotice(f.notes, input.mail?.subject);
        const due = signing ? null : normalizeIso(f.due_at, refIso);
        // 答复期限由 Offer 自己同步到截止事件（只有一处真相）；三方是另一件事，单独记
        const offer = existing
          ? (due ? store.updateOffer(existing.id, { deadline: due }) : existing)
          : store.createOffer({ application_id: a.id, company_name: company, title, deadline: due, risk_notes: f.notes ?? null }, input.source === 'mail' ? 'mail' : 'inbox');
        created.offer_id = offer.id; tables.add('offer').add('deadline');
        if (signing) addDeadline('other', `${label} 三方签约截止`, f.due_at, { offer_id: offer.id });
        else created.deadline_ids.push(...r.listDeadlines({ status: 'open' }).filter(d => d.offer_id === offer.id && d.kind === 'offer_reply').map(d => d.id));
        break;
      }
      case 'referral': {
        addDeadline('referral_expiry', `${label} 内推码过期${f.referral_code ? `（${f.referral_code}）` : ''}`, f.due_at);
        break;
      }
      case 'deadline': {
        addDeadline('other', `${label} ${f.notes || '截止'}`.trim(), f.due_at || f.when);
        break;
      }
      default: break;
    }
  } catch (error) {
    const note = `落库失败：${error instanceof Error ? error.message : String(error)}`;
    const failed = r.resolveInboxItem(item.id, { kind, parsed: triage, status: 'new', note });
    dataChanged(deps, [...tables]);
    return { item: failed, triage, created, focus: focus(deps, { surface: 'inbox', id: item.id }), summary: note };
  }

  const linked = created.interview_id ? { linked_type: 'interview', linked_id: created.interview_id }
    : created.offer_id ? { linked_type: 'offer', linked_id: created.offer_id }
      : created.application_id || created.closed_application_id ? { linked_type: 'application', linked_id: created.application_id ?? created.closed_application_id }
        : created.job_id ? { linked_type: 'job', linked_id: created.job_id }
          : created.deadline_ids[0] ? { linked_type: 'deadline', linked_id: created.deadline_ids[0] } : {};
  const needsUser = kind === 'other' || (triage.relevance === 'job' && !linked.linked_id && kind !== 'rejection');
  const status = input.history ? 'dismissed' : needsUser ? 'new' : 'processed';
  const done = r.resolveInboxItem(item.id, { kind, parsed: triage, ...linked, note: noteText, status });
  dataChanged(deps, [...tables]);
  const appId = created.application_id ?? created.closed_application_id ?? app?.id ?? null;
  const hint: FocusHint = appId ? { surface: 'dossier', application_id: appId } : created.job_id ? { surface: 'dossier', job_id: created.job_id } : { surface: 'inbox', id: item.id };
  return { item: done, triage, created, focus: focus(deps, hint), summary: triage.summary ?? noteText };
}

// ---------- 分享链接（Boss / 猎聘等转发出来的笔试 / 面试通知） ----------
/** 取分享页的标题和正文文字；拿不到（要登录、超时、非 HTML、只有空壳）返回 null，由调用方退回只用粘贴的文字。 */
export async function fetchSharePage(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const page = await fetchPage(url, fetchImpl);
  return page.verdict === 'ok' && page.text ? [page.title, page.text].filter(Boolean).join('\n') : null;
}

/**
 * 用户粘贴的分享链接（可带分享文案）→ 抓分享页文字 → 走同一条归档流程。
 * 分享页常常要登录才看得到，所以粘贴的文案和链接本身都一起交给归档，抓不到页面也不失败。
 */
export async function captureLink(deps: IntakeDeps, input: { url: string; text?: string | null; application_id?: string | null }, fetchImpl?: typeof fetch): Promise<IntakeResult & { fetched: boolean }> {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请粘贴以 http 开头的分享链接');
  const page = await fetchSharePage(url, fetchImpl);
  const text = [input.text?.trim(), `链接：${url}`, page ? `分享页内容：\n${page}` : ''].filter(Boolean).join('\n\n');
  const result = await captureIntake(deps, { text, source: 'url', application_id: input.application_id ?? null });
  return { ...result, fetched: page !== null };
}

// ---------- 手动新建笔试 / 测评 ----------
export interface ManualExamInput { company_name: string; title?: string | null; kind: 'written_test' | 'assessment'; due_at: string; url?: string | null; note?: string | null }

/** 手动新建一场笔试：和收件箱识别出笔试通知走同样的落库（有进行中的同公司投递就挂上去，没有就建一条已投递），再建截止事件。 */
export function recordExam(deps: Pick<IntakeDeps, 'repos' | 'broadcast' | 'sessionId'>, input: ManualExamInput): { deadline_id: string; application_id: string } {
  const r = deps.repos;
  const company = input.company_name.trim();
  if (!company) throw new Error('请填写公司');
  const title = input.title?.trim() || null;
  const hits = r.findOpenApplicationsByCompany(company);
  const existing = hits.length === 1 ? hits[0] : hits.find(a => title && a.job.title === title);
  const label = input.kind === 'assessment' ? '测评' : '笔试';
  const base = existing ?? r.createApplication(r.upsertJob({ source_platform: 'manual', title: title ?? '未命名岗位', company_name: company }).id);
  const app = r.jumpTo(base.id, 'applied', `手动记录${label}`);
  const deadline = r.createDeadline({
    kind: input.kind, title: `${company}${title ? ` · ${title}` : ''} ${label}`, due_at: input.due_at,
    application_id: app.id, job_id: app.job_id, source: 'manual', url: input.url?.trim() || null, note: input.note?.trim() || null,
  });
  dataChanged(deps, ['job', 'application', 'application_history', 'deadline']);
  return { deadline_id: deadline.id, application_id: app.id };
}

// ---------- 小工具 ----------

/** 三方 / 签约通知：和 offer 回复是两个期限（先答复、再签三方），单独记一条，不和回复截止混在一起。 */
const SIGNING_RE = /三方|签约/;
function isSigningNotice(...texts: Array<string | null | undefined>): boolean {
  return texts.some(t => !!t && SIGNING_RE.test(t));
}
