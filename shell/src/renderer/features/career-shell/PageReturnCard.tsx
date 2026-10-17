/**
 * 从页面输入框（PageAskBar）发来的那一轮回复结束后，挂在回复下面的「回到 XX」打破式卡片。
 *
 * 卡片反映这一轮实际做了什么（只看 career 工具，`mcp__career__*`）：
 *  - 状态：有 career 工具失败 / 这一轮出错 → 「出错了」；调过写入类工具 → 「已更新」；只读或纯回答 → 「已回答」；被打断 → 「已中断」。
 *  - 预览（改啥预览啥）：截止日程（加 / 改 / 完成）列出标题和日期；岗位筛选给出个数和条件；
 *    其余写入各一行摘要。什么都没改、也没筛岗位时预览收起，只留回程按钮。
 */
import type { ReactNode } from 'react';

import type { ContentBlock, Message, ToolUseSimple } from '@/types/chat';

import { careerContextSurface } from '../../../shared/systemReminder';
import { BreakoutCard, CountAnchor, DateAnchor, PageAnchor, type BreakoutTone } from './BreakoutCard';
import { dict, inputOf, joinParts, parseResult, str } from './cardContent';
import { requestNavigation } from './navModel';
import { pageLabel, parsePageSurface, type PageTarget } from './pageSurface';

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('\n');
}

function blocksOf(message: Message): ContentBlock[] {
  return typeof message.content === 'string' ? [] : message.content;
}

const CAREER_PREFIX = 'mcp__career__';

export function careerToolName(tool: Pick<ToolUseSimple, 'name'>): string | null {
  return tool.name?.startsWith(CAREER_PREFIX) ? tool.name.slice(CAREER_PREFIX.length) : null;
}

/** 一定会改数据的 career 工具 → 预览里那一行的说法。 */
const WRITE_TOOLS: Record<string, string> = {
  deadline_add: '记了一个时间点',
  deadline_update: '改了一个时间点',
  deadline_done: '标记了一个时间点',
  inbox_capture: '归档了一条收件',
  inbox_dismiss: '忽略了一条收件',
  dossier_note_add: '往卷宗里记了一笔',
  application_set_stage: '推进了投递阶段',
  material_save: '存了一段素材',
  material_use_record: '记了一次说法',
  mail_compose: '起草了一封投递邮件，等你批准',
  mail_sync: '同步了邮箱',
  experience_add: '写入了一段经历',
  claim_confirm: '确认了一条主张',
  ingest_document: '从文档里抽取了经历',
  ingest_repo: '从代码仓库里抽取了经历',
  job_import: '加入了一个岗位',
  jobs_sync: '同步了岗位库',
  jobs_prepare: '把岗位加进了待投清单',
  apply_prepare: '开始填了网申',
  apply_run: '在浏览器里填了表',
  apply_batch: '开始了批量投递',
  apply_continue: '继续了网申',
  greeting_compose: '写了一条招呼语，等你批准',
  resume_master_create: '创建了主简历',
  resume_save: '改了简历',
  resume_confirm: '应用了定制简历的改动',
  question_add: '加了一道题进题库',
  question_attempt: '记了一次作答',
};

/** 看参数决定是查还是改的工具：带了这些字段就是改。 */
const SETTING_TOOLS: Record<string, { label: string; keys: readonly string[] }> = {
  job_prefs: { label: '改了求职条件', keys: ['cohort', 'degree', 'cities', 'employment_types', 'keywords'] },
  apply_auto_mode: { label: '切换了自动投递', keys: ['enabled'] },
  resume_ats: { label: '切换了过机筛模式', keys: ['enabled'] },
};

const DEADLINE_WRITES: ReadonlySet<string> = new Set(['deadline_add', 'deadline_update', 'deadline_done']);

export function isCareerWrite(tool: ToolUseSimple): boolean {
  const name = careerToolName(tool);
  if (!name) return false;
  if (name in WRITE_TOOLS) return true;
  const setting = SETTING_TOOLS[name];
  if (!setting) return false;
  const input = inputOf(tool);
  return setting.keys.some(key => input[key] !== undefined);
}

function writeLabel(tool: ToolUseSimple): string {
  const name = careerToolName(tool) ?? '';
  return WRITE_TOOLS[name] ?? SETTING_TOOLS[name]?.label ?? '改了数据';
}

export interface TurnDeadline { key: string; title: string; dueAt: string | null; done: boolean }
export interface TurnJobs { count: number; filters: string | null }

export interface PageReturnOutcome {
  status: 'error' | 'interrupted' | 'updated' | 'answered';
  deadlines: TurnDeadline[];
  jobs: TurnJobs | null;
  /** 其余写入，一条一行。 */
  writes: string[];
}

const EMPLOYMENT: Record<string, string> = { campus: '校招', intern: '实习', social: '社招' };
const PROGRESS: Record<string, string> = { none: '未投递', active: '进行中', done: '已投出' };

/** 字符串或字符串数组 → 「a / b」。 */
function listText(value: unknown): string | null {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join(' / ') || null;
  return str(value);
}

function jobsFilters(input: Record<string, unknown>): string | null {
  const employment = str(input.employment_type);
  const progress = listText(input.progress);
  return joinParts([
    str(input.q) && `「${str(input.q)}」`,
    listText(input.batch),
    listText(input.industry),
    listText(input.tag),
    listText(input.city),
    employment && (EMPLOYMENT[employment] ?? employment),
    str(input.cohort),
    input.open_only === true && '没截止',
    input.fits_only === true && '符合我条件',
    progress && progress.split(' / ').map(p => PROGRESS[p] ?? p).join(' / '),
  ]);
}

/** jobs_board：个数取结果的 total（符合条件的总数），没有时退回返回的行数；条件取结果回显的 filters，没有时看调用参数。 */
function boardOutcome(tool: ToolUseSimple): TurnJobs {
  const result = parseResult(tool);
  const rows = Array.isArray(result.rows) ? result.rows.length : 0;
  const count = typeof result.total === 'number' ? result.total : typeof result.returned === 'number' ? result.returned : rows;
  return { count, filters: jobsFilters({ ...inputOf(tool), ...(dict(result.filters) ?? {}) }) };
}

function deadlinesOf(tool: ToolUseSimple): TurnDeadline[] {
  const result = parseResult(tool);
  const list = Array.isArray(result.deadlines) ? result.deadlines : [result.deadline];
  return list.map(dict).filter((d): d is Record<string, unknown> => Boolean(d)).map((d, i) => ({
    key: str(d.id) ?? `${tool.id}:${i}`,
    title: str(d.title) ?? '时间点',
    dueAt: str(d.due_at),
    done: d.status === 'done',
  }));
}

/** 一轮（页面发来的用户消息之后的全部助理消息）的结果。纯函数，便于测试。 */
export function pageReturnOutcome(turn: readonly Message[]): PageReturnOutcome {
  const blocks = turn.flatMap(blocksOf);
  const tools = blocks.flatMap(block => (block.tool && careerToolName(block.tool) ? [block.tool] : []));
  const failed = blocks.some(block => block.isFailed) || tools.some(tool => tool.isError || tool.isFailed);
  const interrupted = turn.some(message => message.transcriptState === 'interrupted') || blocks.some(block => block.isStopped || block.tool?.isStopped);
  const settled = tools.filter(tool => !tool.isLoading && !tool.isError && !tool.isFailed && !tool.isStopped);
  const writes = settled.filter(isCareerWrite);

  const deadlines = new Map<string, TurnDeadline>();
  for (const tool of writes) {
    if (!DEADLINE_WRITES.has(careerToolName(tool) ?? '')) continue;
    for (const d of deadlinesOf(tool)) deadlines.set(d.key, d);
  }
  const board = [...settled].reverse().find(tool => careerToolName(tool) === 'jobs_board');
  const jobs = board ? boardOutcome(board) : null;
  // 截止已经逐条列出，不再重复一行「记了一个时间点」；同一句话只留一次。
  const otherWrites = [...new Set(writes.filter(tool => !DEADLINE_WRITES.has(careerToolName(tool) ?? '')).map(writeLabel))];

  return {
    status: failed ? 'error' : interrupted ? 'interrupted' : writes.length > 0 ? 'updated' : 'answered',
    deadlines: [...deadlines.values()],
    jobs,
    writes: otherWrites,
  };
}

export interface PageReturn { target: PageTarget; outcome: PageReturnOutcome }

/**
 * 每一轮「页面发来的用户消息 → 助理回复」里，最后一条助理消息挂一张回程卡片。
 * 返回 助理消息 id → 原页面 + 这一轮的结果。
 */
export function pageReturnTargets(messages: readonly Message[]): Map<string, PageReturn> {
  const out = new Map<string, PageReturn>();
  let pending: PageTarget | null = null;
  let turn: Message[] = [];
  const flush = () => {
    const last = turn[turn.length - 1];
    if (pending && last) out.set(last.id, { target: pending, outcome: pageReturnOutcome(turn) });
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      pending = parsePageSurface(careerContextSurface(textOf(message)));
      turn = [];
    } else if (message.role === 'assistant') {
      turn.push(message);
    }
  }
  flush();
  return out;
}

const STATUS: Record<PageReturnOutcome['status'], { tone: BreakoutTone; text: string; overline: string }> = {
  error: { tone: 'error', text: '出错了', overline: '这一轮没做完，可以在对话里让小芽重试' },
  interrupted: { tone: 'waiting', text: '已中断', overline: '这一轮被打断了，回到页面看看停在哪' },
  updated: { tone: 'running', text: '已更新', overline: '你在这一页提的事，助理已经改好' },
  answered: { tone: 'idle', text: '已回答', overline: '你在这一页问的事，助理已经回答' },
};

function shortDue(value: string | null): string {
  if (!value) return '日期待定';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const PREVIEW_LIMIT = 3;

/** 没有可预览的内容时返回 null，卡片正文整块收起。 */
function previewOf(outcome: PageReturnOutcome): ReactNode {
  const { deadlines, jobs, writes } = outcome;
  if (deadlines.length === 0 && !jobs && writes.length === 0) return null;
  return (
    <div data-testid="career-page-return-preview" className="space-y-1.5">
      {deadlines.length > 0 && (
        <ul className="divide-y divide-[var(--line)]">
          {deadlines.slice(0, PREVIEW_LIMIT).map(d => (
            <li key={d.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1">
              <span className={`truncate ${d.done ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}`}>{d.title}</span>
              <span className="tabular-nums text-[var(--muted)]">{shortDue(d.dueAt)}</span>
            </li>
          ))}
          {deadlines.length > PREVIEW_LIMIT && <li className="py-1 text-xs text-[var(--muted)]">{`还有 ${deadlines.length - PREVIEW_LIMIT} 个`}</li>}
        </ul>
      )}
      {jobs && <p>{jobs.filters ? `按「${jobs.filters}」筛出 ${jobs.count} 个岗位` : `筛出 ${jobs.count} 个岗位`}</p>}
      {writes.slice(0, PREVIEW_LIMIT).map(line => <p key={line}>{line}</p>)}
    </div>
  );
}

function anchorFor(outcome: PageReturnOutcome): ReactNode {
  if (outcome.status !== 'error' && outcome.deadlines.length > 0) return <DateAnchor value={outcome.deadlines[0].dueAt} />;
  if (outcome.status !== 'error' && outcome.jobs) return <CountAnchor value={outcome.jobs.count} unit="个岗位" />;
  return <PageAnchor />;
}

export function PageReturnCard({ target, outcome }: PageReturn) {
  const label = pageLabel(target);
  const status = STATUS[outcome.status];
  return (
    <div className="px-4 py-1">
      <BreakoutCard
        testId="career-page-return-card"
        anchor={anchorFor(outcome)}
        title={label}
        overline={status.overline}
        status={{ tone: status.tone, text: status.text }}
        action={{ label: `回到${label}`, onOpen: () => requestNavigation(target) }}
      >
        {previewOf(outcome)}
      </BreakoutCard>
    </div>
  );
}
