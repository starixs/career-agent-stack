/**
 * 网申现场第一次打开、还没有任何网申在跑时的样子：不是一个黑框加一句「浏览器还没有打开」，
 * 而是把小芽投的时候这一栏会长成什么样，用示例内容原样摆出来——标签条、正在填的那一页、链路和格子。
 * 整块标一次「示例」，不可点；有了真的网申页面就整块换掉（UI 检查点第 6 条，2026-11-06）。
 * 示例里的公司是编的，不用真公司名。
 */
import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { LivePageTabs, type LivePage } from './LivePageTabs';
import { TaskProgressPanel } from './TaskProgressPanel';

const SAMPLE_PAGES: readonly LivePage[] = [
  { application_id: 'sample-1', company: '星河科技', title: '产品经理（2027 届）', current: true, waiting: null },
  { application_id: 'sample-2', company: '北辰游戏', title: '游戏运营', current: false, waiting: 'login' },
  { application_id: 'sample-3', company: '青禾数据', title: '数据分析', current: false, waiting: null },
];
const sampleRun = (applicationId: string, extra: Partial<ProgressRun>): ProgressRun => ({
  key: `run_${applicationId}`, steps: [{ message: '正在填', phase: 'apply_batch', at: 0 }], progress: null, finished: false, updatedAt: 0, applicationId, ...extra,
});
const SAMPLE_RUNS: readonly ProgressRun[] = [
  sampleRun('sample-1', { stage: 'fill', kind: 'field', cells: { total: 24, done: 13, you: 0 } }),
  sampleRun('sample-3', { finished: true, ready: true, stage: 'review' }),
];
/** 示意的申请表有几行；前几行填好了，下一行正在填。 */
const FORM_ROWS = [{ label: 'w-10', filled: 'w-24' }, { label: 'w-14', filled: 'w-40' }, { label: 'w-12', filled: 'w-32' }, { label: 'w-16', filled: null }, { label: 'w-10', filled: null }] as const;
const noop = () => {};

/** 一页正在被填的申请表的示意：标题条 + 几行「格子名 + 输入框」，填好的框里有字块，正在填的那一格有光标。 */
function SampleForm() {
  const next = FORM_ROWS.findIndex(r => !r.filled);
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-[var(--paper)] shadow-md">
      <div className="h-8 border-b border-[var(--line)] bg-[var(--inset)]" />
      <div className="mx-auto flex max-w-sm flex-col gap-3 px-6 py-5">
        {FORM_ROWS.map((row, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className={`h-2 rounded-full bg-[var(--line-2)] ${row.label}`} />
            <span className={`flex h-8 items-center rounded-md border px-2.5 ${i === next ? 'border-[var(--primary)]' : 'border-[var(--line-2)]'}`}>
              {row.filled && <span className={`h-2 rounded-full bg-[var(--ink-2)] ${row.filled}`} />}
              {i === next && <span className="h-4 w-0.5 bg-[var(--primary)] motion-safe:animate-pulse" />}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LiveSample() {
  return (
    <div data-testid="live-sample" className="relative flex min-h-0 flex-1 flex-col">
      <span className="absolute right-5 top-3 z-10 rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-2 py-0.5 text-xs text-[var(--muted)]">示例</span>
      {/* 示例不可点、不进读屏和键盘顺序 */}
      <div inert aria-hidden className="pointer-events-none flex min-h-0 flex-1 select-none flex-col">
        <LivePageTabs pages={SAMPLE_PAGES} runs={SAMPLE_RUNS} onShow={noop} />
        <div className="min-h-0 flex-1 overflow-hidden px-5 py-3">
          <SampleForm />
          <TaskProgressPanel page={SAMPLE_PAGES[0]} run={SAMPLE_RUNS[0]} />
        </div>
      </div>
    </div>
  );
}
