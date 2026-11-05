/**
 * 一件要你的事（规范 §5.3）：左图右字。图是涉及的公司（一片小签 / 两张中海报 / 一张大海报），
 * 右边标题（文楷）、一行原因、期限大字（钢笔蓝）、来源，最多两个按钮。
 */
import { useState } from 'react';

import { MailAskCard, type MailAct } from '../mail-apply/MailAskCard';
import { actionLabels, dueText, sourceText, subText } from './askText';
import { CompanyPoster } from './CompanyPoster';
import type { AskField, AskView } from './deliveryApi';
import { showApplicationPage } from './showPage';

/** 缺信息那一片最多铺几张小签：再多就看不清了，数字在原因行里。 */
const MOSAIC_MAX = 20;
const PAIR_MAX = 4;
/** 可选项不超过这么多就直接摆出来点选；再多（省份、国家）改成打字时提示可选项。 */
const CHOICE_CHIPS_MAX = 8;

/** 跨边界来的选项：只认非空字符串。 */
function optionsOf(f: AskField): string[] {
  return Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0) : [];
}

function AskImage({ ask }: { ask: AskView }) {
  const cs = ask.companies;
  if (!cs.length) return null;
  if (ask.kind === 'info' || ask.kind === 'start' || (ask.kind === 'review' && cs.length > 1) || (ask.kind === 'login' && cs.length > PAIR_MAX)) {
    return <div className="cd-mosaic">{cs.slice(0, MOSAIC_MAX).map(c => <CompanyPoster key={c.name} company={c} size="xs" state="ask" />)}</div>;
  }
  if (ask.kind === 'login') return <div className="cd-pair">{cs.map(c => <CompanyPoster key={c.name} company={c} size="md" state="ask" />)}</div>;
  return <CompanyPoster company={cs[0]} size="lg" state="ask" role={ask.role} />;
}

const isChoice = (f: AskField) => { const n = optionsOf(f).length; return n > 0 && n <= CHOICE_CHIPS_MAX; };

/** 一格的作答：网页给了少量可选项就摆出来点选；选项多就打字时提示；没有选项才是空白输入框（2026-10-31 小鹏：性别、学历类型都让学生猜写法）。 */
function FieldInput({ f, value, onChange }: { f: AskField; value: string; onChange: (v: string) => void }) {
  const options = optionsOf(f);
  if (isChoice(f)) {
    return (
      <div className="cd-choices" role="radiogroup" aria-label={f.label}>
        {options.map(o => <button key={o} type="button" role="radio" aria-checked={value === o} className={`cd-choice${value === o ? ' cd-choice-on' : ''}`} onClick={() => onChange(o)}>{o}</button>)}
      </div>
    );
  }
  const listId = options.length ? `cd-opts-${f.label}` : undefined;
  return (
    <>
      <input className="cd-input" aria-label={f.label} type={f.sensitive ? 'password' : 'text'} autoComplete="off" placeholder={options.length ? `输入几个字选，如「${options[0]}」` : f.text ?? f.label} list={listId} value={value} onChange={e => onChange(e.target.value)} />
      {listId && <datalist id={listId}>{options.map(o => <option key={o} value={o} />)}</datalist>}
    </>
  );
}

function FieldInputs({ ask, values, onChange }: { ask: AskView; values: Record<string, string>; onChange: (label: string, v: string) => void }) {
  const fields = (ask.fields ?? []).filter(f => f.fillable);
  if (!fields.length) return null;
  // 点选组不能包在 <label> 里：WebKit 会把点第一个选项的点击再转给 label 关联的控件，第一个选项点不上（2026-10-31 实测「男」点不上）
  return (
    <div className="cd-fields">
      {fields.map(f => {
        const input = <FieldInput f={f} value={values[f.label] ?? ''} onChange={v => onChange(f.label, v)} />;
        const title = fields.length > 1 && <span>{f.text ?? f.label}</span>;
        return isChoice(f)
          ? <div key={f.label} className="cd-field">{title}{input}</div>
          : <label key={f.label} className="cd-field">{title}{input}</label>;
      })}
    </div>
  );
}

/** 这几类卡都要能「去看」那一家的页面：过目、补信息（他得知道问的是页面上哪一格）、投出了吗。 */
const LOOKABLE = new Set(['review', 'info', 'confirm', 'choice']);

export function AskCard({ ask, busy, error, onGo, onLater, onAct }: {
  ask: AskView; busy: boolean; error: string | null;
  onGo: (values: Record<string, string>) => Promise<unknown> | void; onLater: () => Promise<unknown> | void;
  /** 卡片自己决定落什么（邮件卡按勾选发出）；卡组给，结果照样交回卡组。 */
  onAct?: MailAct;
}) {
  // 开放题小芽已经写好一版：预填进去，他看一眼确认或改几个字
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((ask.fields ?? []).filter(f => f.fillable && f.draft).map(f => [f.label, f.draft!])));
  // 发邮件前过目：整封邮件的预览，不走通用布局
  if (ask.mail && onAct) return <MailAskCard ask={ask} mail={ask.mail} busy={busy} error={error} onAct={onAct} />;
  const labels = actionLabels(ask);
  const due = dueText(ask);
  const src = sourceText(ask);
  const sub = subText(ask);
  const fillable = (ask.fields ?? []).filter(f => f.fillable);
  const blocked = (ask.kind === 'info' && fillable.length > 0 && !fillable.some(f => values[f.label]?.trim())) || (ask.kind === 'choice' && !values.choice);
  // 投前过目只要两个动作：投出、去看（2026-11-05 用户：必填 0/0、先不投、撤不回这些字太多，过目却没地方看）
  const look = LOOKABLE.has(ask.kind);
  return (
    <article className={`cd-ask cd-ask-${ask.kind}`} data-testid={`ask-card-${ask.kind}`}>
      <div className="cd-ask-img"><AskImage ask={ask} /></div>
      <div className="cd-ask-text">
        <h3 className="cd-ask-title font-human">{ask.title}</h3>
        {sub && <p className="cd-ask-sub">{sub}</p>}
        {due && <p className="cd-due">{due}</p>}
        {src && <p className="cd-src">{src}</p>}
        {ask.kind === 'info' && <FieldInputs ask={ask} values={values} onChange={(l, v) => setValues(s => ({ ...s, [l]: v }))} />}
        {ask.kind === 'choice' && ask.choice && (
          <div className="cd-choices" role="radiogroup" aria-label={ask.choice.question}>
            {ask.choice.options.map(o => <button key={o} type="button" role="radio" aria-checked={values.choice === o} className={`cd-choice${values.choice === o ? ' cd-choice-on' : ''}`} onClick={() => setValues(s => ({ ...s, choice: o }))}>{o}</button>)}
          </div>
        )}
        <div className="cd-acts">
          <button type="button" className="cd-go" disabled={busy || blocked} onClick={() => void onGo(values)}>{labels.go}</button>
          {ask.kind === 'review'
            ? <button type="button" className="cd-later" onClick={() => void showApplicationPage(ask.application_ids[0])}>去看</button>
            : <button type="button" className="cd-later" disabled={busy} onClick={() => void onLater()}>{labels.later}</button>}
          {look && ask.kind !== 'review' && <button type="button" className="cd-later" onClick={() => void showApplicationPage(ask.application_ids[0])}>去看</button>}
        </div>
        {error && <p role="alert" className="cd-err">{error}</p>}
      </div>
    </article>
  );
}
