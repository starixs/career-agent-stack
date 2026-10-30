/**
 * 方案三「先做，你随时看」：AI 一路做下去，每一步留一条回执；只在两种关口停——缺信息、不可逆。
 * 每条回执可以：点开（就地展开成卡片）、在侧栏看全部、撤回（退回这一步让你定，后面受影响的步骤自动重做）、标「下次先问我」。
 * 本文件既给 UI 页（组件在各状态下的样子），也给 UX 页（在电脑上的对话里真跑一遍）。数据来自本机数据库。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { photoJpg } from './local';

// ─── 数据 ───

export type StepId = 'tailor' | 'adopt' | 'mcp' | 'fill' | 'id' | 'submit';
export type Status = 'pending' | 'running' | 'done' | 'redo' | 'undone' | 'skipped' | 'ask';
export interface Choices { tailor: 'tailor' | 'direct'; level: 'full' | 'light'; mcp: 'no' | 'yes' }

const ORDER: StepId[] = ['tailor', 'adopt', 'mcp', 'fill', 'id', 'submit'];
/** 每一步依赖哪几步：撤回或改了上游，下游就要重做。 */
const DEPS: Record<StepId, StepId[]> = { tailor: [], adopt: ['tailor'], mcp: ['adopt'], fill: ['tailor', 'adopt'], id: ['fill'], submit: ['id'] };
const GATES: StepId[] = ['id', 'submit'];

function copy(id: StepId, c: Choices): { title: string; sub: string } {
  switch (id) {
    case 'tailor': return c.tailor === 'tailor' ? { title: '为美团定制简历', sub: c.level === 'full' ? '关键词 10 → 12 / 17' : '关键词 10 / 17 · 只改措辞' } : { title: '用主简历直接投', sub: '关键词 10 / 17，不改简历' };
    case 'adopt': return c.level === 'full' ? { title: '采纳完整提案 · 24 处', sub: '技能栏重组 · 新增 4 段 AI 项目' } : { title: '只改措辞 · 2 处', sub: '求职意向、经历标题' };
    case 'mcp': return c.mcp === 'no' ? { title: '没写 MCP、Embedding、大模型 API', sub: '经历库里没有这几项 · 用过的话点开补' } : { title: '去经历库补一条 MCP 经历', sub: '补完再写进简历' };
    case 'fill': return { title: '网申已填 19 / 20', sub: c.tailor === 'tailor' ? '附件用美团定制版 · 照片用简历证件照' : '附件用主简历 · 照片用简历证件照' };
    case 'id': return { title: '证件号码已填', sub: '尾号 18 · 只存在本机，不发给模型' };
    case 'submit': return { title: '提交美团网申', sub: '提交后改不了' };
  }
}

// ─── 缩略图（回执左侧的小图） ───

function Thumb({ id, c }: { id: StepId; c: Choices }) {
  if (id === 'tailor') return <span className="a3-th a3-th-job font-human">美团</span>;
  if (id === 'adopt') return (
    <span className="a3-th a3-th-cmp" aria-hidden="true">
      <i /><i /><i className={c.level === 'full' ? 'on' : ''} /><i /><i className="on" /><i className={c.level === 'full' ? 'on' : ''} />
    </span>
  );
  if (id === 'mcp') return <span className="a3-th a3-th-skip" aria-hidden="true">MCP</span>;
  if (id === 'fill') return <span className="a3-th a3-th-form" aria-hidden="true"><i className="on" /><i className="on" /><i className="on" /><i /></span>;
  if (id === 'id') return <span className="a3-th" aria-hidden="true">ID</span>;
  return <span className="a3-th a3-th-gate" aria-hidden="true">↑</span>;
}

// ─── UI 组件 ───

/** 回执行：一行 + 缩略图。悬停浮出「撤回」「下次先问我」；点击展开。 */
export function Receipt({ id, c, status, pinned, open, onToggle, onUndo, onPin, children }: {
  id: StepId; c: Choices; status: Status; pinned?: boolean; open?: boolean;
  onToggle?: () => void; onUndo?: () => void; onPin?: () => void; children?: ReactNode;
}) {
  const { title, sub } = copy(id, c);
  const mark = status === 'done' ? '✓' : status === 'running' ? '…' : status === 'redo' ? '↻' : status === 'undone' ? '↩' : status === 'ask' ? '?' : '';
  return (
    <div className={`a3-rc a3-${status} ${open ? 'is-open' : ''}`}>
      <div className="a3-rc-row" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(); } }}>
        <span className="a3-mark" aria-hidden="true">{mark}</span>
        <Thumb id={id} c={c} />
        <span className="a3-rc-text">
          <span className="a3-rc-title">{title}{pinned && <em className="a3-pin-tag">先问我</em>}</span>
          <span className="a3-rc-sub">{status === 'running' ? '正在做' : status === 'redo' ? '上一步改了，正在重做' : status === 'undone' ? '已撤回 · 你来定' : status === 'ask' ? '你标了「先问我」· 等你点头' : sub}</span>
        </span>
        {(status === 'done') && (
          <span className="a3-rc-acts" onClick={e => e.stopPropagation()}>
            {onPin && <button type="button" className="a3-ghost" onClick={onPin}>{pinned ? '取消先问我' : '下次先问我'}</button>}
            {onUndo && <button type="button" className="a3-ghost a3-undo" onClick={onUndo}>撤回</button>}
          </span>
        )}
      </div>
      {open && <div className="a3-rc-body">{children}</div>}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="a3-seg" role="group" aria-label={label}>
      {options.map(([id, name]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{name}</button>)}
    </div>
  );
}

/** 展开后的卡片内容：每一步一个，都能就地改选择。 */
export function StepBody({ id, c, onChange, onSide }: { id: StepId; c: Choices; onChange: (patch: Partial<Choices>) => void; onSide: () => void }) {
  if (id === 'tailor') return (
    <div className="a3-body">
      <div className="a3-pair">
        <span className="a3-poster font-human">美团<small>AI 应用开发工程师</small></span>
        <span className="a3-pair-mid"><b>{c.tailor === 'tailor' ? 12 : 10}</b>/17<small>JD 关键词覆盖</small></span>
        <img className="a3-face" src={photoJpg} alt="你的证件照" />
      </div>
      <Seg label="怎么投" value={c.tailor} onChange={v => onChange({ tailor: v })} options={[['tailor', '先定制再投'], ['direct', '主简历直接投']]} />
    </div>
  );
  if (id === 'adopt') return (
    <div className="a3-body">
      <Seg label="改动力度" value={c.level} onChange={v => onChange({ level: v })} options={[['light', '只改措辞'], ['full', '完整提案']]} />
      <div className="a3-cmp">
        <span className="h">主简历</span><span className="h">美团定制版</span>
        <span>AI 应用开发工程师</span><span className="after">AI 应用开发工程师（大模型应用 / Agent 方向）</span>
        <span>Java 基础 · Java 并发 · JVM …（8 组）</span><span className={c.level === 'full' ? 'after' : 'same'}>{c.level === 'full' ? '编程语言 · AI 应用开发 · 后端与框架 …（5 组）' : '不动'}</span>
        <span>1 段实习</span><span className={c.level === 'full' ? 'after' : 'same'}>{c.level === 'full' ? '+ 4 段 AI 项目（企业客服 Agent …）' : '不动'}</span>
      </div>
      <button type="button" className="a3-link" onClick={onSide}>在侧栏逐条看 24 处 →</button>
    </div>
  );
  if (id === 'mcp') return (
    <div className="a3-body">
      <p className="a3-body-q">这几个词是美团 JD 要的，但经历库里没有，所以没写。没把握的词写上去，面试容易被问穿。</p>
      <Seg label="MCP 等词" value={c.mcp} onChange={v => onChange({ mcp: v })} options={[['no', '没用过，保持不写'], ['yes', '用过，我补一条经历']]} />
    </div>
  );
  if (id === 'fill') return (
    <div className="a3-body">
      <ul className="a3-filled">
        <li><span>附件</span>{c.tailor === 'tailor' ? '美团定制版.pdf' : '主简历.pdf'}</li>
        <li><span>个人照片</span><img src={photoJpg} alt="" />简历里的证件照</li>
        <li><span>职位调剂</span>没填（选填）</li>
        <li><span>作品集</span>没传（选填）</li>
      </ul>
      <button type="button" className="a3-link" onClick={onSide}>在侧栏看网申页面 →</button>
    </div>
  );
  return null;
}

/** 关口 · 缺信息：就地填，钢笔蓝。 */
export function GateInfo({ value, onChange, onDone, done }: { value: string; onChange: (v: string) => void; onDone: () => void; done: boolean }) {
  const ok = value.trim().length >= 15;
  if (done) return null;
  return (
    <div className="a3-gate">
      <span className="a3-gate-tag">只有你知道</span>
      <label className="a3-gate-label" htmlFor="a3-id">证件号码</label>
      <input id="a3-id" className="a3-input" placeholder="18 位，只存在本机" value={value} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && ok) onDone(); }} />
      <button type="button" className="a3-go" disabled={!ok} onClick={onDone}>好了</button>
    </div>
  );
}

/** 关口 · 不可逆：按住 0.8 秒提交；中途松开就取消。键盘按住回车或空格同样有效。 */
export function GateHold({ onDone, label = '按住提交' }: { onDone: () => void; label?: string }) {
  const [p, setP] = useState(0);
  const timer = useRef<number | null>(null);
  const start = useRef(0);
  const stop = () => { if (timer.current) cancelAnimationFrame(timer.current); timer.current = null; setP(0); };
  const tick = useCallback(() => {
    const v = Math.min(1, (performance.now() - start.current) / 800);
    setP(v);
    if (v >= 1) { timer.current = null; onDone(); return; }
    timer.current = requestAnimationFrame(tick);
  }, [onDone]);
  const begin = () => { if (timer.current) return; start.current = performance.now(); timer.current = requestAnimationFrame(tick); };
  useEffect(() => () => { if (timer.current) cancelAnimationFrame(timer.current); }, []);
  return (
    <div className="a3-gate a3-gate-hold">
      <span className="a3-gate-tag">提交后改不了</span>
      <span className="a3-gate-label">美团网申 · 附件用定制版 · 20 / 20 已填</span>
      <button type="button" className={`a3-hold ${p > 0.4 ? 'is-pressing' : ''}`} style={{ ['--p' as string]: p }}
        onPointerDown={begin} onPointerUp={stop} onPointerLeave={stop}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); begin(); } }}
        onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') stop(); }}>
        <span className="a3-hold-fill" aria-hidden="true" />
        <span className="a3-hold-text">{p > 0 ? '再按一会儿…' : label}</span>
      </button>
    </div>
  );
}

/** 顶部的进度条：一直在；点暂停，AI 停在下一步之前。 */
export function RunBar({ done, total, paused, finished, onToggle }: { done: number; total: number; paused: boolean; finished: boolean; onToggle: () => void }) {
  return (
    <div className={`a3-run ${paused ? 'is-paused' : ''} ${finished ? 'is-finished' : ''}`}>
      <span className="a3-run-title">{finished ? '美团投完了' : paused ? '已暂停 · 停在下一步之前' : 'AI 正在投美团'}</span>
      <span className="a3-run-dots" aria-label={`${done} / ${total} 步`}>{Array.from({ length: total }, (_, i) => <i key={i} className={i < done ? 'on' : ''} />)}</span>
      <span className="a3-run-n">{done} / {total}</span>
      {!finished && <button type="button" className="a3-ghost" onClick={onToggle}>{paused ? '继续' : '暂停'}</button>}
    </div>
  );
}

/** 撤回 / 改选择之后的提示条：能恢复，⌘Z 同样有效。 */
export function Snack({ text, onRestore }: { text: string; onRestore?: () => void }) {
  return (
    <div className="a3-snack" role="status">
      <span>{text}</span>
      {onRestore && <button type="button" onClick={onRestore}>恢复</button>}
      <kbd>⌘Z</kbd>
    </div>
  );
}

/** 「先问我」提议：系统发现你反复改同一步，只提议，不悄悄变。 */
export function PinSuggest({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div className="a3-suggest">
      <span>「改动力度」你连着改了两次。以后这一步先停下来问你？</span>
      <button type="button" className="a3-ghost a3-strong" onClick={onYes}>好，先问我</button>
      <button type="button" className="a3-ghost" onClick={onNo}>不用</button>
    </div>
  );
}

/** 侧栏工作区：逐条改动 / 网申页面。 */
const OPS = [
  ['求职意向', '补方向标签，与 JD 标题对齐', '改写'],
  ['教育 · 课程', '补 AI 相关核心课程', '新增'],
  ['教育 · 研究方向', '把 AI 视觉推理前置', '新增'],
  ['经历 · 企业客服 Agent', '意图识别、Function Calling', '新增'],
  ['经历 · 数据分析 Agent', 'workflow 编排', '新增'],
  ['经历 · 企业内部 AI 工具', '工具接口、ReAct 执行', '新增'],
  ['经历 · 运营管理平台', 'Spring Boot + MyBatis', '新增'],
  ['技能栏', '按 JD 重组为 5 组', '改写'],
  ['荣誉奖项', '国家奖学金等提前', '改写'],
  ['经历标题', '改为「AI 应用开发经历」', '改写'],
] as const;

export function SidePanel({ kind, onClose }: { kind: 'ops' | 'form'; onClose: () => void }) {
  return (
    <aside className="a3-side" aria-label="工作区">
      <header><span className="font-human">{kind === 'ops' ? '美团定制版 · 24 处' : '美团网申页面'}</span><button type="button" className="a3-ghost" onClick={onClose}>收起</button></header>
      {kind === 'ops' ? (
        <ul className="a3-ops">
          {OPS.map(([where, why, op]) => <li key={where}><b>{op}</b><span className="w">{where}</span><span className="y">{why}</span><button type="button" className="a3-ghost">不要这处</button></li>)}
          <li className="more">…还有 14 处</li>
        </ul>
      ) : (
        <div className="a3-browser"><span>zhaopin.meituan.com</span><div className="a3-browser-page"><i /><i /><i /><i className="need" /><i /></div></div>
      )}
    </aside>
  );
}

/** 结尾的局势卡（只留下一步）。 */
export function Wrap() {
  return (
    <div className="a3-wrap">
      <div className="a3-wrap-cols">
        <div><span>今天</span>美团定制版 · 美团已提交</div>
        <div><span>在等</span>美团笔试通知，会进收件箱</div>
      </div>
      <div className="a3-wrap-next">
        {[['华为', 'AI 应用工程师 · 深圳'], ['京东', 'AI / 大模型类 · 北京'], ['九方云', 'AI 应用开发 · 上海']].map(([co, r]) => (
          <button key={co} type="button" className="a3-next"><span className="font-human">{co}</span><small>{r}</small><em>照这样再投 →</em></button>
        ))}
      </div>
    </div>
  );
}

// ─── UX：真跑一遍的引擎 ───

export interface Sim {
  status: Record<StepId, Status>; c: Choices; open: StepId | null; side: 'ops' | 'form' | null;
  paused: boolean; idValue: string; pins: Set<StepId>; snack: { text: string; prev?: Sim } | null;
  suggest: boolean; taps: number; changes: number;
}

const initial = (): Sim => ({
  status: { tailor: 'pending', adopt: 'pending', mcp: 'pending', fill: 'pending', id: 'pending', submit: 'pending' },
  c: { tailor: 'tailor', level: 'full', mcp: 'no' }, open: null, side: null, paused: false, idValue: '', pins: new Set(), snack: null, suggest: false, taps: 0, changes: 0,
});

const STEP_MS = 900;

export function useSim() {
  const [s, setS] = useState<Sim>(initial);
  const tap = useCallback((fn: (s: Sim) => Sim) => setS(prev => ({ ...fn(prev), taps: prev.taps + 1 })), []);
  // 自动推进：找到下一个该做的步骤；关口和「先问我」停下
  useEffect(() => {
    if (s.paused) return;
    const runningId = ORDER.find(id => s.status[id] === 'running' || s.status[id] === 'redo');
    if (runningId) {
      const t = window.setTimeout(() => setS(p => ({ ...p, status: { ...p.status, [runningId]: 'done' } })), STEP_MS);
      return () => window.clearTimeout(t);
    }
    if (ORDER.some(id => s.status[id] === 'undone' || s.status[id] === 'ask')) return;
    const next = ORDER.find(id => s.status[id] === 'pending');
    if (!next || GATES.includes(next)) return;
    if ((next === 'adopt' || next === 'mcp') && s.c.tailor === 'direct') {
      setS(p => ({ ...p, status: { ...p.status, [next]: 'skipped' } }));
      return;
    }
    const t = window.setTimeout(() => setS(p => ({ ...p, status: { ...p.status, [next]: p.pins.has(next) ? 'ask' : 'running' } })), 250);
    return () => window.clearTimeout(t);
  }, [s]);
  const reset = () => setS(initial());
  return { s, setS, tap, reset };
}

/** 改了某一步：它和所有下游已做过的步骤重做；直接投时定制相关的步骤跳过。 */
export function applyChange(p: Sim, id: StepId, patch: Partial<Choices>, label: string): Sim {
  const prev = p;
  const c = { ...p.c, ...patch };
  const status = { ...p.status };
  const downstream = ORDER.filter(x => x !== id && dependsOn(x, id));
  status[id] = 'done';
  for (const d of downstream) {
    if ((d === 'adopt' || d === 'mcp') && c.tailor === 'direct') status[d] = 'skipped';
    else if ((d === 'adopt' || d === 'mcp') && status[d] === 'skipped') status[d] = 'pending';
    else if (status[d] === 'done') status[d] = 'redo';
  }
  const redone = downstream.filter(d => status[d] === 'redo').length;
  const changes = id === 'adopt' && patch.level ? p.changes + 1 : p.changes;
  return {
    ...p, c, status, changes, suggest: changes >= 2 && !p.pins.has('adopt'),
    snack: { text: `${label}${redone ? `，后面 ${redone} 步已重做` : ''}`, prev },
  };
}

function dependsOn(x: StepId, y: StepId): boolean {
  return DEPS[x].some(d => d === y || dependsOn(d, y));
}

export { ORDER, GATES, initial as initialSim };
