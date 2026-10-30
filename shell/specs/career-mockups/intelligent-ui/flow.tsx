/**
 * Intelligent UI 流程预览：「帮我投美团」。
 * 每轮回答 = 一句话 + 从组件库里挑出的组件；用户点选项、调开关、勾清单，都作为一条结构化消息回到对话，AI 接着做。
 * 数据来自本机数据库：美团 JD、主简历、定制提案（24 处）、网申缺项（4 项）、收藏里的其他岗位。
 */
import { useState, type ReactNode } from 'react';

import { ME, photoJpg } from './local';

// ─── 组件库 ───

/** 岗位海报：用真实字段排出来的「图」，不靠 logo。 */
function JobPoster({ company, role, foot, size = 'lg' }: { company: string; role: string; foot: string; size?: 'lg' | 'sm' }) {
  return (
    <figure className={`f-poster f-poster-${size}`}>
      <span className="f-poster-co font-human">{company}</span>
      <span className="f-poster-role">{role}</span>
      <span className="f-poster-foot">{foot}</span>
    </figure>
  );
}

/** 关系组件：岗位 × 你的简历，中间是覆盖度。 */
function MatchPair() {
  const covered = 10;
  const total = 17;
  return (
    <section className="f-pair" aria-label="美团岗位与你的简历">
      <JobPoster company="美团" role="AI 应用开发工程师" foot="校招 · 北京 / 上海" />
      <div className="f-pair-mid">
        <span className="f-pair-num"><b>{covered}</b> / {total}</span>
        <span className="f-meter">{Array.from({ length: total }, (_, i) => <i key={i} className={i < covered ? 'on' : ''} />)}</span>
        <span className="f-pair-cap">JD 关键词你的简历已覆盖</span>
        <span className="f-pair-miss">缺：大模型 API · Embedding · MCP · 效果监控 · 系统部署 · TS · Go</span>
      </div>
      <figure className="f-person">
        <img src={photoJpg} alt="你的证件照" draggable={false} />
        <figcaption><span className="font-human">{ME.name}</span><span>主简历</span></figcaption>
      </figure>
    </section>
  );
}

/** 选择题追问：一题、几个能点的选项；推荐项写理由。 */
function Choice({ q, options, picked, onPick }: { q: string; options: Array<{ id: string; title: string; why?: string; rec?: boolean }>; picked?: string; onPick: (id: string, title: string) => void }) {
  return (
    <section className={`f-choice ${picked ? 'is-picked' : ''}`}>
      <p className="f-choice-q">{q}</p>
      <div className="f-choice-opts">
        {options.map(o => (
          <button key={o.id} type="button" disabled={!!picked} aria-pressed={picked === o.id} className={`f-opt ${o.rec ? 'is-rec' : ''} ${picked === o.id ? 'is-on' : ''}`} onClick={() => onPick(o.id, o.title)}>
            <span className="f-opt-title">{o.title}{o.rec && !picked && <em>推荐</em>}</span>
            {o.why && <span className="f-opt-why">{o.why}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 并排对比 + 调整控件：切换改动力度，提案当场换。 */
const LEVELS = {
  light: {
    stat: '2 处 · 只改措辞', cover: 10,
    rows: [
      ['求职意向', 'AI 应用开发工程师', 'AI 应用开发工程师（大模型应用 / Agent 方向）'],
      ['经历标题', '工作经历', 'AI 应用开发经历'],
      ['技能栏', 'Java 基础 · Java 并发 · JVM · MySQL · Redis …（8 组）', '不动'],
    ],
  },
  full: {
    stat: '24 处 · 新增 8 处', cover: 12,
    rows: [
      ['求职意向', 'AI 应用开发工程师', 'AI 应用开发工程师（大模型应用 / Agent 方向）'],
      ['技能栏', 'Java 基础 · Java 并发 · JVM · MySQL · Redis …（8 组）', '编程语言 · AI 应用开发 · 后端与框架 · 数据库与中间件 · 工程能力（5 组）'],
      ['经历', '1 段实习', '1 段实习 + 4 段 AI 项目（企业客服 Agent、数据分析 Agent …）'],
    ],
  },
} as const;

function Compare() {
  const [level, setLevel] = useState<keyof typeof LEVELS>('full');
  const l = LEVELS[level];
  return (
    <section className="f-compare">
      <div className="f-compare-head">
        <div className="f-seg" role="group" aria-label="改动力度">
          {([['light', '只改措辞'], ['full', '完整提案']] as const).map(([id, name]) => (
            <button key={id} type="button" aria-pressed={level === id} onClick={() => setLevel(id)}>{name}</button>
          ))}
        </div>
        <span className="f-compare-stat">{l.stat}</span>
        <span className="f-compare-cover">关键词 10 → <b>{l.cover}</b> / 17</span>
      </div>
      <div className="f-compare-grid">
        <span className="f-col-h">主简历</span><span className="f-col-h">美团定制版</span>
        {l.rows.map(([label, before, after]) => (
          <div key={label} className="f-compare-row">
            <span className="f-row-label">{label}</span>
            <span className="f-before">{before}</span>
            <span className={`f-after ${after === '不动' ? 'is-same' : ''}`}>{after}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 勾选清单：网申缺的项就地填；必填的填完才能继续。 */
function Checklist({ onDone, done, prefilled }: { onDone: () => void; done: boolean; prefilled: boolean }) {
  const [photo, setPhoto] = useState(prefilled);
  const [id, setId] = useState(prefilled ? '420•••••••••••••18' : '');
  const [swap, setSwap] = useState<'yes' | 'no' | null>(prefilled ? 'no' : null);
  const ready = id.trim().length >= 15;
  const n = (photo ? 1 : 0) + (ready ? 1 : 0) + (swap ? 1 : 0);
  return (
    <section className="f-check">
      <div className="f-check-head">
        <span className="font-human f-check-title">美团网申</span>
        <span className="f-check-prog">必填 {ready ? 20 : 19} / 20 · 选填 {n - (ready ? 1 : 0)} / 3</span>
      </div>
      <ul>
        <li className={ready ? 'is-ok' : 'is-need'}>
          <span className="f-tick" aria-hidden="true">{ready ? '●' : '○'}</span>
          <span className="f-check-label">证件号码<small>必填 · 只存在本机私密库，不发给模型</small></span>
          <input aria-label="证件号码" placeholder="18 位" value={id} disabled={done} onChange={e => setId(e.target.value)} />
        </li>
        <li className={photo ? 'is-ok' : ''}>
          <span className="f-tick" aria-hidden="true">{photo ? '●' : '○'}</span>
          <span className="f-check-label">个人照片<small>选填</small></span>
          <button type="button" className="f-mini" disabled={done} onClick={() => setPhoto(true)}>
            <img src={photoJpg} alt="" />{photo ? '已用简历里的证件照' : '用简历里的证件照'}
          </button>
        </li>
        <li className={swap ? 'is-ok' : ''}>
          <span className="f-tick" aria-hidden="true">{swap ? '●' : '○'}</span>
          <span className="f-check-label">接受其他职位调剂<small>选填</small></span>
          <span className="f-yn">
            <button type="button" aria-pressed={swap === 'yes'} disabled={done} onClick={() => setSwap('yes')}>接受</button>
            <button type="button" aria-pressed={swap === 'no'} disabled={done} onClick={() => setSwap('no')}>不接受</button>
          </span>
        </li>
        <li>
          <span className="f-tick" aria-hidden="true">○</span>
          <span className="f-check-label">作品集<small>选填 · 没有可以不传</small></span>
          <span className="f-skip">跳过</span>
        </li>
      </ul>
      {!done && (
        <div className="f-check-foot">
          <button type="button" className="f-primary" disabled={!ready} onClick={onDone}>填好了，提交前给我过目</button>
          {!ready && <span>还差证件号码</span>}
        </div>
      )}
    </section>
  );
}

/** 回执：高把握、已做完的事，一行。 */
function Receipt({ children }: { children: ReactNode }) {
  return <p className="f-receipt"><span className="f-receipt-mark" aria-hidden="true">✓</span>{children}</p>;
}

/** 局势卡：这一轮变了什么、现在卡在哪、下一步（下一步是横排岗位，每个一个动作）。 */
function Situation() {
  const next = [
    { co: '华为', role: 'AI 应用工程师', foot: '27 秋招 · 深圳' },
    { co: '京东', role: 'AI / 大模型类', foot: '校招 · 北京' },
    { co: '九方云', role: 'AI 应用开发', foot: '上海 · 12 月 31 日截止' },
  ];
  return (
    <section className="f-sit">
      <div className="f-sit-cols">
        <div><span className="f-sit-h">今天</span><ul><li>主简历补齐</li><li>美团定制版</li><li>美团已提交</li></ul></div>
        <div><span className="f-sit-h">在等</span><ul><li>美团笔试通知 · 会进收件箱</li></ul></div>
        <div><span className="f-sit-h">不用你管</span><ul><li>定制版已存进简历库</li></ul></div>
      </div>
      <p className="f-sit-next">趁热再投 · 用同一份定制版改一改就能用</p>
      <div className="f-strip">
        {next.map(j => (
          <div key={j.co} className="f-strip-item">
            <JobPoster company={j.co} role={j.role} foot={j.foot} size="sm" />
            <button type="button" className="f-strip-act">为它改一版 →</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── 对话 ───

function User({ children, chip }: { children: ReactNode; chip?: boolean }) {
  return (
    <div className="flex justify-end px-1 py-2 select-none">
      <div className={`relative w-fit max-w-[85%] rounded-2xl bg-[var(--note)] text-[var(--ink)] select-text ${chip ? 'f-user-chip px-4 py-2 text-sm' : 'p-4 text-base'}`}>{children}</div>
    </div>
  );
}

function Say({ children }: { children: ReactNode }) {
  return <p className="f-say">{children}</p>;
}

export function Flow({ all }: { all: boolean }) {
  const [picks, setPicks] = useState<Record<string, { id: string; title: string }>>({});
  const [filled, setFilled] = useState(false);
  const pick = (step: string) => (id: string, title: string) => setPicks(p => ({ ...p, [step]: { id, title } }));
  const p1 = all ? { id: 'tailor', title: '先为美团定制' } : picks.s1;
  const p2 = all ? { id: 'adopt', title: '采纳完整提案' } : picks.s2;
  const p3 = all ? { id: 'no', title: '没用过，保持不写' } : picks.s3;
  const p4 = all || filled;
  const p5 = all ? { id: 'submit', title: '没问题，提交' } : picks.s5;
  return (
    <div className="f-flow">
      <User>帮我投美团那个 AI 应用开发。</User>
      <div className="f-turn">
        <Say>你的简历已经覆盖了这个岗位一大半的关键词，缺的几个都在 AI 工程那一块。</Say>
        <MatchPair />
        <Choice
          q="怎么投？"
          picked={p1?.id}
          onPick={pick('s1')}
          options={[
            { id: 'tailor', title: '先为美团定制', why: '关键词能补到 12 / 17', rec: true },
            { id: 'direct', title: '用主简历直接投', why: '现在就投，覆盖 10 / 17' },
          ]}
        />
      </div>

      {p1 && (
        <>
          <User chip>{p1.title}</User>
          <div className="f-turn">
            <Say>改了这几处。只改措辞也行，但完整提案能多覆盖两个关键词。</Say>
            <Compare />
            <Choice
              q="用哪一版？"
              picked={p2?.id}
              onPick={pick('s2')}
              options={[{ id: 'adopt', title: '采纳完整提案', rec: true }, { id: 'light', title: '只改措辞' }, { id: 'all', title: '逐条看 24 处' }]}
            />
          </div>
        </>
      )}

      {p2 && (
        <>
          <User chip>{p2.title}</User>
          <div className="f-turn">
            <Choice
              q="MCP 协议、Embedding、大模型 API 这几个词，经历库里没有，我没写。你实际用过吗？"
              picked={p3?.id}
              onPick={pick('s3')}
              options={[
                { id: 'no', title: '没用过，保持不写', why: '不写没把握的词，面试不会被问穿', rec: true },
                { id: 'yes', title: '用过，我补一条经历', why: '补进经历库后再写进简历' },
              ]}
            />
          </div>
        </>
      )}

      {p3 && (
        <>
          <User chip>{p3.title}</User>
          <div className="f-turn">
            <Receipt>美团定制版已存好 · 24 处改动</Receipt>
            <Say>网申我已经填了 19 项，剩下这几项要你来：</Say>
            <Checklist done={p4} prefilled={all} onDone={() => setFilled(true)} />
          </div>
        </>
      )}

      {p4 && (
        <>
          <User chip>填好了，提交前给我过目</User>
          <div className="f-turn">
            <Say>全部填完了，用的是美团定制版。提交后就改不了。</Say>
            <Choice q="提交吗？" picked={p5?.id} onPick={pick('s5')} options={[{ id: 'submit', title: '没问题，提交', rec: true }, { id: 'look', title: '打开浏览器再看一眼' }]} />
          </div>
        </>
      )}

      {p5 && (
        <>
          <User chip>{p5.title}</User>
          <div className="f-turn">
            <Receipt>美团网申已提交 · 刚刚</Receipt>
            <Situation />
          </div>
        </>
      )}
    </div>
  );
}
