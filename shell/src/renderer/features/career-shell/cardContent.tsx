/**
 * 打破式卡片的内容：每种对象从自己的 tool 返回字段拼出「视觉锚 + 名称 + 标注 + 正文 + 键值行」。
 *
 * 字段一律按「有就显示、没有就收起」读取。标了「待后端」的字段是设计稿要用、
 * 但当前 tool 还没返回的（字段表见 specs/CAREER_DESIGN.md §5.7.1），后端补上后这里不用再改。
 */
import type { ReactNode } from 'react';

import type { CareerCard, ExamPractice } from '@/components/career/types';
import type { ToolUseSimple } from '@/types/chat';

import { CountAnchor, DateAnchor, InitialAnchor, PageAnchor, RailAnchor, type BreakoutRow, type RailState } from './BreakoutCard';
import type { PageTarget } from './pageSurface';

export interface CardContent {
  anchor: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  overline?: ReactNode;
  body?: ReactNode;
  rows?: BreakoutRow[];
}

type Dict = Record<string, unknown>;

// ─── 读字段的小工具 ───

export function parseResult(tool: Pick<ToolUseSimple, 'result'>): Dict {
  if (!tool.result) return {};
  try {
    const parsed = JSON.parse(tool.result) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Dict : {};
  } catch {
    return {};
  }
}

export function inputOf(tool: ToolUseSimple): Dict {
  return (tool.parsedInput ?? {}) as Dict;
}

export function dict(value: unknown): Dict | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
  return list(value).map(str).filter((s): s is string => Boolean(s));
}

/** 数组取长度，数字原样；都不是返回 null（这一项就不显示）。 */
function count(value: unknown): number | null {
  return Array.isArray(value) ? value.length : num(value);
}

export function joinParts(parts: ReadonlyArray<string | null | undefined | false>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length ? kept.join(' · ') : null;
}

function counted(label: string, value: unknown): string | null {
  const n = count(value);
  return n === null ? null : `${label} ${n}`;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** 私密库占位符 → 明文。卡片是本地界面，可以显示本人信息；没有对照表时占位符本身不显示。 */
export type Reveal = (value: unknown) => string | null;

export function makeReveal(preview: Readonly<Record<string, string>> | null | undefined): Reveal {
  return (value) => {
    const s = str(value);
    if (!s) return null;
    if (!s.includes('{{vault:')) return s;
    const resolved = s.replace(/\{\{vault:[^}]+\}\}/g, token => preview?.[token] ?? '');
    return resolved.trim() ? resolved : null;
  };
}

function shortDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── 档案型 / 修订型：简历 ───

export function resumeContent(tool: ToolUseSimple, diffCard: CareerCard | undefined, reveal: Reveal): CardContent {
  const result = parseResult(tool);
  if (diffCard) {
    const data = diffCard.data;
    const ops = list(data.ops).map(dict).filter((op): op is Dict => Boolean(op));
    const sample = ops.find(op => str(op.value));
    const tally = (kind: string, label: string) => {
      const n = ops.filter(op => op.op === kind).length;
      return n > 0 ? `${label} ${n}` : null;
    };
    const unresolved = count(data.unresolved) ?? 0;
    const jobTitle = str(data.job_title) ?? /「(.+?)」/.exec(diffCard.title)?.[1] ?? null; // job_title：待后端
    return {
      anchor: <CountAnchor value={ops.length} unit="处修改" />,
      title: str(data.company) ?? jobTitle ?? '定制简历', // company：待后端
      aside: str(data.company) ? jobTitle : null,
      overline: '按 JD 定制 · 基于主简历',
      body: sample && (
        <div className="rounded-[4px] bg-[var(--inset)] px-3 py-2">
          {str(sample.old_value) && <div className="line-clamp-1 text-[var(--subtle)] line-through">{reveal(sample.old_value)}</div>}{/* old_value：待后端 */}
          <div className="line-clamp-2 text-[var(--ink)]">{reveal(sample.value)}</div>
          {str(sample.reason) && <div className="mt-1 line-clamp-1 text-xs text-[var(--muted)]">{str(sample.reason)}</div>}
        </div>
      ),
      rows: [
        { label: '改动', value: joinParts([tally('replace', '重写'), tally('add', '新增'), tally('remove', '删除')]) },
        { label: '待定', value: unresolved > 0 ? `${unresolved} 处要你拍板` : null },
      ],
    };
  }

  const master = dict(result.master);
  if (master) {
    const candidate = reveal(master.candidate);
    const missing = count(result.missing) ?? 0;
    return {
      anchor: candidate ? <InitialAnchor text={candidate} /> : <PageAnchor />,
      title: candidate ?? str(master.name) ?? '主简历',
      aside: candidate ? joinParts([str(master.name), str(master.direction)]) : str(master.direction),
      overline: joinParts([str(master.school), str(master.degree), str(master.graduation)]), // school / degree / graduation：待后端
      body: str(result.notes) && <p className="line-clamp-2">{str(result.notes)}</p>,
      rows: [
        { label: '经历', value: joinParts([counted('教育', master.education), counted('经历', master.experience), counted('项目', master.projects), counted('技能', master.skills), counted('奖项', master.awards)]) }, // skills / awards：待后端
        { label: '意向', value: reveal(master.objective) },
        { label: '待补', value: missing > 0 ? `还缺 ${missing} 项信息` : null },
      ],
    };
  }

  const resume = dict(result.resume);
  if (resume) {
    const basics = dict(resume.basics) ?? {};
    const education = list(resume.education).map(dict).filter((e): e is Dict => Boolean(e));
    const first = education[0];
    const candidate = reveal(basics.name);
    const applied = num(result.applied_ops);
    return {
      anchor: candidate ? <InitialAnchor text={candidate} /> : <PageAnchor />,
      title: candidate ?? (result.kind === 'tailored' ? '定制简历' : '主简历'),
      aside: joinParts([candidate ? (result.kind === 'tailored' ? '定制简历' : '主简历') : null, '已保存']),
      overline: first ? joinParts([str(first.school) ?? str(first.institution), str(first.degree), str(first.major) ?? str(first.area)]) : null,
      rows: [
        { label: '改动', value: applied === null ? '整份更新' : `改了 ${applied} 处` },
        { label: '经历', value: joinParts([counted('教育', resume.education), counted('经历', resume.experience), counted('项目', resume.projects), counted('技能', resume.skills), counted('奖项', resume.awards)]) },
        { label: '意向', value: reveal(basics.objective) },
      ],
    };
  }
  return { anchor: <PageAnchor />, title: '改简历' };
}

// ─── 题目型：模拟面试 ───

const VERDICT_LABEL: Record<string, string> = { pass: '这次模拟能过', borderline: '在边缘', fail: '这次没过' };
const DEFAULT_STAGES = ['开场', '追问', '复盘'];

export function pendingQuestion(tool: ToolUseSimple): string | null {
  if (inputOf(tool).finish === true) return null;
  const outcome = parseResult(tool).result as Dict | string | undefined;
  if (!outcome) return null;
  if (typeof outcome === 'string') return outcome;
  return str(outcome.question) ?? str(outcome.next_question) ?? str(outcome.follow_up) ?? str(outcome.followup) ?? null;
}

/**
 * 轨道阶段：后端给了 stages（这场面试的计划）和 stage（当前阶段）就照它画——待后端；
 * 没给时退回「开场 / 追问 / 复盘」，由有没有 transcript、是否 finish 推出当前阶段。
 */
function interviewStages(outcome: Dict | null, input: Dict): Array<{ label: string; state: RailState }> {
  const finished = input.finish === true;
  const planned = strings(outcome?.stages);
  const labels = planned.length ? planned : DEFAULT_STAGES;
  const current = str(outcome?.stage) ?? (finished ? labels[labels.length - 1] : str(input.transcript) ? labels[Math.min(1, labels.length - 1)] : labels[0]);
  const at = Math.max(0, labels.indexOf(current));
  return labels.map((label, i) => ({ label, state: finished || i < at ? 'done' : i === at ? 'current' : 'todo' }));
}

export function mockInterviewContent(tool: ToolUseSimple): CardContent {
  const input = inputOf(tool);
  const raw = parseResult(tool).result;
  const outcome = dict(raw);
  const question = pendingQuestion(tool);
  const verdict = str(outcome?.verdict);
  const todo = count(outcome?.todo) ?? 0;
  const index = num(outcome?.question_index); // question_index / question_total：待后端
  const total = num(outcome?.question_total);
  const quote = str(outcome?.quote); // quote：用户上一句原话，待后端
  return {
    anchor: <RailAnchor stages={interviewStages(outcome, input)} />,
    title: index !== null ? `第 ${index} 题` : '模拟面试',
    aside: joinParts([str(outcome?.company) ?? str(input.company_type), str(outcome?.job_title), str(input.round)]), // company / job_title：待后端
    overline: total !== null ? `共 ${total} 题` : null,
    body: question ? (
      <>
        {quote && <div className="mb-2.5 border-l-2 border-[var(--line-2)] pl-2.5 text-xs leading-relaxed text-[var(--muted)]">你刚才说：「{quote}」</div>}
        <p className="font-human text-lg leading-relaxed text-[var(--ink)]">{question}</p>
        <div className="mt-3 flex items-center gap-2.5 text-sm text-[var(--warning)]">
          <span>在下面输入框里回答；想结束就说「结束并复盘」</span>
          <span aria-hidden="true" className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--line-2)_0_4px,transparent_4px_8px)]" />
        </div>
      </>
    ) : undefined,
    rows: [
      { label: '考点', value: joinParts(strings(outcome?.focus)) }, // focus：待后端
      { label: '结论', value: verdict ? (VERDICT_LABEL[verdict] ?? verdict) : null },
      { label: '要补', value: todo > 0 ? `${todo} 件事` : null },
    ],
  };
}

// ─── 题目型：笔试 ───

export function examContent(tool: ToolUseSimple, exam: ExamPractice | null): Omit<CardContent, 'anchor'> & { done: number; total: number } {
  const result = parseResult(tool);
  const input = inputOf(tool);
  const questions = parseJson<Array<{ q?: string }>>(exam?.questions_json, []);
  const answers = parseJson<Array<{ index: number }>>(exam?.answers_json, []);
  const reviews = parseJson<Array<{ verdict?: string }>>(exam?.review_json, []);
  const total = num(result.questions) ?? questions.length;
  const done = num(result.answered) ?? answers.length;
  const answered = new Set(answers.map(a => a.index));
  const nextIndex = questions.findIndex((_, i) => !answered.has(i));
  const next = exam?.status === 'answering' && nextIndex >= 0 ? str(questions[nextIndex]?.q) : null;
  const correct = reviews.filter(review => review.verdict === '对').length;
  return {
    done,
    total,
    title: exam?.title ?? str(input.title) ?? '笔试练习',
    aside: exam?.kind ?? str(input.kind),
    overline: exam?.company_name ?? str(input.company_name),
    body: next && <p className="line-clamp-2">第 {nextIndex + 1} 题：{next}</p>,
    rows: [
      { label: '限时', value: num(result.time_limit_min) !== null ? `${num(result.time_limit_min)} 分钟` : null }, // time_limit_min：待后端
      { label: '用时', value: num(result.elapsed_min) !== null ? `已用 ${num(result.elapsed_min)} 分钟` : null }, // elapsed_min：待后端
      { label: '来源', value: str(result.source) }, // source：待后端
      { label: '批改', value: exam?.status === 'reviewed' && reviews.length ? `对 ${correct} / ${total}` : null },
    ],
  };
}

// ─── 不开工作面的信息卡：对象 / 清单 / 时间 / 文件 ───

export interface InfoCardSpec {
  content: CardContent;
  status: string;
  openLabel: string;
  target: PageTarget;
}

const JOB_BOARD: PageTarget = { kind: 'career-dossier', view: 'apply' };
const OVERVIEW: PageTarget = { kind: 'career-today' };

/** 对象型：一家公司 / 一个岗位。 */
function entityContent(result: Dict, input: Dict): CardContent | null {
  const job = dict(result.job) ?? null;
  const company = dict(result.company) ?? null;
  const evaluation = dict(result.evaluation) ?? null;
  const parsed = dict(result.parsed) ?? dict(result.jd) ?? null;
  const name = str(job?.company_name) ?? str(parsed?.company) ?? str(company?.legal_name) ?? str(result.company_name) ?? str(input.company_name) ?? str(input.company);
  if (!name) return null;
  const title = str(job?.title) ?? str(parsed?.title) ?? str(result.title);
  const tags = strings(result.type_tags ?? job?.type_tags); // type_tags（央企 / 外企…）：待后端
  const score = num(evaluation?.score) ?? num(job?.match_score) ?? num(result.match_score);
  return {
    anchor: <InitialAnchor text={name} solid />,
    title: name,
    aside: joinParts([tags.length ? tags.join(' / ') : null, title]),
    overline: joinParts([str(result.industry), strings(job?.location ?? parsed?.location).join(' / ') || null, str(job?.cohort) ?? str(parsed?.cohort) ?? str(result.batch)]), // industry / batch：待后端
    body: str(evaluation?.summary) ?? str(result.summary) ? <p className="line-clamp-2">{str(evaluation?.summary) ?? str(result.summary)}</p> : undefined,
    rows: [
      { label: '截止', value: str(job?.deadline) ?? str(parsed?.deadline) },
      { label: '匹配', value: score !== null ? `${Math.round(score)} 分` : null },
      { label: '红绿灯', value: str(company?.traffic_light) },
    ],
  };
}

/** 清单型：一批岗位。 */
function listContent(result: Dict, unit: string): CardContent {
  const rows = list(result.rows).map(dict).filter((r): r is Dict => Boolean(r));
  const n = rows.length || (num(result.stored) ?? num(result.fetched) ?? 0);
  return {
    anchor: <CountAnchor value={n} unit={unit} />,
    title: str(result.title) ?? (rows.length ? '岗位清单' : '岗位库已同步'),
    overline: rows.length ? null : joinParts([counted('拉到', result.fetched), counted('入库', result.stored), counted('重算匹配', result.matched)]),
    body: rows.length ? (
      <ul className="divide-y divide-[var(--line)]">
        {rows.slice(0, 3).map((row, i) => (
          <li key={str(row.job_id) ?? i} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 py-1.5">
            <span className="truncate text-[var(--ink)]">{joinParts([str(row.company), str(row.title)])}</span>
            <span className="text-[var(--muted)]">{str(row.location)}</span>
            <span className="tabular-nums text-[var(--muted)]">{shortDate(row.deadline) ? `${shortDate(row.deadline)} 截止` : ''}</span>
          </li>
        ))}
      </ul>
    ) : undefined,
    rows: [{ label: '还有', value: rows.length > 3 ? `${rows.length - 3} 个，在岗位收藏里看全部` : null }],
  };
}

/** 时间型：一个截止 / 日程。 */
function deadlineContent(result: Dict): CardContent | null {
  const deadline = dict(result.deadline);
  if (!deadline) return null;
  const due = str(deadline.due_at);
  return {
    anchor: <DateAnchor value={due} />,
    title: str(deadline.title) ?? '截止',
    aside: str(result.company_name), // company_name：待后端
    overline: deadline.status === 'done' ? '已完成' : '已加进招聘概览',
    rows: [
      { label: '提醒', value: str(result.remind) }, // remind：待后端
      { label: '同一天', value: num(result.same_day) ? `还有 ${num(result.same_day)} 件事` : null }, // same_day：待后端
    ],
  };
}

/** 文件型：导出的简历。 */
function fileContent(result: Dict, input: Dict): CardContent | null {
  const path = str(result.path);
  if (!path) return null;
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    anchor: <PageAnchor />,
    title: name,
    overline: joinParts([str(input.format)?.toUpperCase(), num(result.pages) !== null ? `${num(result.pages)} 页` : null]), // pages：待后端
    rows: [{ label: 'ATS', value: result.ats_ok === true ? '解析检查通过' : result.ats_ok === false ? '有内容读不出来' : null }], // ats_ok：待后端
  };
}

const INFO_TOOLS = new Set(['company_research', 'jd_parse', 'job_import', 'job_evaluate', 'jobs_board', 'jobs_sync', 'deadline_add', 'deadline_done', 'resume_export']);

export function isInfoCardTool(name: string | undefined): boolean {
  return Boolean(name && INFO_TOOLS.has(name.replace(/^mcp__career__/, '')));
}

/** 没有可用字段（比如还在跑、出错）时返回 null，对话里只留原来的工具行。 */
export function infoCardFor(tool: ToolUseSimple): InfoCardSpec | null {
  if (tool.isLoading || tool.isError || tool.isFailed) return null;
  const bare = tool.name.replace(/^mcp__career__/, '');
  const result = parseResult(tool);
  const input = inputOf(tool);
  switch (bare) {
    case 'company_research': case 'jd_parse': case 'job_import': case 'job_evaluate': {
      const content = entityContent(result, input);
      return content && { content, status: bare === 'company_research' ? '已查完' : bare === 'job_evaluate' ? '已评估' : '已记下', openLabel: '在岗位收藏里看', target: JOB_BOARD };
    }
    case 'jobs_board':
      return { content: listContent(result, '个岗位'), status: '已筛好', openLabel: '打开岗位收藏', target: JOB_BOARD };
    case 'jobs_sync':
      return { content: listContent(result, '个新岗位'), status: '已同步', openLabel: '打开岗位收藏', target: JOB_BOARD };
    case 'deadline_add': case 'deadline_done': {
      const content = deadlineContent(result);
      return content && { content, status: bare === 'deadline_done' ? '已完成' : '已记下', openLabel: '在招聘概览中查看', target: OVERVIEW };
    }
    case 'resume_export': {
      const content = fileContent(result, input);
      return content && { content, status: '已导出', openLabel: '打开简历', target: { kind: 'career-material', view: 'resume' } };
    }
    default:
      return null;
  }
}
