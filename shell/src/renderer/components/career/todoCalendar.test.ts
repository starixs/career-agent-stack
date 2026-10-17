import { describe, expect, it } from 'vitest';

import { buildTodos, categoryOf, dateKeyOf, groupByDate, localDateKey, mergeCompleted, monthGrid, summarizeDay } from './todoCalendar';
import type { ActionQueueItem, ActivityEntry, Deadline, TodayItem } from './types';

const NOW = new Date(2026, 9, 13, 9, 0);

function deadline(over: Partial<Deadline>): Deadline {
  return {
    id: 'd', kind: 'assessment', title: '测评', due_at: '2026-10-20T18:00:00', application_id: null, job_id: null, interview_id: null, offer_id: null,
    source: 'chat', status: 'open', url: null, note: null, created_at: '2026-10-01T09:00:00', updated_at: '2026-10-01T09:00:00', ...over,
  };
}
function action(over: Partial<ActionQueueItem>): ActionQueueItem {
  return { id: 'act', application_id: null, kind: 'send_mail', payload_json: '{}', status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-10T10:00:00', updated_at: '2026-10-10T10:00:00', ...over };
}

describe('todoCalendar', () => {
  it('maps today kinds to the three categories', () => {
    expect(categoryOf('review')).toBe('review');
    expect(categoryOf('handoff')).toBe('handoff');
    for (const kind of ['deadline', 'interview_today', 'stale', 'inbox', 'followup'] as const) expect(categoryOf(kind)).toBe('remind');
  });

  it('reads date-only strings literally and ISO strings in local time', () => {
    expect(dateKeyOf('2026-10-20')).toBe('2026-10-20');
    expect(dateKeyOf('2026-10-20T18:00:00')).toBe('2026-10-20');
    expect(dateKeyOf('nope')).toBeNull();
    expect(dateKeyOf(null)).toBeNull();
  });

  it('places deadlines on their due date, carries unfinished past items to today, keeps done ones in place', () => {
    const today: TodayItem[] = [
      { kind: 'review', priority: 2, title: '待你批准：发送投递邮件', ref: { type: 'action', id: 'act1' } },
      { kind: 'handoff', priority: 3, title: '需要你本人处理：验证码', ref: { type: 'handoff', id: 'h1' } },
      { kind: 'stale', priority: 6, title: '丙公司 已静默 14 天', ref: { type: 'application', id: 'a1' } },
      // 截止以 deadlines 列表为准，今日队列里的同一条不重复
      { kind: 'deadline', priority: 1, title: '乙公司测评', due_at: '2026-10-13T18:00:00', ref: { type: 'application', id: 'a2' } },
    ];
    const deadlines = [
      deadline({ id: 'future', title: '乙公司测评', due_at: '2026-10-20T18:00:00' }),
      deadline({ id: 'overdue', title: '过期的笔试', due_at: '2026-10-05T18:00:00', status: 'missed' }),
      deadline({ id: 'done', title: '做完的面试', kind: 'interview', due_at: '2026-10-08T10:00:00', status: 'done' }),
      deadline({ id: 'cancel', title: '取消的', status: 'cancelled' }),
      deadline({ id: 'iv', title: '今天的面试', kind: 'interview', due_at: '2026-10-13T15:00:00' }),
    ];
    const activity: ActivityEntry[] = [{ id: 'action:old', at: '2026-10-11T12:00:00', kind: 'action', status: 'done', title: '发送投递邮件 · 甲公司', detail: null }];
    const todos = buildTodos({ today, pending: [action({ id: 'act1' })], deadlines, activity, now: NOW });
    const byKey = new Map(todos.map(t => [t.key, t]));

    expect(byKey.get('deadline:future')).toMatchObject({ date: '2026-10-20', category: 'remind', done: false });
    expect(byKey.get('deadline:overdue')).toMatchObject({ date: '2026-10-13', originDate: '2026-10-05', done: false });
    expect(byKey.get('deadline:done')).toMatchObject({ date: '2026-10-08', done: true });
    expect(byKey.has('deadline:cancel')).toBe(false);
    expect(byKey.get('deadline:iv')?.item.kind).toBe('interview_today');
    expect(byKey.has('application:a2')).toBe(false);
    // 待批准按创建日期定位，没做完 → 顺延到今天
    expect(byKey.get('action:act1')).toMatchObject({ category: 'review', date: '2026-10-13', originDate: '2026-10-10' });
    expect(byKey.get('handoff:h1')).toMatchObject({ category: 'handoff', date: '2026-10-13' });
    expect(byKey.get('application:a1')).toMatchObject({ category: 'remind', date: '2026-10-13' });
    // 活动里执行过的动作：已完成的待批准，放在发生那天
    expect(byKey.get('action:old')).toMatchObject({ category: 'review', date: '2026-10-11', done: true });
  });

  it('falls back to today-queue deadlines when the deadline list is unavailable', () => {
    const today: TodayItem[] = [{ kind: 'deadline', priority: 1, title: '乙公司测评', due_at: '2026-10-14T18:00:00', ref: { type: 'deadline', id: 'd1' } }];
    expect(buildTodos({ today, deadlines: null, now: NOW })).toMatchObject([{ key: 'deadline:d1', date: '2026-10-14' }]);
  });

  it('summarizes a day: first item per category, extra count, lit only while something is unfinished', () => {
    const todos = buildTodos({
      deadlines: [
        deadline({ id: 'a', title: 'A', due_at: '2026-10-20T09:00:00' }),
        deadline({ id: 'b', title: 'B', due_at: '2026-10-20T10:00:00' }),
        deadline({ id: 'c', title: 'C', due_at: '2026-10-20T11:00:00' }),
      ],
      now: NOW,
    });
    const [remind] = summarizeDay(groupByDate(todos).get('2026-10-20')!);
    expect(remind).toMatchObject({ category: 'remind', count: 3, lit: true });
    expect(remind.first.item.title).toBe('A');

    const allDone = mergeCompleted(todos, new Map(todos.map(t => [t.key, { ...t, done: true }])));
    expect(summarizeDay(allDone)[0].lit).toBe(false);
  });

  it('local completions override server data and stay on the day they were shown', () => {
    const [todo] = buildTodos({ today: [{ kind: 'review', priority: 2, title: '批准', ref: { type: 'action', id: 'x' } }], now: NOW });
    // 服务端刷新后这条已不在待批准里
    const merged = mergeCompleted([], new Map([[todo.key, { ...todo, done: true, note: '已批准' }]]));
    expect(merged).toMatchObject([{ key: 'action:x', date: '2026-10-13', done: true, note: '已批准' }]);
  });

  it('builds a fixed 6-week grid starting on Monday', () => {
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(42);
    expect(grid[0].getDay()).toBe(1);
    expect(localDateKey(grid[0])).toBe('2026-09-28');
    expect(grid.some(d => localDateKey(d) === '2026-10-31')).toBe(true);
  });
});

describe('buildTodos · needs_user 动作', () => {
  const base = { application_id: null, payload_json: '{}', result_json: null, reviewed_at: null, created_at: '2026-10-03T08:00:00', updated_at: '2026-10-03T09:00:00' };
  it('submit 等你确认；招呼语 / 开放题等你发出去；其余不放', () => {
    const todos = buildTodos({
      now: new Date(2026, 9, 3, 12),
      confirming: [
        { ...base, id: 's1', kind: 'submit', status: 'needs_user' },
        { ...base, id: 'g1', kind: 'send_greeting', status: 'needs_user' },
        { ...base, id: 'q1', kind: 'answer_open_q', status: 'needs_user' },
        { ...base, id: 'f1', kind: 'fill_form', status: 'needs_user' },
      ],
    });
    expect(todos.map(t => [t.key, t.category, Boolean(t.confirmSubmit), Boolean(t.manualSend)])).toEqual([
      ['confirm:s1', 'handoff', true, false],
      ['manual:g1', 'handoff', false, true],
      ['manual:q1', 'handoff', false, true],
    ]);
  });
});
