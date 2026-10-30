/**
 * 做法三：AI 在后台干活，对话里只出现「要你的事」和回来时的简报。
 * 单位是一份申请；要你的事按外部期限排序，固定在输入框上沿，不随对话滚走。
 * 公司和岗位来自本机岗位库；邮件、时间、拒信等是演示事件。
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { pagePng } from './local';

// 公司标志：Wikimedia Commons 上的官方标志；没有的公司（百度、中电福富、元戎启行、九方云）回落到公司名
const LOGOS = import.meta.glob('./img/logo/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const logoOf = (id: string) => Object.entries(LOGOS).find(([k]) => k.split('/').pop()!.split('.')[0] === id)?.[1];
// 标志分三类：自带色块的（美团）把色块铺满整张海报；字标（DeepSeek 等）放在浅底牌子上；没有标志的写公司名
const FILL: Record<string, string> = { mt: '#ffd100' };

export type Job = { id: string; co: string; role: string; star?: boolean };

export const TARGETS: Job[] = [
  { id: 'mt', co: '美团', role: 'AI应用开发工程师', star: true },
  { id: 'jd', co: '京东', role: 'AI/大模型类', star: true },
  { id: 'hw', co: '华为', role: 'AI应用工程师', star: true },
];

export const WIDE: Job[] = [
  { id: 'ds', co: 'DeepSeek', role: '服务端开发工程师' },
  { id: 'zx', co: '中兴通讯', role: '算法类' },
  { id: 'ff', co: '中电福富', role: 'AI应用开发工程师' },
  { id: 'yr', co: '元戎启行', role: '算法类' },
  { id: 'zj', co: '字节跳动', role: 'AI产品类' },
  { id: 'pdd', co: '拼多多', role: '大模型算法工程师' },
  { id: 'mx', co: '摩尔线程', role: 'AI研发' },
  { id: 'zy', co: '智元', role: 'AI Infra/数据类' },
  { id: 'xf', co: '科大讯飞', role: 'AI算法类' },
  { id: 'lx', co: '理想汽车', role: '软件类' },
  { id: 'hy', co: '腾讯混元', role: '大语言模型类' },
  { id: 'al', co: '阿里巴巴', role: '大模型应用' },
  { id: 'ry', co: '荣耀', role: '算法&软件类' },
  { id: 'cf', co: '长飞', role: 'AI大模型工程师' },
  { id: 'lf', co: '联发科技', role: '软件类' },
  { id: 'dj', co: '大疆', role: '算法类' },
  { id: 'pd', co: '普渡机器人', role: '算法' },
];

export const JFY: Job = { id: 'jfy', co: '九方云', role: 'AI应用开发（智能应用方向）' };
export const BD: Job = { id: 'bd', co: '百度', role: '大模型应用' };
export const ALL_JOBS = [...TARGETS, ...WIDE];
export const jobOf = (id: string) => [...ALL_JOBS, JFY, BD].find(j => j.id === id)!;

/* ---------- 海报：一家公司的图形 ---------- */

export type PState = 'wait' | 'run' | 'done' | 'ask' | 'fixed' | 'next';
export type PSize = 'lg' | 'md' | 'sm' | 'xs';

export function Poster({ job, size, state = 'done', over }: { job: Job; size: PSize; state?: PState; over?: string }) {
  const logo = logoOf(job.id);
  const fill = logo ? FILL[job.id] : undefined;
  return (
    <span className={`b-poster b-p-${size} b-s-${state} ${job.co.length >= 4 ? 'b-p-long' : ''} ${fill ? 'b-p-fill' : ''}`} style={fill ? { '--mark': fill } as CSSProperties : undefined} title={`${job.co} · ${job.role}`}>
      <span className="b-p-mark">{logo ? <img src={logo} alt={job.co} draggable={false} /> : <span className="b-p-co font-human">{job.co}</span>}</span>
      {size !== 'sm' && size !== 'xs' && (
        <span className="b-p-body">
          <span className="b-p-role">{job.role}</span>
          {over && <span className="b-p-over">{over}</span>}
        </span>
      )}
      {job.star && size !== 'xs' && <i className="b-p-star" aria-label="目标">★</i>}
    </span>
  );
}

/* ---------- 要你的事 ---------- */

export type AskKind = 'info' | 'login' | 'deadline' | 'slot' | 'review';
export type Ask = {
  id: string;
  kind: AskKind;
  jobs: Job[];
  title: string;
  due?: string; // 外部期限的大字
  dueRank: number; // 越小越急
  src?: string;
  newer?: boolean; // 定制版已换新
};

export const sortAsks = (asks: Ask[]) => [...asks].sort((a, b) => a.dueRank - b.dueRank);

export function AskCard({ ask, onDone, onLater }: { ask: Ask; onDone: () => void; onLater: () => void }) {
  const [val, setVal] = useState('');
  const [slot, setSlot] = useState<number | null>(null);
  const one = ask.jobs[0];
  return (
    <article className={`b-ask b-ask-${ask.kind}`}>
      <div className="b-ask-img">
        {ask.kind === 'info' && <div className="b-mosaic">{ask.jobs.map(j => <Poster key={j.id} job={j} size="xs" state="ask" />)}</div>}
        {ask.kind === 'login' && <div className="b-pair">{ask.jobs.map(j => <Poster key={j.id} job={j} size="md" state="ask" />)}</div>}
        {(ask.kind === 'deadline' || ask.kind === 'slot') && <Poster job={one} size="lg" state="ask" />}
        {ask.kind === 'review' && (
          <figure className="b-page">
            <img src={pagePng} alt={`${one.co} 定制版第 1 页`} draggable={false} />
            {ask.newer && <figcaption>已换新版</figcaption>}
          </figure>
        )}
      </div>
      <div className="b-ask-text">
        <h3 className="b-ask-title font-human">{ask.title}</h3>
        {ask.kind === 'info' && <p className="b-ask-sub">用于这批 {ask.jobs.length} 家，只存在本机</p>}
        {ask.kind === 'login' && <p className="b-ask-sub">登录一次，之后自动投</p>}
        {ask.kind === 'review' && <p className="b-ask-sub">改了 24 处 · 关键词覆盖 10 / 17</p>}
        {ask.due && <p className="b-due">{ask.due}</p>}
        {ask.src && <p className="b-src">{ask.src}</p>}

        {ask.kind === 'info' && (
          <input className="b-input" type="password" autoComplete="off" placeholder="证件号码" value={val} onChange={e => setVal(e.target.value)} aria-label="证件号码" />
        )}
        {ask.kind === 'slot' && (
          <div className="b-slots" role="radiogroup" aria-label="选一个时间">
            {['10月31日 周五 14:00', '11月3日 周一 10:00', '11月3日 周一 16:00'].map((s, i) => (
              <button key={s} type="button" role="radio" aria-checked={slot === i} onClick={() => setSlot(i)}>{s}</button>
            ))}
          </div>
        )}

        <div className="b-acts">
          <button
            type="button"
            className="b-go"
            disabled={(ask.kind === 'info' && val.length < 4) || (ask.kind === 'slot' && slot === null)}
            onClick={onDone}
          >
            {{ info: '填好', login: '去登录', deadline: '去做测评', slot: '确认这个时间', review: '就这样投出' }[ask.kind]}
          </button>
          <button type="button" className="b-later" onClick={onLater}>
            {{ info: '这批先跳过', login: '晚点', deadline: '提前 1 小时提醒我', slot: '都不行', review: '我要改' }[ask.kind]}
          </button>
        </div>
        {ask.kind === 'review' && <p className="b-warn">投出后撤不回</p>}
        <div className="b-quiet">
          <button type="button">{ask.kind === 'review' ? '这家以后不用先给我看' : '这类以后别问我'}</button>
        </div>
      </div>
    </article>
  );
}

/* ---------- 卡组：一次一张，←→ 切换 ---------- */

export function Deck({ asks, index, setIndex, onDone, onLater, onClose }: {
  asks: Ask[]; index: number; setIndex: (i: number) => void; onDone: (id: string) => void; onLater: (id: string) => void; onClose: () => void;
}) {
  const ask = asks[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') setIndex(Math.min(asks.length - 1, index + 1));
      if (e.key === 'ArrowLeft') setIndex(Math.max(0, index - 1));
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asks.length, index, onClose, setIndex]);
  if (!ask) return null;
  return (
    <section className="b-deck" aria-label="等你的事">
      <header className="b-deck-head">
        <span className="b-deck-count">等你 <b>{index + 1}</b> / {asks.length}</span>
        <span className="b-deck-dots" aria-hidden>{asks.map((a, i) => <i key={a.id} className={i === index ? 'on' : ''} />)}</span>
        <span className="b-deck-nav">
          <button type="button" aria-label="上一件" disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button>
          <button type="button" aria-label="下一件" disabled={index >= asks.length - 1} onClick={() => setIndex(index + 1)}>→</button>
          <button type="button" className="b-deck-close" onClick={onClose}>收起</button>
        </span>
      </header>
      <AskCard key={ask.id + String(ask.newer)} ask={ask} onDone={() => onDone(ask.id)} onLater={() => onLater(ask.id)} />
    </section>
  );
}

/* ---------- 等你条：输入框上沿，常驻 ---------- */

export function Dock({ asks, run, onDeck, onRun }: {
  asks: Ask[]; run?: { done: number; total: number } | null; onDeck: () => void; onRun: () => void;
}) {
  const n = asks.length;
  return (
    <div className="b-dock">
      {n > 0 ? (
        <button type="button" className="b-dock-ask" onClick={onDeck}>
          <span>等你 <b>{n}</b></span>
          <span className="b-dock-thumbs">{asks.slice(0, 3).map(a => (a.jobs.length > 1
            ? <span key={a.id} className="b-poster b-p-xs b-s-ask b-p-num" title={`用于 ${a.jobs.length} 家`}><span className="b-p-co">{a.jobs.length}</span></span>
            : <Poster key={a.id} job={a.jobs[0]} size="xs" state="ask" />))}</span>
          {asks[0].due && <em>{asks[0].due}</em>}
        </button>
      ) : (
        <span className="b-dock-none">没有要你的事</span>
      )}
      {run && (
        <button type="button" className="b-dock-run" onClick={onRun}>
          <span>投出 {run.done} / {run.total}</span>
          <span className="b-meter" aria-hidden>{Array.from({ length: run.total }, (_, i) => <i key={i} className={i < run.done ? 'on' : ''} />)}</span>
        </button>
      )}
    </div>
  );
}

/* ---------- 批次卡：一次「投这些」的结果，原地更新 ---------- */

export function BatchCard({ states, onWatch, compact }: { states: Record<string, PState>; onWatch?: (id: string) => void; compact?: boolean }) {
  const all = ALL_JOBS.filter(j => states[j.id]);
  const count = (s: PState) => all.filter(j => states[j.id] === s).length;
  const targets = all.filter(j => j.star);
  const rest = all.filter(j => !j.star);
  return (
    <article className={`b-batch ${compact ? 'is-compact' : ''}`}>
      <header className="b-batch-head">
        <h3 className="font-human">投 {all.length} 家</h3>
        <span className="b-batch-stat">
          <b>{count('done') + count('fixed')}</b> 已投出
          {count('run') > 0 && <> · {count('run')} 在投</>}
          {count('ask') > 0 && <> · <em>{count('ask')} 等你</em></>}
        </span>
      </header>
      <div className="b-batch-targets">{targets.map(j => <Poster key={j.id} job={j} size="md" state={states[j.id]} over={label(states[j.id])} />)}</div>
      <div className="b-batch-grid">
        {rest.map(j => (
          <span key={j.id} className="b-batch-cell">
            <Poster job={j} size="sm" state={states[j.id]} />
            {onWatch && states[j.id] === 'wait' && <button type="button" className="b-watch" onClick={() => onWatch(j.id)}>这家我要看</button>}
          </span>
        ))}
      </div>
    </article>
  );
}
const label = (s: PState) => ({ wait: '排队', run: '定制中', done: '已投出', ask: '等你看', fixed: '已投出', next: '排队' })[s];

/* ---------- 回来卡 ---------- */

export type Away = {
  span: string;
  asks: Ask[];
  sent?: Job[];
  replies?: Array<{ kind: string; n: number; jobs: Job[] }>;
  ahead?: Array<{ job: Job; when: string }>;
  quiet?: string;
};

export function ReturnCard({ away, onStart }: { away: Away; onStart?: () => void }) {
  const first = away.asks[0];
  return (
    <article className="b-return">
      <p className="b-return-span">你不在的 {away.span}</p>
      {first ? (
        <div className="b-return-lead">
          <Poster job={first.jobs[0]} size="lg" state="ask" />
          <div>
            <h3 className="font-human">{first.title}</h3>
            {first.due && <p className="b-due b-due-xl">{first.due}</p>}
            <button type="button" className="b-go" onClick={onStart}>从最急的开始</button>
            {away.asks.length > 1 && <p className="b-return-more">还有 {away.asks.length - 1} 件等你</p>}
          </div>
        </div>
      ) : (
        <h3 className="b-return-none font-human">没有要你做的事</h3>
      )}
      {(away.sent || away.replies || away.ahead) && (
        <div className="b-return-facts">
          {away.sent && (
            <div>
              <span className="b-fact-n">{away.sent.length}</span>
              <span className="b-fact-l">已投出</span>
              <span className="b-fact-row">{away.sent.map(j => <Poster key={j.id} job={j} size="xs" />)}</span>
            </div>
          )}
          {away.replies?.map(r => (
            <div key={r.kind}>
              <span className="b-fact-n">{r.n}</span>
              <span className="b-fact-l">{r.kind}</span>
              <span className="b-fact-row">{r.jobs.map(j => <Poster key={j.id} job={j} size="xs" />)}</span>
            </div>
          ))}
          {away.ahead?.map(a => (
            <div key={a.job.id}>
              <span className="b-fact-n b-fact-when">{a.when}</span>
              <span className="b-fact-l">{a.job.co} 提前批开</span>
              <span className="b-fact-row"><Poster job={a.job} size="xs" /></span>
            </div>
          ))}
        </div>
      )}
      {away.quiet && <p className="b-return-quiet">{away.quiet}</p>}
    </article>
  );
}

/* ---------- 更正卡：改了共用的东西，一批申请分成能改的和改不了的 ---------- */

export function FixCard({ sent, swapped }: { sent: Job[]; swapped: Job[] }) {
  return (
    <article className="b-fix">
      <div className="b-fix-col">
        <p className="b-fix-n"><b>{swapped.length}</b> 家换成新版</p>
        <div className="b-fix-row">{swapped.map(j => <Poster key={j.id} job={j} size="xs" state="next" />)}</div>
      </div>
      <div className="b-fix-col is-locked">
        <p className="b-fix-n"><b>{sent.length}</b> 家已投出，改不了</p>
        <div className="b-fix-row">{sent.map(j => <Poster key={j.id} job={j} size="xs" />)}</div>
      </div>
    </article>
  );
}

/* ---------- 申请对象卡：问「某家怎样了」时出现 ---------- */

export function AppCard({ job, track, next }: { job: Job; track: Array<{ s: string; d?: string; on?: boolean; ask?: boolean }>; next?: string }) {
  return (
    <article className="b-app">
      <Poster job={job} size="lg" />
      <div className="b-app-text">
        <h3 className="font-human">{job.co}<span>{job.role}</span></h3>
        <ol className="b-track">
          {track.map(t => (
            <li key={t.s} className={`${t.on ? 'on' : ''} ${t.ask ? 'ask' : ''}`}>
              <i />
              <span>{t.s}</span>
              {t.d && <small>{t.d}</small>}
            </li>
          ))}
        </ol>
        {next && <p className="b-app-next">{next}</p>}
        <div className="b-acts b-acts-hover">
          <button type="button" className="b-go-text">确认时间 →</button>
          <button type="button" className="b-later">看邮件</button>
        </div>
      </div>
    </article>
  );
}

/* ---------- 系统通知：只给带期限的事 ---------- */

export function OsBanner({ title, body, when }: { title: string; body: string; when: string }) {
  return (
    <div className="b-os" role="status">
      <span className="b-os-icon font-human">芽</span>
      <div>
        <p className="b-os-top"><b>求职助手</b><span>{when}</span></p>
        <p className="b-os-title">{title}</p>
        <p className="b-os-body">{body}</p>
      </div>
    </div>
  );
}
