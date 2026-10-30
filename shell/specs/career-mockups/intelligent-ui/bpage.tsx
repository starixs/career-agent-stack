import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ResumeCard } from './cards';
import {
  ALL_JOBS, AppCard, AskCard, BD, BatchCard, Deck, Dock, FixCard, JFY, OsBanner, Poster, ReturnCard, TARGETS, WIDE,
  jobOf, sortAsks, type Ask, type Away, type Job, type PState,
} from './b';

/* ---------- 演示状态 ---------- */

type Msg =
  | { id: number; k: 'user' | 'ai' | 'day'; text: string }
  | { id: number; k: 'batch' }
  | { id: number; k: 'return'; away: Away }
  | { id: number; k: 'fix'; sent: Job[]; swapped: Job[] }
  | { id: number; k: 'resume' }
  | { id: number; k: 'app' };

type S = {
  clock: string;
  msgs: Msg[];
  asks: Ask[];
  batch: Record<string, PState> | null;
  fixed: boolean;
  deck: boolean;
  idx: number;
  pop: boolean;
  closed?: boolean;
  banner: { title: string; body: string; when: string } | null;
};

const EMPTY: S = { clock: '', msgs: [], asks: [], batch: null, fixed: false, deck: false, idx: 0, pop: false, banner: null };
let seq = 0;
const m = <T extends Omit<Msg, 'id'>>(x: T) => ({ ...x, id: ++seq }) as Msg;

const LOGIN = ['mx', 'zy'];
const ASK = {
  info: (): Ask => ({ id: 'info', kind: 'info', jobs: ALL_JOBS, title: '证件号码', dueRank: 50 }),
  login: (): Ask => ({ id: 'login', kind: 'login', jobs: LOGIN.map(jobOf), title: '2 个网站要你登录', dueRank: 60 }),
  mt: (): Ask => ({ id: 'mt', kind: 'review', jobs: [jobOf('mt')], title: '美团 · 定制版', dueRank: 40 }),
  jfy: (due: string, src: string): Ask => ({ id: 'jfy', kind: 'deadline', jobs: [JFY], title: '九方云 · 在线测评', due, dueRank: 5, src }),
  xf: (): Ask => ({ id: 'xf', kind: 'deadline', jobs: [jobOf('xf')], title: '科大讯飞 · 笔试', due: '11月2日 20:00 截止', dueRank: 20, src: '来自邮件 · 今天 14:06' }),
  jd: (): Ask => ({ id: 'jd', kind: 'slot', jobs: [jobOf('jd')], title: '京东 · 一面时间', due: '明天 18:00 前回复', dueRank: 15, src: '来自邮件 · 10月28日 16:40' }),
};

/** 海投那 17 家推进到第 n 家；已投出的不回退；要登录的停在「等你」。 */
function advance(s: S, n: number): Record<string, PState> {
  const b = { ...s.batch! };
  const loginOpen = s.asks.some(a => a.id === 'login');
  WIDE.forEach((j, i) => {
    const cur = b[j.id];
    if (cur === 'done' || cur === 'fixed') return;
    if (i < n) b[j.id] = LOGIN.includes(j.id) && loginOpen ? 'ask' : s.fixed ? 'fixed' : 'done';
    else if (i === n && cur === 'wait') b[j.id] = 'run';
  });
  return b;
}

const addAsk = (s: S, ...a: Ask[]) => sortAsks([...s.asks.filter(x => !a.some(y => y.id === x.id)), ...a]);

type Beat = { t: string; label: string; note: string; go: (s: S) => S };

const SENT_C = ALL_JOBS.filter(j => j.id !== 'hw' && !LOGIN.includes(j.id));
const BATCH_END: Record<string, PState> = Object.fromEntries([
  ['mt', 'done'], ['jd', 'done'], ['hw', 'run'],
  ...WIDE.map(j => [j.id, LOGIN.includes(j.id) ? 'ask' : 'done']),
]);

const SCENES: Record<'prep' | 'peak' | 'back', { name: string; beats: Beat[] }> = {
  prep: {
    name: '准备期',
    beats: [
      {
        t: '10月6日 20:10', label: '三周没来，打开软件', note: '没有要你的事：回来卡只说一句，加两条用得上的消息。等你条是空的。',
        go: () => ({
          ...EMPTY, clock: '10月6日 20:10',
          msgs: [m({ k: 'return', away: {
            span: '3 周', asks: [],
            replies: [{ kind: '暑期投的还没回音', n: 5, jobs: [jobOf('ds'), jobOf('zx'), jobOf('yr'), jobOf('ry'), jobOf('dj')] }],
            ahead: [{ job: jobOf('zj'), when: '10月13日' }, { job: jobOf('al'), when: '10月15日' }],
          } })],
        }),
      },
      { t: '20:11', label: '「我想补一段实习经历」', note: '准备期的正事在对话里做，没有流程、没有进度条。', go: s => ({ ...s, clock: '20:11', msgs: [...s.msgs, m({ k: 'user', text: '我想补一段实习经历。' }), m({ k: 'ai', text: '好，说说在哪、做了什么、有哪些数字。' })] }) },
      { t: '20:25', label: '讲完，放进主简历', note: '单独看一个对象时，用已经通过的简历卡。', go: s => ({ ...s, clock: '20:25', msgs: [...s.msgs, m({ k: 'user', text: '大概就是这些。' }), m({ k: 'ai', text: '放进主简历了。' }), m({ k: 'resume' })] }) },
    ],
  },
  peak: {
    name: '关键期的一天',
    beats: [
      {
        t: '09:10', label: '「这 20 个都投了」', note: '一句话出一张批次卡。标星的 3 家投之前给你看，其余 17 家直接投。',
        go: () => {
          const s: S = { ...EMPTY, clock: '09:10', batch: Object.fromEntries(ALL_JOBS.map(j => [j.id, 'wait' as PState])) };
          s.batch!.mt = 'run';
          return { ...s, batch: advance(s, 0), msgs: [m({ k: 'user', text: '这 20 个都投了。' }), m({ k: 'ai', text: '好。美团、京东、华为是你标了星的，定制好先给你看再投；其余 17 家直接投。' }), m({ k: 'batch' })] };
        },
      },
      {
        t: '09:16', label: '缺证件号码', note: '这件事是你刚交代的事直接引出的，你也没在打字，所以卡组自己弹出来。一次填，20 家都用。',
        go: s => { const n = { ...s, clock: '09:16', asks: addAsk(s, ASK.info()) }; return { ...n, batch: advance(n, 3), deck: true, idx: n.asks.findIndex(a => a.id === 'info') }; },
      },
      {
        t: '09:48', label: '2 家要登录，美团定制好了', note: '不弹出，只在等你条上加数。等你条按期限排：没有外部期限的排在后面。',
        go: s => { const n = { ...s, clock: '09:48', asks: addAsk(s, ASK.login(), ASK.mt()) }; return { ...n, batch: { ...advance(n, 8), mt: 'ask' } }; },
      },
      {
        t: '10:30', label: '邮件：九方云测评邀请', note: '带外部期限，排到等你条第一位。软件开着，所以不发系统通知。',
        go: s => { const n = { ...s, clock: '10:30', asks: addAsk(s, ASK.jfy('10月29日 23:59 截止', '来自邮件 · 今天 10:28')) }; return { ...n, batch: advance(n, 10) }; },
      },
      {
        t: '11:05', label: '插话：「帮我准备后天百度的面试」', note: '批次卡被顶上去了，但等你条和在投进度一直在输入框上沿。',
        go: s => { const n = { ...s, clock: '11:05', msgs: [...s.msgs, m({ k: 'user', text: '帮我准备后天百度的面试。' }), m({ k: 'ai', text: '好。先从你简历上最硬的数字问起：数据库直连请求降了 80%，这个数你当时是怎么量出来的？' })] }; return { ...n, batch: { ...advance(n, 12), jd: n.batch!.jd === 'wait' ? 'run' : n.batch!.jd } }; },
      },
      {
        t: '12:20', label: '「简历里项目名写错了一个字」', note: '改的是共用的主简历。一张更正卡分两堆：还没投的换成新版，已投出的改不了。等你条里的美团定制版也换了新版。',
        go: s => {
          const sent = ALL_JOBS.filter(j => s.batch![j.id] === 'done');
          const swapped = ALL_JOBS.filter(j => s.batch![j.id] !== 'done');
          return { ...s, clock: '12:20', fixed: true, asks: s.asks.map(a => (a.kind === 'review' ? { ...a, newer: true } : a)), msgs: [...s.msgs, m({ k: 'user', text: '简历里项目名写错了一个字，改一下。' }), m({ k: 'ai', text: '改好了。' }), m({ k: 'fix', sent, swapped })] };
        },
      },
      {
        t: '14:10', label: '邮件：拼多多不合适、讯飞笔试', note: '拒信不打扰你，只记进数字，回来卡里才看得到。笔试有期限，进等你条。',
        go: s => { const n = { ...s, clock: '14:10', asks: addAsk(s, ASK.xf()) }; return { ...n, batch: advance(n, 15) }; },
      },
      {
        t: '18:30', label: '海投跑完', note: '17 家里没卡住的都投出了。还停着的，都在等你条里。',
        go: s => { const n = { ...s, clock: '18:30' }; return { ...n, batch: advance(n, 17) }; },
      },
    ],
  },
  back: {
    name: '两天后回来',
    beats: [
      {
        t: '10月28日 20:00', label: '软件关着，九方云明晚截止', note: '只有带期限的事才发系统通知。拒信、没回音都不发。',
        go: () => ({ ...EMPTY, clock: '10月28日 20:00', closed: true, asks: [ASK.login()], batch: BATCH_END, banner: { title: '九方云 · 在线测评', body: '明晚 23:59 截止', when: '现在' }, msgs: [m({ k: 'day', text: '10月27日' }), m({ k: 'user', text: '这 20 个都投了。' }), m({ k: 'batch' })] }),
      },
      {
        t: '10月29日 09:30', label: '打开软件', note: '回来卡第一件就是最急的，点一次开始处理。下面三行是这两天的结果，只给数字和公司。',
        go: s => {
          const asks = sortAsks([ASK.jfy('今晚 23:59 截止', '来自邮件 · 10月27日 10:28'), ASK.jd(), ASK.xf(), ASK.login()]);
          const away: Away = {
            span: '2 天', asks, sent: SENT_C,
            replies: [
              { kind: '面试邀请', n: 1, jobs: [jobOf('jd')] },
              { kind: '笔试 / 测评', n: 2, jobs: [JFY, jobOf('xf')] },
              { kind: '不合适', n: 2, jobs: [jobOf('pdd'), jobOf('lx')] },
            ],
            quiet: '其余 13 家还没回音。',
          };
          return { ...s, clock: '10月29日 09:30', closed: false, banner: null, asks, msgs: [...s.msgs, m({ k: 'day', text: '今天' }), m({ k: 'return', away })] };
        },
      },
      {
        t: '09:34', label: '「京东那份怎样了？」', note: '问某一家时，出这一份申请的对象卡：一条从投出到下一步的路。',
        go: s => ({ ...s, clock: '09:34', msgs: [...s.msgs, m({ k: 'user', text: '京东那份怎样了？' }), m({ k: 'app' })] }),
      },
    ],
  },
};

/* ---------- UX 页 ---------- */

function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; name: string }>; onChange: (v: T) => void }) {
  return <div className="pv-seg">{options.map(o => <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.name}</button>)}</div>;
}

function Bubble({ children }: { children: ReactNode }) {
  return <div className="b-user"><div>{children}</div></div>;
}

export function UxPageB() {
  const [scene, setScene] = useState<keyof typeof SCENES>('peak');
  const beats = SCENES[scene].beats;
  const [step, setStep] = useState(0);
  const [s, setS] = useState<S>(() => beats[0].go(EMPTY));
  const [taps, setTaps] = useState(0);
  const col = useRef<HTMLDivElement>(null);

  const reset = (k: keyof typeof SCENES) => { setScene(k); setStep(0); setS(SCENES[k].beats[0].go(EMPTY)); setTaps(0); };
  // 新的事插进来重新排序时，卡组停在正在看的那一张，不被挤走
  const next = () => {
    if (step + 1 >= beats.length) return;
    const n = beats[step + 1].go(s);
    const keep = s.deck && n.deck === s.deck ? n.asks.findIndex(a => a.id === s.asks[s.idx]?.id) : -1;
    setS(keep >= 0 ? { ...n, idx: keep } : n);
    setStep(step + 1);
  };

  useEffect(() => { col.current?.scrollTo({ top: col.current.scrollHeight }); }, [s.msgs.length]);

  const resolve = (id: string, later: boolean) => setS(cur => {
    let batch = cur.batch;
    let asks = cur.asks.filter(a => a.id !== id);
    if (later) {
      const a = cur.asks.find(x => x.id === id)!;
      asks = [...asks, { ...a, dueRank: a.dueRank + 100 }];
    } else if (batch) {
      if (id === 'login') batch = { ...batch, ...Object.fromEntries(LOGIN.map(j => [j, (cur.fixed ? 'fixed' : 'done') as PState])) };
      if (id === 'mt' || id.startsWith('w-')) batch = { ...batch, [id.replace('w-', '')]: (cur.fixed ? 'fixed' : 'done') as PState };
    }
    const idx = Math.min(cur.idx, Math.max(0, asks.length - 1));
    return { ...cur, asks, batch, idx, deck: asks.length > 0 && cur.deck };
  });

  const watch = (jid: string) => setS(cur => ({
    ...cur,
    batch: { ...cur.batch!, [jid]: 'ask' },
    asks: addAsk(cur, { id: `w-${jid}`, kind: 'review', jobs: [jobOf(jid)], title: `${jobOf(jid).co} · 定制版`, dueRank: 41, newer: cur.fixed }),
  }));

  const run = s.batch ? { done: WIDE.filter(j => ['done', 'fixed'].includes(s.batch![j.id])).length, total: WIDE.length } : null;
  const showRun = run && run.done < run.total && scene === 'peak' ? run : null;

  return (
    <div className="b-wrap">
      <div className="b-bar">
        <Seg value={scene} options={(Object.keys(SCENES) as Array<keyof typeof SCENES>).map(k => ({ id: k, name: SCENES[k].name }))} onChange={reset} />
        <button type="button" className="b-next" disabled={step + 1 >= beats.length} onClick={next}>
          {step + 1 < beats.length ? <>下一步 · {beats[step + 1].t} {beats[step + 1].label}</> : '这个场景演完了'}
        </button>
        <button type="button" className="pv-reset" onClick={() => reset(scene)}>重来</button>
        <span className="b-taps">你点了 <b>{taps}</b> 次</span>
      </div>

      <p className="b-now"><b>{beats[step].t}</b>　{beats[step].note}</p>

      <div
        className="b-desk"
        onClickCapture={e => {
          const btn = (e.target as HTMLElement).closest('button');
          if (btn && !btn.disabled) setTaps(t => t + 1);
        }}
      >
        <nav className="b-rail" aria-hidden><i className="font-human">芽</i><i /><i /><i /></nav>
        <div className="b-chat">
          <header className="b-chat-head"><span className="font-human">求职助手</span><span>{s.clock}</span></header>
          <div ref={col} className="b-col">
            {s.msgs.map(x => {
              if (x.k === 'user') return <Bubble key={x.id}>{x.text}</Bubble>;
              if (x.k === 'ai') return <p key={x.id} className="b-ai">{x.text}</p>;
              if (x.k === 'day') return <p key={x.id} className="b-day">{x.text}</p>;
              if (x.k === 'batch') return s.batch && <BatchCard key={x.id} states={s.batch} onWatch={scene === 'peak' ? watch : undefined} />;
              if (x.k === 'return') return <ReturnCard key={x.id} away={x.away} onStart={() => setS(c => ({ ...c, deck: true, idx: 0 }))} />;
              if (x.k === 'fix') return <FixCard key={x.id} sent={x.sent} swapped={x.swapped} />;
              if (x.k === 'resume') return <ResumeCard key={x.id} image="page" goal="apply" />;
              if (x.k === 'app') {
                const done = !s.asks.some(a => a.id === 'jd');
                return <AppCard key={x.id} job={jobOf('jd')} track={[
                  { s: '投出', d: '10月27日', on: true },
                  { s: '面试邀请', d: '10月28日 · 邮件', on: true },
                  { s: done ? '一面时间已确认' : '确认一面时间', d: done ? undefined : '明天 18:00 前', on: done, ask: !done },
                  { s: '一面' },
                ]} />;
              }
              return null;
            })}
          </div>
          <div className="b-bottom">
            {s.deck && s.asks.length > 0 && (
              <Deck asks={s.asks} index={s.idx} setIndex={i => setS(c => ({ ...c, idx: i }))} onDone={id => resolve(id, false)} onLater={id => resolve(id, true)} onClose={() => setS(c => ({ ...c, deck: false }))} />
            )}
            {s.pop && s.batch && (
              <div className="b-pop"><BatchCard states={s.batch} compact /><button type="button" className="b-deck-close" onClick={() => setS(c => ({ ...c, pop: false }))}>收起</button></div>
            )}
            <Dock asks={s.asks} run={showRun} onDeck={() => setS(c => ({ ...c, deck: !c.deck, pop: false, idx: 0 }))} onRun={() => setS(c => ({ ...c, pop: !c.pop, deck: false }))} />
            <div className="b-composer">给小芽说点什么…<span>↑</span></div>
          </div>
        </div>
        {s.closed && <div className="b-closed"><span className="font-human">软件关着</span></div>}
        {s.banner && <OsBanner {...s.banner} />}
      </div>

      <ol className="b-script">
        {beats.map((b, i) => (
          <li key={b.t} className={i === step ? 'now' : i < step ? 'past' : ''}>
            <b>{b.t}</b> {b.label}
          </li>
        ))}
      </ol>

      <section className="b-rules">
        <h2 className="font-human">这一版的交互规则</h2>
        <dl>
          <div><dt>单位</dt><dd>一份申请。一句话可以开一批申请，对话里出一张批次卡；之后这份申请的事，不管隔几天，都挂在它身上。</dd></div>
          <div><dt>对话里出现什么</dt><dd>你说的话、简短回复、批次卡、回来卡、更正卡、你问到的对象卡。不要你的事不出现，只变成数字。</dd></div>
          <div><dt>要你的事放哪</dt><dd>只放在输入框上沿的等你条里，按外部期限排；点开是卡组，一次一张，← → 切换。插话、滚动都不会把它顶走。</dd></div>
          <div><dt>什么时候自己弹出</dt><dd>只有你刚交代的事直接引出、而且你没在打字时。其他一律只在等你条上加数。</dd></div>
          <div><dt>合并</dt><dd>一个动作能同时解决的才合成一张：证件号码填一次 20 家都用；两个网站一次去登录。</dd></div>
          <div><dt>管多少</dt><dd>按岗位定：标星的投之前给你看；批次卡上悬停任意一家可以说「这家我要看」；卡片上悬停可以说「这类别问我」。</dd></div>
          <div><dt>改共用的东西</dt><dd>改主简历、资料这类被一批申请共用的东西，出一张更正卡：换成新版的一堆、已投出改不了的一堆。不提供撤回已投出的。</dd></div>
          <div><dt>外部消息</dt><dd>只收邮箱。有期限的进等你条；软件关着时，只有带期限的事发系统通知；拒信和没回音只进数字。</dd></div>
          <div><dt>回来</dt><dd>离开超过半天再打开，对话最新处出一张回来卡：最急的一件放最大，点一次开始处理。</dd></div>
        </dl>
        <p className="b-foot">公司和岗位来自你本机的岗位库，公司标志取自 Wikimedia Commons；美团定制版的「24 处、10 / 17」来自数据库；邮件、时间、拒信、提前批日期都是演示事件。</p>
      </section>
    </div>
  );
}

/* ---------- UI 页 ---------- */

function Spec({ title, cap, children }: { title: string; cap: string; children: ReactNode }) {
  return (
    <section className="b-spec">
      <h3 className="font-human">{title}</h3>
      <p className="b-cap">{cap}</p>
      <div className="b-spec-body">{children}</div>
    </section>
  );
}

export function UiPageB() {
  const asksC = sortAsks([ASK.jfy('今晚 23:59 截止', '来自邮件 · 10月27日 10:28'), ASK.jd(), ASK.xf(), ASK.login()]);
  const mid: Record<string, PState> = Object.fromEntries(ALL_JOBS.map((j, i) => [j.id, (i < 3 ? (['ask', 'run', 'wait'] as PState[])[i] : i < 11 ? 'done' : i === 11 ? 'run' : i === 9 ? 'ask' : 'wait')]));
  mid.mx = 'ask';
  const [i, setI] = useState(0);
  return (
    <div className="b-ui">
      <p className="b-ui-lede">只看组件。颜色只有三种意思：墨色是已经发生的，钢笔蓝是等你动手的，灰是还没轮到的。卡片本身没有底色、描边、投影；只有卡组和系统通知是浮层。</p>

      <Spec title="回来卡" cap="离开超过半天再打开时，出现在对话最新处。最急的一件放大，只有一个主按钮；下面每行一个数字加公司小图，不写过程。没事时只有一句。">
        <div className="b-two">
          <div className="b-frame"><ReturnCard away={{ span: '2 天', asks: asksC, sent: SENT_C, replies: [{ kind: '面试邀请', n: 1, jobs: [jobOf('jd')] }, { kind: '笔试 / 测评', n: 2, jobs: [JFY, jobOf('xf')] }, { kind: '不合适', n: 2, jobs: [jobOf('pdd'), jobOf('lx')] }], quiet: '其余 13 家还没回音。' }} /></div>
          <div className="b-frame"><ReturnCard away={{ span: '3 周', asks: [], replies: [{ kind: '暑期投的还没回音', n: 5, jobs: [jobOf('ds'), jobOf('zx'), jobOf('yr'), jobOf('ry'), jobOf('dj')] }], ahead: [{ job: jobOf('zj'), when: '10月13日' }, { job: jobOf('al'), when: '10月15日' }] }} /></div>
        </div>
      </Spec>

      <Spec title="等你条" cap="贴在输入框上沿，高 40px，永远在。左边是等你的数量、前三件的公司小图和最急那件的期限，有事时整段钢笔蓝；右边是正在跑的一批，墨色进度格。">
        <div className="b-docks">
          <div className="b-dock-demo"><Dock asks={[]} onDeck={() => {}} onRun={() => {}} /><div className="b-composer">给小芽说点什么…<span>↑</span></div></div>
          <div className="b-dock-demo"><Dock asks={asksC} onDeck={() => {}} onRun={() => {}} /><div className="b-composer">给小芽说点什么…<span>↑</span></div></div>
          <div className="b-dock-demo"><Dock asks={[]} run={{ done: 12, total: 17 }} onDeck={() => {}} onRun={() => {}} /><div className="b-composer">给小芽说点什么…<span>↑</span></div></div>
          <div className="b-dock-demo"><Dock asks={asksC.slice(0, 2)} run={{ done: 12, total: 17 }} onDeck={() => {}} onRun={() => {}} /><div className="b-composer">给小芽说点什么…<span>↑</span></div></div>
        </div>
      </Spec>

      <Spec title="卡组" cap="从等你条往上展开，盖住对话下半部分。一次一张，按期限排；← → 切换，Esc 收起。处理完一张自动换下一张，全部处理完自己收起。">
        <div className="b-deck-demo"><Deck asks={asksC} index={i} setIndex={setI} onDone={() => {}} onLater={() => {}} onClose={() => {}} /></div>
      </Spec>

      <Spec title="要你的事 · 五种" cap="左边是对象的图，右边一个名字、一行原因、期限大字、来源；最多两个按钮，主按钮钢笔蓝。悬停才出现最下面那行「以后别问我」。">
        <div className="b-asks">
          {[ASK.jfy('今晚 23:59 截止', '来自邮件 · 10月27日 10:28'), ASK.jd(), ASK.mt(), ASK.info(), ASK.login()].map(a => (
            <div key={a.id} className="b-frame"><p className="b-kind">{{ deadline: '有期限的事', slot: '要你选', review: '目标岗位先给你看', info: '缺信息 · 一次用于一批', login: '要登录 · 合并' }[a.kind]}</p><div className="b-hover-demo"><AskCard ask={a} onDone={() => {}} onLater={() => {}} /></div></div>
          ))}
        </div>
      </Spec>

      <Spec title="批次卡" cap="一句「投这些」的结果，原地更新。标星的大图在上，其余小图成格。墨色是已投出，钢笔蓝框是等你，灰是排队。悬停排队中的一家可以说「这家我要看」。">
        <div className="b-frame"><BatchCard states={mid} onWatch={() => {}} /></div>
      </Spec>

      <Spec title="更正卡" cap="改了被一批申请共用的东西时出现。两堆：换成新版的、已投出改不了的。不写改了什么，悬停小图看那家用的是哪版。">
        <div className="b-frame"><FixCard sent={WIDE.slice(0, 9)} swapped={[...TARGETS, ...WIDE.slice(9)]} /></div>
      </Spec>

      <Spec title="申请对象卡" cap="问「某家怎样了」时出现。左边公司大图，右边一条从投出到下一步的路：墨色是发生过的，钢笔蓝是等你的那一节。动作悬停出现。">
        <div className="b-frame"><AppCard job={jobOf('jd')} track={[{ s: '投出', d: '10月27日', on: true }, { s: '面试邀请', d: '10月28日 · 邮件', on: true }, { s: '确认一面时间', d: '明天 18:00 前', ask: true }, { s: '一面' }]} /></div>
      </Spec>

      <Spec title="系统通知" cap="软件关着时，只给带外部期限的事发；前一天晚上一次、当天上午一次。拒信、没回音、投出都不发。">
        <div className="b-os-demo"><OsBanner title="九方云 · 在线测评" body="明晚 23:59 截止" when="现在" /></div>
      </Spec>

      <Spec title="公司海报" cap="一份申请的图形，大小四档。上半是标志区，只有它随品牌变：自带色块的（美团）铺品牌色，字标放浅底，没标志的小公司写名字。下半岗位名和状态字所有海报统一。状态只看最底下一条：浅灰排队、墨色短条在做、墨色整条已投出、钢笔蓝整条等你。最小一档是横长的标志小签。★ 是目标岗位。">
        <div className="b-posters">
          {(['lg', 'md', 'sm', 'xs'] as const).map(sz => (
            <div key={sz} className="b-poster-row">
              <span className="b-kind">{sz}</span>
              {(['wait', 'run', 'done', 'ask'] as PState[]).map(st => <Poster key={st} job={sz === 'lg' || sz === 'md' ? TARGETS[0] : WIDE[4]} size={sz} state={st} />)}
            </div>
          ))}
          <div className="b-poster-row"><span className="b-kind">其他</span><Poster job={BD} size="md" /><Poster job={JFY} size="md" state="ask" /><Poster job={jobOf('yr')} size="sm" state="run" /><Poster job={jobOf('mt')} size="md" state="fixed" /><Poster job={jobOf('jd')} size="md" state="next" /></div>
          <div className="b-poster-row"><span className="b-kind">全部</span>{[...TARGETS, ...WIDE].map(j => <Poster key={j.id} job={j} size="sm" state="done" />)}</div>
        </div>
      </Spec>
    </div>
  );
}
