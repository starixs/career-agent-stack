/**
 * 招聘概览的月历数据：把今日队列 / 待批准 / 截止 / 活动记录放到日期上，并按三类待办汇总。
 * 纯函数，页面只负责取数和渲染；规则见 CareerToday.tsx 顶部注释。
 */
import { isManualSend } from './manualSendActions';
import type { ActionQueueItem, ActivityEntry, Deadline, TodayItem, TodayItemKind } from './types';

/** 三类待办：待批准 / 需要你处理 / 提醒（截止与其余一切）。 */
export type TodoCategory = 'review' | 'handoff' | 'remind';
export const TODO_CATEGORIES: readonly TodoCategory[] = ['review', 'handoff', 'remind'];
export const CATEGORY_LABELS: Record<TodoCategory, string> = { review: '待批准', handoff: '需要你处理', remind: '提醒' };
/** 点亮时的颜色；全部完成后统一变灰（--line-2）。 */
export const CATEGORY_COLORS: Record<TodoCategory, string> = { review: 'var(--primary)', handoff: 'var(--warning)', remind: 'var(--info)' };

export function categoryOf(kind: TodayItemKind): TodoCategory {
  if (kind === 'review') return 'review';
  if (kind === 'handoff') return 'handoff';
  return 'remind';
}

export interface CalendarTodo {
  /** `${ref.type}:${ref.id}`，与活动记录的 id（action:xxx）对齐，用来去重。 */
  key: string;
  category: TodoCategory;
  /** 本地日期 YYYY-MM-DD：放在月历的哪一天。 */
  date: string;
  /** 原始日期（到期 / 创建），未完成的过去项顺延到今天时用来提示「从哪天起」。 */
  originDate: string | null;
  done: boolean;
  item: TodayItem;
  action?: ActionQueueItem;
  /** 截止关联的投递，用来打开卷宗。 */
  applicationId?: string | null;
  /** 等你确认投递结果（submit 动作 status=needs_user）。 */
  confirmSubmit?: boolean;
  /** 已批准、等你自己发出去的招呼语 / 开放题回答（status=needs_user），行里摆原文和「复制」。 */
  manualSend?: boolean;
  /** 本地划掉时记下怎么处理的（已批准 / 不发了 / 已完成…）。 */
  note?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日期键 YYYY-MM-DD。 */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO / 日期字符串 → 本地日期键；解析失败返回 null。只有日期（无时间）时按字面取，避免时区偏移一天。 */
export function dateKeyOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : localDateKey(t);
}

export interface TodoSources {
  today?: TodayItem[] | null;
  pending?: ActionQueueItem[] | null;
  /** status=needs_user 的动作：submit 等你确认结果；send_greeting / answer_open_q 等你自己发出去；其余不放。 */
  confirming?: ActionQueueItem[] | null;
  deadlines?: Deadline[] | null;
  activity?: ActivityEntry[] | null;
  now?: Date;
}

/**
 * 放置规则：
 * - 截止按 due_at 放；完成的留在原日期，取消的不显示。
 * - 待批准、等你确认、交接、静默、收件箱这类「现在就该处理」的项放在今天。
 * - 未完成且日期已过的一律顺延到今天（像纸面待办一样往后抄），originDate 记下原日期。
 * - 活动记录里已执行的动作作为已完成的「待批准」放回它发生的那天。
 */
export function buildTodos(src: TodoSources): CalendarTodo[] {
  const now = src.now ?? new Date();
  const todayKey = localDateKey(now);
  const place = (origin: string | null, done: boolean) => {
    const date = origin ?? todayKey;
    return !done && date < todayKey ? todayKey : date;
  };
  const out = new Map<string, CalendarTodo>();
  const add = (todo: CalendarTodo) => { if (!out.has(todo.key)) out.set(todo.key, todo); };
  const actionById = new Map((src.pending ?? []).map(a => [a.id, a]));
  // 截止的权威来源是 deadlines 列表（含已完成）；拿不到时退回今日队列里的截止项。
  const haveDeadlines = Array.isArray(src.deadlines);

  for (const d of src.deadlines ?? []) {
    if (d.status === 'cancelled') continue;
    const done = d.status === 'done';
    const origin = dateKeyOf(d.due_at);
    const item: TodayItem = {
      kind: d.kind === 'interview' && origin === todayKey ? 'interview_today' : 'deadline',
      priority: 1, title: d.title, due_at: d.due_at, ref: { type: 'deadline', id: d.id },
    };
    add({ key: `deadline:${d.id}`, category: 'remind', date: place(origin, done), originDate: origin, done, item, applicationId: d.application_id });
  }

  for (const item of src.today ?? []) {
    if (haveDeadlines && (item.kind === 'deadline' || item.kind === 'interview_today')) continue;
    const action = item.kind === 'review' ? actionById.get(item.ref.id) : undefined;
    const origin = dateKeyOf(item.due_at) ?? dateKeyOf(action?.created_at);
    add({ key: `${item.ref.type}:${item.ref.id}`, category: categoryOf(item.kind), date: place(origin, false), originDate: origin, done: false, item, action });
  }

  for (const a of src.confirming ?? []) {
    const origin = dateKeyOf(a.updated_at);
    if (isManualSend(a)) {
      add({
        key: `manual:${a.id}`, category: 'handoff', date: place(origin, false), originDate: origin, done: false, manualSend: true, action: a,
        item: { kind: 'handoff', priority: 3, title: a.kind === 'send_greeting' ? '等你发出去：招呼语' : '等你发出去：开放题回答', detail: '已批准，复制下面的文字到平台上发', ref: { type: 'action', id: a.id } },
      });
      continue;
    }
    if (a.kind !== 'submit') continue;
    add({
      key: `confirm:${a.id}`, category: 'handoff', date: place(origin, false), originDate: origin, done: false, confirmSubmit: true, action: a,
      item: { kind: 'handoff', priority: 3, title: '等你确认：这条投递交出去了吗', detail: '提交结果不确定，请到页面上看一下', ref: { type: 'action', id: a.id } },
    });
  }

  for (const e of src.activity ?? []) {
    if (e.kind !== 'action' || (e.status !== 'done' && e.status !== 'executing')) continue;
    const date = dateKeyOf(e.at) ?? todayKey;
    const id = e.id.replace(/^action:/, '');
    add({ key: `action:${id}`, category: 'review', date, originDate: date, done: true, item: { kind: 'review', priority: 2, title: e.title, ref: { type: 'action', id } } });
  }

  return [...out.values()];
}

/** 用本地完成记录覆盖服务端数据：刚划掉的项留在原来那天，保持已完成样式。 */
export function mergeCompleted(todos: CalendarTodo[], completed: ReadonlyMap<string, CalendarTodo>): CalendarTodo[] {
  if (completed.size === 0) return todos;
  const merged = todos.map(t => completed.get(t.key) ?? t);
  const seen = new Set(merged.map(t => t.key));
  for (const [key, todo] of completed) if (!seen.has(key)) merged.push(todo);
  return merged;
}

export function groupByDate(todos: CalendarTodo[]): Map<string, CalendarTodo[]> {
  const map = new Map<string, CalendarTodo[]>();
  for (const t of todos) {
    const list = map.get(t.date);
    if (list) list.push(t); else map.set(t.date, [t]);
  }
  return map;
}

export interface CategorySummary {
  category: TodoCategory;
  /** 第一条：优先未完成的。 */
  first: CalendarTodo;
  count: number;
  /** 还有未完成项 → 圆点点亮。 */
  lit: boolean;
}

/** 某一天每类的摘要（固定顺序，只返回有内容的类）。 */
export function summarizeDay(todos: readonly CalendarTodo[]): CategorySummary[] {
  const result: CategorySummary[] = [];
  for (const category of TODO_CATEGORIES) {
    const list = todos.filter(t => t.category === category);
    if (list.length === 0) continue;
    const open = list.filter(t => !t.done);
    result.push({ category, first: open[0] ?? list[0], count: list.length, lit: open.length > 0 });
  }
  return result;
}

/** 月历的 6 周 × 7 天（周一开头），固定 42 格，翻月时版面不跳。 */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
}
