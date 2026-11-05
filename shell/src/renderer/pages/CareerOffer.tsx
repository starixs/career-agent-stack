/**
 * Offer 对比：一张表（列为 Offer；行先是答复期限，再是拆开的薪酬、地点、内容匹配、风险），
 * 「需要你自己决定的项」、新建 / 编辑表单。「让小芽拆开比」把手上的 Offer 交给 Offer 对比技能：
 * 薪酬换算成同一口径、房租通勤带出处、期限谁先到，结果在对话里。
 */
import { Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { Button, Card, CareerPage, DueLabel, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, TextInput, formatDate, textOrUnknown, useSuggestToChat } from '@/components/career/CareerPrimitives';
import type { Offer } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { pageSurfaceId } from '@/features/career-shell/pageSurface';

const COMP_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'base', label: '月薪 / 基本' }, { key: 'months', label: '月数' }, { key: 'bonus', label: '奖金' },
  { key: 'stock', label: '股票 / 期权' }, { key: 'signing', label: '签字费' }, { key: 'total', label: '年包合计' },
];

/** 从这一页发出去的话，回复结束后带他回到 Offer 对比。 */
const SURFACE = pageSurfaceId({ kind: 'career-dossier', view: 'offer' });

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

/** 需要用户自己判断的项：缺数据标「未知」，不编造。 */
export function decisionItems(offers: Offer[]): string[] {
  const items: string[] = [];
  for (const o of offers) {
    const name = `${textOrUnknown(o.company_name)} · ${textOrUnknown(o.title)}`;
    const comp = compOf(o);
    if (Object.keys(comp).length === 0) items.push(`${name}：薪酬拆解未知，需要你补充`);
    if (!o.content_match) items.push(`${name}：工作内容是否匹配，需要你判断`);
    if (o.risk_notes) items.push(`${name}：风险「${o.risk_notes}」是否可接受，需要你决定`);
    if (o.deadline) items.push(`${name}：${formatDate(o.deadline)} 前要答复`);
  }
  if (offers.length > 1) items.push('多个 Offer 之间的取舍只能由你决定，助理只负责把事实并排摆出来。');
  return items;
}

const UNKNOWN = <span className="text-[var(--subtle)]">未知</span>;

/** 拆开的薪酬项以外，来信或对话里记下的其他薪酬说明（补贴、公积金比例……）。 */
function otherComp(comp: Comp): string | null {
  const parts = Object.entries(comp)
    .filter(([key, value]) => !COMP_FIELDS.some(field => field.key === key) && value != null && value !== '' && typeof value !== 'object')
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.length ? parts.join(' · ') : null;
}

interface CompareRow { label: string; render: (offer: Offer) => ReactNode }

/** 对比表的行：答复期限排最前（哪个先到一眼看清）；薪酬一项一行，只列至少有一个 Offer 填了的项。 */
function compareRows(offers: Offer[]): CompareRow[] {
  const comps = new Map(offers.map(offer => [offer.id, compOf(offer)]));
  const compOfRow = (offer: Offer): Comp => comps.get(offer.id) ?? {};
  const filled = (key: string) => offers.some(offer => { const value = compOfRow(offer)[key]; return value != null && value !== ''; });
  const text = (value: string | null | undefined): ReactNode => (value ? value : UNKNOWN);
  return [
    { label: '答复期限', render: offer => (offer.deadline ? <DueLabel at={offer.deadline} suffix="前答复" /> : UNKNOWN) },
    ...COMP_FIELDS.filter(field => filled(field.key)).map(field => ({
      label: field.label,
      render: (offer: Offer): ReactNode => { const value = compOfRow(offer)[field.key]; return value == null || value === '' ? UNKNOWN : <span className="tabular-nums">{String(value)}</span>; },
    })),
    ...(offers.some(offer => otherComp(compOfRow(offer))) ? [{ label: '其他薪酬', render: (offer: Offer) => text(otherComp(compOfRow(offer))) }] : []),
    { label: '地点', render: offer => text(offer.location) },
    { label: '内容匹配', render: offer => text(offer.content_match) },
    { label: '风险', render: offer => text(offer.risk_notes) },
  ];
}

function OfferTable({ offers, onEdit }: { offers: Offer[]; onEdit: (offer: Offer) => void }) {
  return (
    <section aria-label="对比" className="overflow-x-auto">
      <table className="border-collapse text-sm">
        <thead className="border-b border-[var(--line-2)] text-left">
          <tr>
            <th className="w-28 py-2 pr-4" />
            {offers.map(offer => (
              <th key={offer.id} className="min-w-56 py-2 pr-8 align-top font-semibold text-[var(--ink)]">
                <div className="flex items-center gap-1">
                  <span>{textOrUnknown(offer.company_name)}</span>
                  <Button variant="ghost" size="sm" onClick={() => onEdit(offer)}>编辑</Button>
                </div>
                <div className="font-normal text-[var(--muted)]">{textOrUnknown(offer.title)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {compareRows(offers).map(row => (
            <tr key={row.label} className="border-b border-[var(--line)] align-top">
              <th scope="row" className="py-2.5 pr-4 text-left text-xs font-medium text-[var(--muted)]">{row.label}</th>
              {offers.map(offer => <td key={offer.id} className="max-w-xs py-2.5 pr-8 leading-relaxed text-[var(--ink)]">{row.render(offer)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function CareerOffer({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(careerApi.offers, ['offer']);
  const offers = useMemo(() => query.data ?? [], [query.data]);
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);
  const suggest = useSuggestToChat();

  return (
    <CareerPage
      embedded={embedded}
      title="Offer"
      actions={(
        <>
          {offers.length > 0 && (
            <Button variant="primary" onClick={() => suggest('把我手上的 Offer 拆开比一比', { surface: SURFACE, refs: { offer_ids: offers.map(o => o.id).join(',') } })}>让小芽拆开比</Button>
          )}
          <Button onClick={() => setEditing(editing === 'new' ? null : 'new')}><Plus className="h-3.5 w-3.5" />新建 Offer</Button>
        </>
      )}
    >
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
          <EmptyState title="还没有 Offer" hint="拿到 Offer 后录入薪酬拆解、地点和截止日期，助理会把它们并排摆出来。" example="帮我录入一个 Offer" />
        )}
        {offers.length > 0 && (
          <>
            <OfferTable offers={offers} onEdit={setEditing} />
            <section>
              <SectionTitle>需要你自己决定的项</SectionTitle>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--ink)]">
                {decisionItems(offers).map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </section>
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
