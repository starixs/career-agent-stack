/**
 * Offer：卡片列表（薪酬拆解 / 地点 / 截止）、对比表（两个以上才有：列为 Offer，行为薪酬 / 内容匹配 / 地点 / 风险）、
 * 「你来定」（按公司分组，只列有事实依据的项）、新建 / 编辑表单。
 */
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { Button, Card, CareerPage, DueLabel, EMPTY_VALUE, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, TextInput, formatDate, formatDay, textOrUnknown } from '@/components/career/CareerPrimitives';
import { structuredKeyLabel } from '@/components/career/structuredLabels';
import type { Offer } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

const COMP_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'base', label: '月薪 / 基本' }, { key: 'months', label: '月数' }, { key: 'bonus', label: '奖金' },
  { key: 'stock', label: '股票 / 期权' }, { key: 'signing', label: '签字费' }, { key: 'total', label: '年包合计' },
];

type Comp = Record<string, unknown>;

/** 库里的答复期限是 ISO（某一刻）；日期框只认 YYYY-MM-DD，按北京时间的日期显示。 */
const BEIJING_OFFSET_MS = 8 * 3600_000;
export function deadlineInputValue(deadline: string | null | undefined): string {
  if (!deadline) return '';
  const t = Date.parse(deadline);
  return Number.isNaN(t) ? deadline : new Date(t + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function compOf(offer: Offer): Comp {
  return safeJson<Comp>(offer.comp_json, {});
}

/** 薪酬里按「月薪 × 月数」合成一段的键；其余键各成一段。 */
const BASE_KEYS = ['base', 'base_monthly'] as const;
const COMP_ORDER = ['total', 'bonus', 'stock', 'signing', 'sign_on'] as const;
const COMP_SEGMENT_LABEL: Record<string, string> = { total: '年包', bonus: '奖金', stock: '股票 / 期权', signing: '签字费', sign_on: '签字费' };

function compValue(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
}
function present(v: unknown): boolean {
  return v != null && v !== '' && typeof v !== 'object';
}

/** 「26,000 × 16 个月 · 签字费 30,000 · 含期权」：中文标签、千分位，不露接口键名。 */
export function compSummary(comp: Comp): string {
  const parts: string[] = [];
  const baseKey = BASE_KEYS.find(k => present(comp[k]));
  if (baseKey) parts.push(present(comp.months) ? `${compValue(comp[baseKey])} × ${compValue(comp.months)} 个月` : `月薪 ${compValue(comp[baseKey])}`);
  else if (present(comp.months)) parts.push(`${compValue(comp.months)} 个月`);
  for (const k of COMP_ORDER) if (present(comp[k])) parts.push(`${COMP_SEGMENT_LABEL[k]} ${compValue(comp[k])}`);
  const known = new Set<string>([...BASE_KEYS, 'months', ...COMP_ORDER, 'notes']);
  for (const [k, v] of Object.entries(comp)) {
    const label = structuredKeyLabel(k);
    if (!known.has(k) && present(v) && label) parts.push(`${label} ${compValue(v)}`);
  }
  if (present(comp.notes)) parts.push(String(comp.notes));
  return parts.length ? parts.join(' · ') : EMPTY_VALUE;
}

export interface DecisionGroup { name: string; items: string[] }

/** 需要用户自己判断的项：按公司分组，公司名只写一次；没有事实依据的空字段不生成套话。 */
export function decisionItems(offers: Offer[]): DecisionGroup[] {
  const groups: DecisionGroup[] = [];
  for (const o of offers) {
    const items: string[] = [];
    if (Object.keys(compOf(o)).length === 0) items.push('薪酬拆解还没填');
    if (o.risk_notes) items.push(`风险：${o.risk_notes}`);
    if (o.deadline) items.push(`${formatDay(o.deadline)}前答复`);
    if (items.length) groups.push({ name: `${textOrUnknown(o.company_name)} · ${textOrUnknown(o.title)}`, items });
  }
  return groups;
}

export default function CareerOffer({ embedded = false, actionsSlot = null }: { embedded?: boolean; actionsSlot?: HTMLElement | null } = {}) {
  const query = useCareerQuery(careerApi.offers, ['offer']);
  const offers = useMemo(() => query.data ?? [], [query.data]);
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);
  const decisions = useMemo(() => decisionItems(offers), [offers]);
  const action = <Button onClick={() => setEditing(editing === 'new' ? null : 'new')}><Plus className="h-3.5 w-3.5" />新建 Offer</Button>;
  const hoisted = embedded && actionsSlot;

  return (
    <CareerPage embedded={embedded} title="Offer" actions={hoisted ? undefined : action}>
      {hoisted && createPortal(action, actionsSlot)}
      <div className="max-w-6xl space-y-8 px-6 py-6">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {editing && (
          <OfferForm
            key={editing === 'new' ? 'new' : editing.id}
            offer={editing === 'new' ? null : editing}
            onDone={() => { setEditing(null); query.reload(); }}
            onCancel={() => setEditing(null)}
          />
        )}
        {query.loading && !query.data && <LoadingRow />}
        {!query.loading && offers.length === 0 && (
          <EmptyState title="还没有 Offer" />
        )}
        {offers.length > 0 && (
          <>
            <section>
              <SectionTitle count={offers.length}>Offer</SectionTitle>
              <div className="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
                {offers.map(o => (
                  <Card key={o.id} title={`${textOrUnknown(o.company_name)} · ${textOrUnknown(o.title)}`} extra={<Button variant="ghost" size="sm" onClick={() => setEditing(o)}>编辑</Button>}>
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--muted)]">薪酬</dt><dd className="text-[var(--ink)]">{compSummary(compOf(o))}</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--muted)]">地点</dt><dd className="text-[var(--ink)]">{textOrUnknown(o.location)}</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--muted)]">截止</dt><dd className="text-[var(--ink)]"><DueLabel at={o.deadline} suffix="前答复" /></dd></div>
                    </dl>
                  </Card>
                ))}
              </div>
            </section>
            {offers.length > 1 && <section>
              <SectionTitle>对比</SectionTitle>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="border-b border-[var(--line-2)] text-left text-[var(--muted)]">
                    <tr>
                      <th className="w-28 px-2 py-2 text-xs font-medium">维度</th>
                      {offers.map(o => <th key={o.id} className="px-2 py-2 font-semibold text-[var(--ink)]">{textOrUnknown(o.company_name)}<div className="font-normal text-[var(--muted)]">{textOrUnknown(o.title)}</div></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: '薪酬', render: (o: Offer) => compSummary(compOf(o)) },
                      { label: '内容匹配', render: (o: Offer) => textOrUnknown(o.content_match) },
                      { label: '地点', render: (o: Offer) => textOrUnknown(o.location) },
                      { label: '风险', render: (o: Offer) => textOrUnknown(o.risk_notes) },
                      { label: '截止', render: (o: Offer) => formatDate(o.deadline) },
                    ].map(row => (
                      <tr key={row.label} className="border-b border-[var(--line)] align-top">
                        <td className="px-2 py-2.5 text-xs font-medium text-[var(--muted)]">{row.label}</td>
                        {offers.map(o => <td key={o.id} className="px-2 py-2.5 text-[var(--ink)]">{row.render(o)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>}
            {decisions.length > 0 && <section>
              <SectionTitle>你来定</SectionTitle>
              <dl className="space-y-3 text-sm">
                {decisions.map(g => (
                  <div key={g.name}>
                    <dt className="font-medium text-[var(--ink)]">{g.name}</dt>
                    <dd><ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--ink-2)]">{g.items.map(item => <li key={item}>{item}</li>)}</ul></dd>
                  </div>
                ))}
              </dl>
            </section>}
          </>
        )}
      </div>
    </CareerPage>
  );
}

function OfferForm({ offer, onDone, onCancel }: { offer: Offer | null; onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const initialComp = offer ? compOf(offer) : {};
  const [form, setForm] = useState({
    company_name: offer?.company_name ?? '', title: offer?.title ?? '', location: offer?.location ?? '',
    content_match: offer?.content_match ?? '', risk_notes: offer?.risk_notes ?? '', deadline: deadlineInputValue(offer?.deadline),
  });
  const [comp, setComp] = useState<Record<string, string>>(Object.fromEntries(COMP_FIELDS.map(f => [f.key, initialComp[f.key] == null ? '' : String(initialComp[f.key])])));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = () => action.run(async () => {
    if (!form.company_name.trim()) throw new Error('请填写公司');
    const compOut: Record<string, unknown> = { ...initialComp };
    for (const f of COMP_FIELDS) {
      const v = comp[f.key].trim();
      if (v === '') delete compOut[f.key];
      else compOut[f.key] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    const body = {
      company_name: form.company_name.trim(), title: form.title || null, location: form.location || null,
      content_match: form.content_match || null, risk_notes: form.risk_notes || null,
      // 没动日期就不回写：否则来信里带具体时刻的期限会被改成当天结束
      deadline: offer && form.deadline === deadlineInputValue(offer.deadline) ? undefined : form.deadline || null,
      comp_json: JSON.stringify(compOut),
    };
    if (offer) await careerApi.updateOffer(offer.id, body); else await careerApi.createOffer(body);
    onDone();
  });

  return (
    <Card title={offer ? '编辑 Offer' : '新建 Offer'}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="公司"><TextInput value={form.company_name} onChange={set('company_name')} /></Field>
        <Field label="岗位"><TextInput value={form.title} onChange={set('title')} /></Field>
        <Field label="地点"><TextInput value={form.location} onChange={set('location')} /></Field>
        <Field label="截止日期"><TextInput type="date" value={form.deadline} onChange={set('deadline')} /></Field>
        <Field label="内容匹配"><TextInput value={form.content_match} onChange={set('content_match')} placeholder="例如：和目标方向一致 / 偏运维" /></Field>
      </div>
      <div className="mt-2">
        <SectionTitle>薪酬拆解</SectionTitle>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          {COMP_FIELDS.map(f => (
            <Field key={f.key} label={f.label}><TextInput value={comp[f.key]} onChange={e => setComp(c => ({ ...c, [f.key]: e.target.value }))} /></Field>
          ))}
        </div>
      </div>
      <div className="mt-2"><Field label="风险备注"><TextArea value={form.risk_notes} onChange={set('risk_notes')} /></Field></div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}
