/**
 * 方案三预览的两页：UX（电脑上的对话里真跑一遍，三类人一键演示并计点击次数）和 UI（组件在各状态下的样子）。
 */
import { useEffect, useRef, useState } from 'react';

import {
  applyChange, GateHold, GateInfo, initialSim, ORDER, PinSuggest, Receipt, RunBar, SidePanel, Snack, StepBody, useSim, Wrap,
  type Choices, type Sim, type StepId,
} from './a3';

// ─── UX ───

type Persona = 'easy' | 'co' | 'control';
const PERSONA: Record<Persona, { name: string; who: string; script: string[] }> = {
  easy: { name: '省心型', who: '想一路顺下来', script: ['什么都不点，看 AI 一路做完', '填证件号码', '按住提交'] },
  co: { name: '协作型', who: '想边看边一起改', script: ['点开「采纳完整提案」看改了什么', '把改动力度切到「只改措辞」，后面的步骤自动重做', '填证件号码', '按住提交'] },
  control: { name: '掌控型', who: '什么都想自己定', script: ['一开始就点「暂停」', '点开「为美团定制」确认', '标「下次先问我」', '继续', '在侧栏逐条看 24 处', '填证件号码', '按住提交'] },
};

const ID_DEMO = '4201••••••••••••18';

export function UxPage() {
  const { s, setS, tap, reset } = useSim();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [line, setLine] = useState(-1);
  const sRef = useRef<Sim>(s);
  const colRef = useRef<HTMLDivElement>(null);
  const statusKey = ORDER.map(id => s.status[id]).join();
  useEffect(() => { const el = colRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [statusKey]);
  sRef.current = s;
  const done = ORDER.filter(id => s.status[id] === 'done' || s.status[id] === 'skipped').length;
  const finished = s.status.submit === 'done';

  const change = (id: StepId, patch: Partial<Choices>, label: string) => tap(p => ({ ...applyChange(p, id, patch, label), open: p.open }));
  const undo = (id: StepId) => tap(p => ({ ...p, status: { ...p.status, [id]: 'undone' }, open: id, snack: { text: '已撤回，这一步你来定', prev: p } }));
  const restore = () => setS(p => (p.snack?.prev ? { ...p.snack.prev, taps: p.taps + 1, snack: null } : p));

  // 提示条 5 秒后自己消失
  useEffect(() => { if (!s.snack) return; const t = window.setTimeout(() => setS(p => ({ ...p, snack: null })), 5000); return () => window.clearTimeout(t); }, [s.snack, setS]);

  // ⌘Z：恢复上一次撤回或改动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); restore(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 一键演示：按脚本替用户操作，每一步都计一次点击
  const wait = (ok: (x: Sim) => boolean) => new Promise<void>(res => { const t = window.setInterval(() => { if (ok(sRef.current)) { window.clearInterval(t); res(); } }, 120); });
  const pause = (ms: number) => new Promise(r => window.setTimeout(r, ms));
  const demo = async (who: Persona) => {
    reset(); setPersona(who); setLine(-1);
    await pause(300);
    const say = async (i: number) => { setLine(i); await pause(900); };
    if (who === 'easy') {
      await say(0);
      await wait(x => x.status.fill === 'done');
      await say(1); tap(p => ({ ...p, idValue: ID_DEMO, status: { ...p.status, id: 'done' } }));
      await say(2); tap(p => ({ ...p, status: { ...p.status, submit: 'done' } }));
    } else if (who === 'co') {
      await wait(x => x.status.adopt === 'done');
      await say(0); tap(p => ({ ...p, open: 'adopt' }));
      await say(1); change('adopt', { level: 'light' }, '已改成「只改措辞」');
      await wait(x => x.status.fill === 'done');
      await say(2); tap(p => ({ ...p, idValue: ID_DEMO, status: { ...p.status, id: 'done' } }));
      await say(3); tap(p => ({ ...p, status: { ...p.status, submit: 'done' } }));
    } else {
      await say(0); tap(p => ({ ...p, paused: true }));
      await wait(x => x.status.tailor === 'done');
      await say(1); tap(p => ({ ...p, open: 'tailor' }));
      await say(2); tap(p => ({ ...p, pins: new Set([...p.pins, 'tailor']) }));
      await say(3); tap(p => ({ ...p, paused: false, open: null }));
      await wait(x => x.status.adopt === 'done');
      await say(4); tap(p => ({ ...p, side: 'ops' }));
      await wait(x => x.status.fill === 'done');
      await say(5); tap(p => ({ ...p, side: null, idValue: ID_DEMO, status: { ...p.status, id: 'done' } }));
      await say(6); tap(p => ({ ...p, status: { ...p.status, submit: 'done' } }));
    }
    setLine(99);
  };

  const visible = ORDER.filter(id => s.status[id] !== 'pending' && s.status[id] !== 'skipped' && id !== 'id' && id !== 'submit');
  const gateId = s.status.fill === 'done' && s.status.id !== 'done';
  const gateSubmit = s.status.id === 'done' && s.status.submit !== 'done';

  return (
    <div className="a3-ux">
      <div className="a3-ux-bar">
        <span className="a3-ux-label">一键演示三类人</span>
        {(Object.keys(PERSONA) as Persona[]).map(k => (
          <button key={k} type="button" className={`a3-persona ${persona === k ? 'is-on' : ''}`} onClick={() => void demo(k)}>{PERSONA[k].name}<small>{PERSONA[k].who}</small></button>
        ))}
        <button type="button" className="a3-persona" onClick={() => { reset(); setPersona(null); setLine(-1); }}>自己点<small>从头开始</small></button>
        <span className="a3-taps"><b>{s.taps}</b> 次操作</span>
      </div>
      {persona && (
        <ol className="a3-script">
          {PERSONA[persona].script.map((t, i) => <li key={t} className={i < line ? 'done' : i === line ? 'now' : ''}>{t}</li>)}
        </ol>
      )}

      <div className={`a3-desk ${s.side ? 'has-side' : ''}`}>
        <div className="a3-chat">
          <div className="a3-chat-col" ref={colRef}>
            <div className="a3-user">帮我投美团那个 AI 应用开发。</div>
            <p className="a3-say">好，我先做，你随时点开看、随时撤回。只有你才知道的信息和提交，我会停下来等你。</p>
            <RunBar done={Math.min(done, 6)} total={6} paused={s.paused} finished={finished} onToggle={() => tap(p => ({ ...p, paused: !p.paused }))} />
            <div className="a3-film">
              {visible.map(id => (
                <div key={id}>
                  <Receipt id={id} c={s.c} status={s.status[id]} pinned={s.pins.has(id)} open={s.open === id && id !== 'id'}
                    onToggle={() => tap(p => ({ ...p, open: p.open === id ? null : id }))}
                    onUndo={() => undo(id)}
                    onPin={() => tap(p => { const pins = new Set(p.pins); if (pins.has(id)) pins.delete(id); else pins.add(id); return { ...p, pins }; })}>
                    <StepBody id={id} c={s.c} onSide={() => tap(p => ({ ...p, side: id === 'fill' ? 'form' : 'ops' }))}
                      onChange={patch => change(id, patch, '已改')} />
                    {s.status[id] === 'undone' && <button type="button" className="a3-link" onClick={() => change(id, {}, '按原样继续')}>按原样继续 →</button>}
                    {s.status[id] === 'ask' && <button type="button" className="a3-go" onClick={() => tap(p => ({ ...p, status: { ...p.status, [id]: 'running' }, open: null }))}>就这样，继续</button>}
                  </Receipt>
                  {id === 'adopt' && s.suggest && <PinSuggest onYes={() => tap(p => ({ ...p, pins: new Set([...p.pins, 'adopt']), suggest: false }))} onNo={() => tap(p => ({ ...p, suggest: false, changes: -99 }))} />}
                </div>
              ))}
              {gateId && <GateInfo value={s.idValue} onChange={v => setS(p => ({ ...p, idValue: v }))} done={false} onDone={() => tap(p => ({ ...p, status: { ...p.status, id: 'done' } }))} />}
              {s.status.id === 'done' && <Receipt id="id" c={s.c} status="done" />}
              {gateSubmit && <GateHold onDone={() => tap(p => ({ ...p, status: { ...p.status, submit: 'done' } }))} />}
              {finished && (<><p className="a3-done-line">✓ 美团网申已提交 · 刚刚</p><Wrap /></>)}
            </div>
          </div>
          {s.snack && <Snack text={s.snack.text} onRestore={s.snack.prev ? restore : undefined} />}
          <div className="a3-composer">有什么想改的，直接说…<span>↑</span></div>
        </div>
        {s.side && <SidePanel kind={s.side} onClose={() => tap(p => ({ ...p, side: null }))} />}
      </div>

      <section className="a3-ux-notes">
        <h3 className="font-human">交互规则</h3>
        <div className="a3-rules">
          <div><b>AI 先做</b>收到指令就一路往下，每做完一步留一条回执。顶部进度条一直在，点「暂停」就停在下一步之前。</div>
          <div><b>只在两种关口停</b>只有你知道的信息（证件号码）和不可逆的动作（提交）。拿不准但有安全做法的事先按安全的做（没把握的词不写），回执上写清楚。</div>
          <div><b>点开看</b>点回执就地展开成卡片，可以直接改选择；更细的内容在右侧侧栏看，不离开对话。</div>
          <div><b>撤回</b>悬停回执出现「撤回」：退回这一步让你定。改了某一步，后面依赖它的步骤自动重做。提示条上可以「恢复」，⌘Z 同样有效。</div>
          <div><b>先问我</b>任一步都能标「下次先问我」，以后这一步会停下来等你点头。系统发现你反复改同一步，只会提议，不会悄悄改。</div>
          <div><b>按住提交</b>不可逆的动作要按住 0.8 秒，中途松开就取消；键盘按住回车同样有效。防误点，也给一个「我确定」的手感。</div>
        </div>
        <h3 className="font-human">三类人的操作次数</h3>
        <table className="a3-table">
          <thead><tr><th /><th>看到什么</th><th>操作</th><th>怎么切换</th></tr></thead>
          <tbody>
            <tr><th>省心型</th><td>回执一条条往下走，只在两个关口停</td><td><b>2</b></td><td rowSpan={3}>没有模式：想看哪一步就点哪一步；想以后都管某一步就标「先问我」</td></tr>
            <tr><th>协作型</th><td>同一卷回执，点开在意的那一两步改</td><td><b>4</b></td></tr>
            <tr><th>掌控型</th><td>同一卷回执，暂停、逐条看、标「先问我」</td><td><b>7</b> 首次 · 之后标过的步骤自动停</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ─── UI ───

const C: Choices = { tailor: 'tailor', level: 'full', mcp: 'no' };
const noop = () => {};

function Spec({ name, note, children, wide }: { name: string; note: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <figure className={`a3-spec ${wide ? 'wide' : ''}`}>
      <div className="a3-spec-stage">{children}</div>
      <figcaption><b>{name}</b>{note}</figcaption>
    </figure>
  );
}

export function UiPage() {
  const [v, setV] = useState('');
  return (
    <div className="a3-ui">
      <section>
        <h3 className="font-human">一、回执行 · 七种状态</h3>
        <p className="a3-ui-lead">一行高 56px：左边状态标记 + 40px 缩略图，中间标题和一行说明，右边的操作只在悬停时出现。只有「等你」类状态用钢笔蓝，其余是墨色和灰阶。</p>
        <div className="a3-grid">
          <Spec name="完成" note="墨色勾；悬停出「下次先问我」「撤回」"><Receipt id="tailor" c={C} status="done" onUndo={noop} onPin={noop} /></Spec>
          <Spec name="正在做" note="只出现一行「正在做」，没有动画；做完直接换成完成"><Receipt id="adopt" c={C} status="running" /></Spec>
          <Spec name="重做中" note="上游改了，这一步自动重做"><Receipt id="fill" c={C} status="redo" /></Spec>
          <Spec name="已撤回" note="退回这一步，展开等你定"><Receipt id="adopt" c={C} status="undone" /></Spec>
          <Spec name="安全默认" note="拿不准的事按安全的做，回执写清楚「没做什么」"><Receipt id="mcp" c={C} status="done" onUndo={noop} onPin={noop} /></Spec>
          <Spec name="先问我" note="标过的步骤停下等你点头，标题带标签"><Receipt id="tailor" c={C} status="ask" pinned /></Spec>
          <Spec name="悬停" note="鼠标移上去才出操作，平时不占视觉"><div className="a3-force-hover"><Receipt id="adopt" c={C} status="done" onUndo={noop} onPin={noop} /></div></Spec>
        </div>
      </section>

      <section>
        <h3 className="font-human">二、展开后的卡片</h3>
        <p className="a3-ui-lead">点回执就地展开，卡片里能直接改选择；改了马上生效，下游自动重做。卡片不加底色和边框，靠左边一道细线和回执连在一起。</p>
        <div className="a3-grid two">
          <Spec name="为美团定制" note="岗位 × 你，中间是关键词覆盖；下面一个二选一"><Receipt id="tailor" c={C} status="done" open><StepBody id="tailor" c={C} onChange={noop} onSide={noop} /></Receipt></Spec>
          <Spec name="采纳改动" note="改前改后并排 + 改动力度开关；细节去侧栏"><Receipt id="adopt" c={C} status="done" open><StepBody id="adopt" c={C} onChange={noop} onSide={noop} /></Receipt></Spec>
        </div>
      </section>

      <section>
        <h3 className="font-human">三、两种关口</h3>
        <p className="a3-ui-lead">只有这两种会停下来。都用钢笔蓝，左边一道粗线，比回执更显眼。</p>
        <div className="a3-grid two">
          <Spec name="缺信息" note="就地填，回车提交；写明数据存在哪"><GateInfo value={v} onChange={setV} onDone={noop} done={false} /></Spec>
          <Spec name="不可逆" note="按住 0.8 秒，进度从左往右填满；松开取消"><GateHold onDone={noop} /></Spec>
        </div>
      </section>

      <section>
        <h3 className="font-human">四、贯穿全程的小件</h3>
        <div className="a3-grid two">
          <Spec name="进度条 · 运行中" note="在对话顶部，点暂停停在下一步之前"><RunBar done={3} total={6} paused={false} finished={false} onToggle={noop} /></Spec>
          <Spec name="进度条 · 已暂停" note="同一位置，文字和按钮换成继续"><RunBar done={3} total={6} paused finished={false} onToggle={noop} /></Spec>
          <Spec name="撤回提示条" note="撤回或改动后出现，能恢复，⌘Z 同样有效"><Snack text="已改成「只改措辞」，后面 1 步已重做" onRestore={noop} /></Spec>
          <Spec name="「先问我」提议" note="反复改同一步时提议，点了才生效"><PinSuggest onYes={noop} onNo={noop} /></Spec>
        </div>
      </section>

      <section>
        <h3 className="font-human">五、侧栏和结尾</h3>
        <div className="a3-grid two">
          <Spec name="侧栏 · 逐条改动" note="在对话右边，不离开对话；每处都能单独不要"><div className="a3-side-demo"><SidePanel kind="ops" onClose={noop} /></div></Spec>
          <Spec name="结尾" note="只留「在等什么」和「下一步」，下一步是能直接点的岗位"><Wrap /></Spec>
        </div>
      </section>
    </div>
  );
}

export { initialSim };
