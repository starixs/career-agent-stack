/**
 * 一件要你的事（规范 §5.3）：左图右字。图是涉及的公司（一片小签 / 两张中海报 / 一张大海报），
 * 右边标题（文楷）、一行原因、期限大字（钢笔蓝）、来源，最多两个按钮。
 */
import { useState } from 'react';

import { TextInput } from '../CareerPrimitives';
import { actionLabels, dueText, sourceText, subText } from './askText';
import { CompanyPoster } from './CompanyPoster';
import type { AskView } from './deliveryApi';
import { openLiveDrawer } from '../CareerLiveDrawer';

/** 缺信息那一片最多铺几张小签：再多就看不清了，数字在原因行里。 */
const MOSAIC_MAX = 20;
const PAIR_MAX = 4;

function AskImage({ ask }: { ask: AskView }) {
  const cs = ask.companies;
  if (!cs.length) return null;
  if (ask.kind === 'info' || ask.kind === 'start' || (ask.kind === 'login' && cs.length > PAIR_MAX)) {
    return <div className="cd-mosaic">{cs.slice(0, MOSAIC_MAX).map(c => <CompanyPoster key={c.name} company={c} size="xs" state="ask" />)}</div>;
  }
  if (ask.kind === 'login') return <div className="cd-pair">{cs.map(c => <CompanyPoster key={c.name} company={c} size="md" state="ask" />)}</div>;
  return <CompanyPoster company={cs[0]} size="lg" state="ask" role={ask.detail && ask.kind === 'review' ? ask.detail.replace(cs[0].name, '').trim() : undefined} />;
}

function FieldInputs({ ask, values, onChange }: { ask: AskView; values: Record<string, string>; onChange: (label: string, v: string) => void }) {
  const fields = (ask.fields ?? []).filter(f => f.fillable);
  if (!fields.length) return null;
  return (
    <div className="cd-fields">
      {fields.map(f => (
        <label key={f.label}>
          {fields.length > 1 && <span>{f.label}</span>}
          <TextInput aria-label={f.label} type={f.sensitive ? 'password' : 'text'} autoComplete="off" placeholder={f.label} value={values[f.label] ?? ''} onChange={e => onChange(f.label, e.target.value)} />
        </label>
      ))}
    </div>
  );
}

export function AskCard({ ask, busy, error, onGo, onLater }: {
  ask: AskView; busy: boolean; error: string | null;
  onGo: (values: Record<string, string>) => Promise<unknown> | void; onLater: () => Promise<unknown> | void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const labels = actionLabels(ask);
  const due = dueText(ask);
  const src = sourceText(ask);
  const sub = subText(ask);
  const fillable = (ask.fields ?? []).filter(f => f.fillable);
  const blocked = ask.kind === 'info' && fillable.length > 0 && !fillable.some(f => values[f.label]?.trim());
  const pageOnly = ask.kind === 'info' && (ask.fields ?? []).some(f => !f.fillable);
  return (
    <article className={`cd-ask cd-ask-${ask.kind}`} data-testid={`ask-card-${ask.kind}`}>
      <div className="cd-ask-img"><AskImage ask={ask} /></div>
      <div className="cd-ask-text">
        <h3 className="cd-ask-title font-human">{ask.title}</h3>
        {sub && <p className="cd-ask-sub">{sub}</p>}
        {due && <p className="cd-due">{due}</p>}
        {src && <p className="cd-src">{src}</p>}
        {ask.kind === 'info' && <FieldInputs ask={ask} values={values} onChange={(l, v) => setValues(s => ({ ...s, [l]: v }))} />}
        <div className="cd-acts">
          <button type="button" className="cd-go" disabled={busy || blocked} onClick={() => void onGo(values)}>{labels.go}</button>
          <button type="button" className="cd-later" disabled={busy} onClick={() => void onLater()}>{labels.later}</button>
          {pageOnly && <button type="button" className="cd-later" onClick={() => openLiveDrawer()}>去页面上看</button>}
        </div>
        {ask.kind === 'review' && <p className="cd-warn">投出后撤不回</p>}
        {ask.kind === 'info' && fillable.some(f => f.vault_field) && <p className="cd-warn">只存在本机私密库，填表时在本地替换，助理看不到原文</p>}
        {error && <p role="alert" className="cd-err">{error}</p>}
      </div>
    </article>
  );
}
