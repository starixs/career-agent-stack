/**
 * Offer 对比：看板在 components/career/offer/OfferBoard（答复期限条、一年的钱、并排的事实卡），这里是页面壳和
 * 新建 / 编辑表单。「让小芽拆开比」把手上的 Offer 交给 Offer 对比技能：
 * 薪酬换算成同一口径、房租通勤带出处、期限谁先到，结果在对话里。
 */
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { Button, Card, CareerPage, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, TextInput, useSuggestToChat } from '@/components/career/CareerPrimitives';
import { OfferBoard } from '@/components/career/offer/OfferBoard';
import { SAMPLE_OFFERS } from '@/components/career/skills/samples/offer';
import { SampleFrame } from '@/components/career/skills/samples/SampleFrame';
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

export default function CareerOffer({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(careerApi.offers, ['offer']);
  const offers = useMemo(() => query.data ?? [], [query.data]);
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);
  const suggest = useSuggestToChat();

  return (
    <CareerPage
      embedded={embedded}
      title="Offer"
    >
      <div className="max-w-5xl space-y-8 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          {offers.length > 0 && (
            <Button variant="primary" onClick={() => suggest('把我手上的 Offer 拆开比一比', { surface: SURFACE, refs: { offer_ids: offers.map(o => o.id).join(',') } })}>让小芽拆开比</Button>
          )}
          <Button onClick={() => setEditing(editing === 'new' ? null : 'new')}><Plus className="h-3.5 w-3.5" />新建 Offer</Button>
        </div>
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
        {query.data?.length === 0 && <SampleFrame><OfferBoard offers={SAMPLE_OFFERS} onEdit={() => undefined} /></SampleFrame>}
        {offers.length > 0 && (
          <OfferBoard offers={offers} onEdit={setEditing} />
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
