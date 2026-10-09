/**
 * 经历库：左侧经历列表（时间倒序），右侧经历详情（主张 → 证据）。
 * 主张默认 pending，只有用户确认或强证据才能进简历（ARCHITECTURE §6「不编造」）。
 */
import { Plus, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { ATTRIBUTION_LABELS, CLAIM_STATUS_LABELS, STRENGTH_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, Select, TextArea, TextInput,
  formatDate, useSuggestToChat,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { ClaimNode, ExperienceNode } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { VaultExperienceFields } from '@/components/career/VaultExperienceFields';

const EXPERIENCE_TYPES = [
  { value: 'work', label: '工作' }, { value: 'intern', label: '实习' }, { value: 'project', label: '项目' },
  { value: 'education', label: '教育' }, { value: 'competition', label: '竞赛' }, { value: 'other', label: '其他' },
];

const STATUS_TONE: Record<ClaimNode['status'], BadgeTone> = { verified: 'success', pending: 'warning', user_confirmed: 'info' };
const STRENGTH_TONE: Record<ClaimNode['evidence'][number]['strength'], BadgeTone> = { strong: 'success', mid: 'info', weak: 'neutral' };

/** 时间倒序：进行中（无结束时间）在前，然后按结束 / 开始时间倒序。 */
export function sortExperiences(list: ExperienceNode[]): ExperienceNode[] {
  const key = (e: ExperienceNode) => `${e.end_date ?? '9999'}|${e.start_date ?? ''}`;
  return [...list].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

export default function CareerExperience({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(careerApi.experiences, ['experience', 'claim', 'evidence']);
  const experiences = useMemo(() => sortExperiences(query.data ?? []), [query.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const suggest = useSuggestToChat();

  // 选中项派生而非 effect 同步：首屏即有详情，列表变化时自动回退到第一条。
  const selected = experiences.find(e => e.id === selectedId) ?? experiences[0] ?? null;
  const activeId = selected?.id ?? null;
  const pendingTotal = experiences.reduce((n, e) => n + e.claims.filter(c => c.status === 'pending').length, 0);

  return (
    <CareerPage
      embedded={embedded}
      title="经历库"
      subtitle={pendingTotal > 0 ? `${pendingTotal} 条主张待你核实` : undefined}
      examples={['帮我整理经历', '帮我从这份简历里提取经历', '帮我补充这段实习的证据']}
      actions={(
        <>
          <Button onClick={() => setShowForm(v => !v)}><Plus className="h-3.5 w-3.5" />添加经历</Button>
          <Button onClick={() => suggest('帮我整理这份材料里的经历：')}><Upload className="h-3.5 w-3.5" />上传材料（调用对话）</Button>
        </>
      )}
    >
      <div className="px-4 py-3">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {showForm && <ExperienceForm onDone={() => { setShowForm(false); query.reload(); }} onCancel={() => setShowForm(false)} />}
        {query.loading && !query.data && <LoadingRow />}
        {!query.loading && experiences.length === 0 && (
          <EmptyState title="还没有经历" hint="经历是简历和面试的根。可以口述、上传旧简历或项目仓库。" example="帮我整理经历" />
        )}
        {experiences.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
            <div>
              <SectionTitle>经历（{experiences.length}）</SectionTitle>
              <ul className="space-y-1.5">
                {experiences.map(e => {
                  const pending = e.claims.filter(c => c.status === 'pending').length;
                  const active = e.id === activeId;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(e.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-[var(--primary)] bg-[var(--primary)]/5' : 'border-[var(--line)] hover:bg-[var(--inset)]'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">{e.title}</span>
                          {pending > 0 && <Badge tone="warning">待核实 {pending}</Badge>}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                          {[e.org, e.role].filter(Boolean).join(' · ') || '未知机构'}
                        </div>
                        <div className="text-xs text-[var(--subtle)]">{formatDate(e.start_date)} – {e.end_date ? formatDate(e.end_date) : '至今'}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div>{selected && <ExperienceDetail experience={selected} onChanged={query.reload} />}</div>
          </div>
        )}
      </div>
    </CareerPage>
  );
}

function ExperienceDetail({ experience, onChanged }: { experience: ExperienceNode; onChanged: () => void }) {
  const suggest = useSuggestToChat();
  return (
    <div className="space-y-3">
      <Card
        title={experience.title}
        extra={<Badge>{EXPERIENCE_TYPES.find(t => t.value === experience.type)?.label ?? experience.type}</Badge>}
      >
        <div className="text-xs text-[var(--muted)]">
          {[experience.org, experience.role].filter(Boolean).join(' · ') || '机构 / 角色未知'} · {formatDate(experience.start_date)} – {experience.end_date ? formatDate(experience.end_date) : '至今'}
        </div>
        {experience.summary && <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--ink)]">{experience.summary}</p>}
      </Card>
      <PrivateSupplement experience={experience} />
      <SectionTitle extra={<Button variant="ghost" onClick={() => suggest(`帮我给「${experience.title}」补充主张和证据`)}>在对话里补充</Button>}>
        主张（{experience.claims.length}）
      </SectionTitle>
      {experience.claims.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-xs text-[var(--muted)]">
          这段经历还没有主张。在对话里说「帮我拆解这段经历的贡献」。
        </div>
      )}
      <ul className="space-y-2">
        {experience.claims.map(claim => <ClaimCard key={claim.id} claim={claim} onChanged={onChanged} />)}
      </ul>
    </div>
  );
}

/**
 * 保密补充：真实公司名 / 客户名 / 保密数据放私密信息库（scope=experience），经历本身只写脱敏说法。
 * 助理只能看到占位符 {{vault:exp.<id>.<field>}}；导出简历、填网申时产品在本机替换成真实值。
 */
function PrivateSupplement({ experience }: { experience: ExperienceNode }) {
  const vault = useCareerQuery(careerApi.vault, ['vault']);
  const [open, setOpen] = useState(false);
  const items = (vault.data?.items ?? []).filter(i => i.scope === 'experience' && i.ref_id === experience.id);
  return (
    <Card
      title="保密补充"
      extra={(
        <div className="flex items-center gap-2">
          <Badge tone={items.length ? 'accent' : 'neutral'}>{items.length ? `${items.length} 项，不进模型` : '未填'}</Badge>
          <Button variant="ghost" onClick={() => setOpen(v => !v)} aria-expanded={open}>{open ? '收起' : '补充'}</Button>
        </div>
      )}
    >
      {!open && (
        <div className="text-xs text-[var(--muted)]">
          {experience.redacted ? '这段经历只录了脱敏摘要。' : ''}真实公司名、客户名、保密指标放这里，不会进入对话；助理用占位符指代，导出和填表时自动替换。
        </div>
      )}
      {open && (
        <>
          {vault.error && <div role="alert" className="mb-2 text-xs text-[var(--danger)]">{vault.error}</div>}
          <VaultExperienceFields experienceId={experience.id} items={items} onChanged={vault.reload} />
        </>
      )}
    </Card>
  );
}

function ClaimCard({ claim, onChanged }: { claim: ClaimNode; onChanged: () => void }) {
  const action = useCareerAction();
  const confirm = () => action.run(async () => {
    await careerApi.confirmClaim(claim.id);
    onChanged();
  });
  return (
    <li className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-[var(--ink)]">{claim.text}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[claim.status] ?? 'neutral'}>{CLAIM_STATUS_LABELS[claim.status] ?? claim.status}</Badge>
            <Badge tone={claim.attribution === 'self' ? 'accent' : 'neutral'} title="贡献归属">{ATTRIBUTION_LABELS[claim.attribution] ?? claim.attribution}</Badge>
            {claim.result_metric && <Badge tone="info" title="结果指标">{claim.result_metric}</Badge>}
            <span className="text-xs text-[var(--subtle)]">来源：{claim.created_from}</span>
          </div>
        </div>
        {claim.status === 'pending' && (
          <Button variant="primary" busy={action.busy} onClick={() => void confirm()}>确认</Button>
        )}
      </div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      {claim.evidence.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-[var(--line)] pt-2">
          {claim.evidence.map(ev => (
            <li key={ev.id} className="flex items-start gap-2 text-xs text-[var(--muted)]">
              <Badge tone={STRENGTH_TONE[ev.strength] ?? 'neutral'}>{STRENGTH_LABELS[ev.strength] ?? ev.strength}</Badge>
              <span className="shrink-0">{ev.kind}</span>
              <span className="min-w-0 flex-1 break-all">{ev.locator}{ev.excerpt ? ` — ${ev.excerpt}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {claim.evidence.length === 0 && <div className="mt-2 text-xs text-[var(--subtle)]">暂无证据</div>}
    </li>
  );
}

function ExperienceForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ title: '', role: '', org: '', start_date: '', end_date: '', type: 'work', summary: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = () => action.run(async () => {
    if (!form.title.trim()) throw new Error('请填写经历标题');
    await careerApi.addExperience({
      title: form.title.trim(), role: form.role || null, org: form.org || null,
      start_date: form.start_date || null, end_date: form.end_date || null, type: form.type, summary: form.summary || null,
    });
    onDone();
  });
  return (
    <Card title="添加经历" className="mb-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="标题"><TextInput value={form.title} onChange={set('title')} placeholder="例如：XX 公司后端实习" /></Field>
        <Field label="机构"><TextInput value={form.org} onChange={set('org')} /></Field>
        <Field label="角色"><TextInput value={form.role} onChange={set('role')} /></Field>
        <Field label="开始"><TextInput type="date" value={form.start_date} onChange={set('start_date')} /></Field>
        <Field label="结束（留空为至今）"><TextInput type="date" value={form.end_date} onChange={set('end_date')} /></Field>
        <Field label="类型"><Select value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={EXPERIENCE_TYPES} /></Field>
      </div>
      <div className="mt-2"><Field label="概述"><TextArea value={form.summary} onChange={set('summary')} /></Field></div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}
