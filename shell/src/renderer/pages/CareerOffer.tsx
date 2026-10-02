/**
 * Offer：卡片列表（薪酬拆解 / 地点 / 截止）、对比表（列为 Offer，行为薪酬 / 内容匹配 / 地点 / 风险）、
 * 「需要你自己决定的项」、新建 / 编辑表单。
 */
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, TextInput,
  formatDate, textOrUnknown,
} from '@/components/career/CareerPrimitives';
import type { Offer } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

const COMP_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'base', label: '月薪 / 基本' }, { key: 'months', label: '月数' }, { key: 'bonus', label: '奖金' },
  { key: 'stock', label: '股票 / 期权' }, { key: 'signing', label: '签字费' }, { key: 'total', label: '年包合计' },
];

type Comp = Record<string, unknown>;

export function compOf(offer: Offer): Comp {
  return safeJson<Comp>(offer.comp_json, {});
}

export function compSummary(comp: Comp): string {
  const parts: string[] = [];
  for (const f of COMP_FIELDS) {
    const v = comp[f.key];
    if (v != null && v !== '') parts.push(`${f.label} ${String(v)}`);
  }
  for (const [k, v] of Object.entries(comp)) {
    if (!COMP_FIELDS.some(f => f.key === k) && v != null && v !== '' && typeof v !== 'object') parts.push(`${k} ${String(v)}`);
  }
  return parts.length ? parts.join(' · ') : '未知';
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

export default function CareerOffer() {
  const query = useCareerQuery(careerApi.offers, ['offer']);
  const offers = useMemo(() => query.data ?? [], [query.data]);
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);

  return (
    <CareerPage
      title="Offer"
      examples={['帮我对比这几个 Offer', '帮我录入一个 Offer', '帮我分析这个 Offer 的风险']}
      actions={<Button onClick={() => setEditing(editing === 'new' ? null : 'new')}><Plus className="h-3.5 w-3.5" />新建 Offer</Button>}
    >
      <div className="space-y-5 px-4 py-3">
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
            <section>
              <SectionTitle>Offer（{offers.length}）</SectionTitle>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {offers.map(o => (
                  <Card key={o.id} title={`${textOrUnknown(o.company_name)} · ${textOrUnknown(o.title)}`} extra={<Button variant="ghost" onClick={() => setEditing(o)}>编辑</Button>}>
                    <dl className="space-y-1 text-xs">
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--ink-muted)]">薪酬</dt><dd className="text-[var(--ink)]">{compSummary(compOf(o))}</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--ink-muted)]">地点</dt><dd className="text-[var(--ink)]">{textOrUnknown(o.location)}</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-[var(--ink-muted)]">截止</dt><dd className="text-[var(--ink)]">{o.deadline ? <Badge tone="warning">{formatDate(o.deadline)}</Badge> : '未知'}</dd></div>
                    </dl>
                  </Card>
                ))}
              </div>
            </section>
            <section>
              <SectionTitle>对比</SectionTitle>
              <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-[var(--paper-inset)] text-left text-[var(--ink-muted)]">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">维度</th>
                      {offers.map(o => <th key={o.id} className="px-2 py-1.5 font-medium text-[var(--ink)]">{textOrUnknown(o.company_name)}<div className="font-normal text-[var(--ink-muted)]">{textOrUnknown(o.title)}</div></th>)}
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
                      <tr key={row.label} className="border-t border-[var(--line-subtle)] align-top">
                        <td className="px-2 py-1.5 font-medium text-[var(--ink-muted)]">{row.label}</td>
                        {offers.map(o => <td key={o.id} className="px-2 py-1.5 text-[var(--ink)]">{row.render(o)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
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
    content_match: offer?.content_match ?? '', risk_notes: offer?.risk_notes ?? '', deadline: offer?.deadline ?? '',
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
      content_match: form.content_match || null, risk_notes: form.risk_notes || null, deadline: form.deadline || null,
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
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}
