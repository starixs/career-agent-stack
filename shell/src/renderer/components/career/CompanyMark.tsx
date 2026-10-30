/**
 * 公司的图形（Intelligent UI 规范 6.2）：小签（xs，64×28）和海报（lg 168×200 / md 120×140）。
 * 公司标志数据还没有，先一律用「名字」类：浅底 + 文楷公司名；接上标志后只改这里。
 * 状态只看海报最底下一条：等你 = 钢笔蓝整条，已投出 = 墨色整条，在做 = 墨色短条，排队 = 浅灰整条。
 */
export type PosterStatus = 'waiting' | 'done' | 'doing' | 'queued';

const BAR: Record<PosterStatus, string> = {
  waiting: 'w-full bg-[var(--primary)]',
  done: 'w-full bg-[var(--ink)]',
  doing: 'w-1/3 bg-[var(--ink)]',
  queued: 'w-full bg-[var(--line-2)]',
};

export function CompanyTag({ name, faded = false }: { name: string; faded?: boolean }) {
  return (
    <span title={name} className={`inline-flex h-7 w-16 shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-[4px] border border-[var(--line)] bg-[var(--inset)] px-1 font-human text-xs font-semibold text-[var(--ink)] ${faded ? 'opacity-60' : ''}`}>
      {name}
    </span>
  );
}

/** 一件事涉及更多家时的数字小签（如「+25」）。 */
export function CountTag({ n }: { n: number }) {
  return <span className="inline-flex h-7 w-16 shrink-0 items-center justify-center rounded-[4px] border border-[var(--line)] bg-[var(--inset)] text-xs font-semibold tabular-nums text-[var(--ink)]">+{n}</span>;
}

export function CompanyPoster({ company, title, status, statusText, size = 'lg' }: { company: string; title: string; status: PosterStatus; statusText: string; size?: 'lg' | 'md' }) {
  const box = size === 'lg' ? 'h-[200px] w-[168px]' : 'h-[140px] w-[120px]';
  return (
    <div aria-label={`${company} · ${title} · ${statusText}`} className={`flex shrink-0 flex-col overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--paper)] ${box}`}>
      <div className={`grid flex-1 place-items-center bg-[var(--inset)] p-2 text-center font-human font-semibold text-[var(--ink)] ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}>{company}</div>
      <div className="px-2.5 pb-1.5 pt-2 text-xs text-[var(--ink-2)]">
        <div className="truncate text-sm font-semibold text-[var(--ink)]">{title}</div>
        {statusText}
      </div>
      <div className="h-1.5 bg-[var(--line)]"><div className={`h-full ${BAR[status]}`} /></div>
    </div>
  );
}

/** 期限大字：今天 / 明天 / 后天 / M 月 D 日，带时刻。 */
export function dueWords(iso: string | null, now = new Date()): string {
  if (!iso) return '时间待确认';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const word = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${word} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
