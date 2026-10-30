/**
 * 主链路「交简历 → 按岗位定制」在对话里的两张卡（立场 9：要用户做的，以预填好的卡片出现，下一步一眼可见）。
 *  - resume_intake：拖进来的简历读到了什么。基本信息已从简历补进私密库（只给脱敏预览），缺的项带输入框；
 *    每段经历的说法默认全勾。点一下生成主简历，卡片原地换成「下一步」，不再回对话里来回确认。
 *  - tailor_diff：按岗位定制好了。逐处原文 → 新文和理由；经历里还没有的 JD 要求列在下面。
 */
import { FileCheck2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { Badge, Button, TextInput, suggestToChat } from './CareerPrimitives';
import { openResumeDrawer } from './CareerResumeDrawer';
import { CardShell, ErrorLine, PrivacyNote, list, str, useSubmit, type CardProps } from './FlowCardShell';

const span = (start: string | null, end: string | null) => [start, end].filter(Boolean).join(' – ');

function parseIntake(data: Record<string, unknown>) {
  return {
    intakeId: str(data.intake_id),
    profile: list(data.profile).map(p => ({ field: str(p.field) ?? '', label: str(p.label) ?? '', preview: str(p.preview) ?? '' })).filter(p => p.field),
    missing: list(data.missing).map(m => ({ field: str(m.field) ?? '', label: str(m.label) ?? '', hint: str(m.hint), sensitive: m.sensitive === true })).filter(m => m.field),
    education: list(data.education).map(e => [str(e.school), str(e.degree), str(e.major), span(str(e.start), str(e.end))].filter(Boolean).join(' · ')).filter(Boolean),
    experiences: list(data.experiences).map(e => ({
      id: str(e.id) ?? '', title: str(e.title) ?? '', when: span(str(e.start), str(e.end)),
      claims: list(e.claims).map(c => ({ id: str(c.id) ?? '', text: str(c.text) ?? '' })).filter(c => c.id && c.text),
    })).filter(e => e.id),
  };
}

function IntakeDone({ masterId, onDone }: { masterId: string | null; onDone: () => void }) {
  return (
    <div className="grid gap-2" data-testid="career-card-resume_intake-done">
      <p className="text-sm text-[var(--ink)]">主简历好了。下一步：给一个岗位，按它定制一份。</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => { requestNavigation({ kind: 'career-dossier', view: 'apply' }); onDone(); }}>去岗位收藏挑一个</Button>
        <Button variant="secondary" onClick={() => openResumeDrawer(masterId)}>看看主简历</Button>
      </div>
      <p className="text-xs text-[var(--subtle)]">也可以直接把岗位链接或 JD 拖进下面的输入框。</p>
    </div>
  );
}

export function ResumeIntakeCard({ card, onDone, onDismiss }: CardProps) {
  const d = parseIntake(card.data);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(d.experiences.flatMap(e => e.claims.map(c => [c.id, true]))));
  const [values, setValues] = useState<Record<string, string>>({});
  const [masterId, setMasterId] = useState<string | null | undefined>(undefined);
  const { busy, error, run } = useSubmit();
  const chosen = Object.keys(picked).filter(id => picked[id]);
  const generate = () => run(async () => {
    if (!d.intakeId) throw new Error('这张卡缺少导入记录，请重新拖一次简历');
    for (const m of d.missing) {
      const v = (values[m.field] ?? '').trim();
      if (v) await careerApi.vaultSet({ scope: 'profile', field: m.field, value: v });
    }
    const out = await careerApi.confirmResumeIntake(d.intakeId, chosen);
    setMasterId(out.masterId);
    openResumeDrawer(out.masterId);
  });
  return (
    <CardShell testId="career-card-resume_intake" icon={<FileCheck2 className="size-4" />} title={card.title} badge={masterId === undefined ? <Badge tone="accent">点一下生成主简历</Badge> : <Badge tone="success">已生成</Badge>} onDismiss={onDismiss}>
      {masterId !== undefined ? <IntakeDone masterId={masterId} onDone={onDone} /> : (
        <div className="grid gap-3">
          {d.profile.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--ink-2)]">
              {d.profile.map(p => <span key={p.field}><span className="text-[var(--muted)]">{p.label}</span> {p.preview}</span>)}
            </div>
          )}
          {d.missing.length > 0 && (
            <div>
              <div className="text-xs text-[var(--muted)]">简历上没写的，补一下（不填也能先生成）</div>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {d.missing.map(m => (
                  <label key={m.field} className="flex flex-col gap-1 text-xs text-[var(--muted)]">
                    <span>{m.label}{m.sensitive ? ' · 私密' : ''}</span>
                    <TextInput aria-label={m.label} autoComplete="off" placeholder={m.hint ?? ''} value={values[m.field] ?? ''} onChange={e => setValues(v => ({ ...v, [m.field]: e.target.value }))} />
                  </label>
                ))}
              </div>
              <PrivacyNote />
            </div>
          )}
          {d.education.length > 0 && <ul className="text-sm text-[var(--ink)]">{d.education.map(e => <li key={e}>{e}</li>)}</ul>}
          {d.experiences.map(e => (
            <div key={e.id}>
              <div className="text-sm font-medium text-[var(--ink)]">{e.title}{e.when && <span className="ml-2 text-xs font-normal text-[var(--muted)]">{e.when}</span>}</div>
              <ul className="mt-1 space-y-1">
                {e.claims.map(c => (
                  <li key={c.id}>
                    <label className="flex items-start gap-2 text-sm text-[var(--ink-2)]">
                      <input type="checkbox" className="mt-1" checked={!!picked[c.id]} onChange={ev => setPicked(p => ({ ...p, [c.id]: ev.target.checked }))} aria-label={c.text} />
                      <span>{c.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-[var(--subtle)]">只有勾上的说法会写进简历；不对的去掉勾就行。</p>
          <ErrorLine error={error} />
          <div><Button variant="primary" busy={busy} onClick={() => void generate()}>就用这些，生成主简历</Button></div>
        </div>
      )}
    </CardShell>
  );
}

function ChangeRow({ c }: { c: { op: string; place: string; before: string | null; after: string | null; reason: string | null } }) {
  return (
    <li className="grid gap-0.5">
      <span className="text-xs text-[var(--muted)]">{c.place}{c.op === 'add' ? ' · 新加' : c.op === 'remove' ? ' · 删掉' : ''}</span>
      {c.before && <span className="text-sm text-[var(--subtle)] line-through">{c.before}</span>}
      {c.after && <span className="text-sm text-[var(--ink)]">{c.after}</span>}
      {c.reason && <span className="text-xs text-[var(--subtle)]">{c.reason}</span>}
    </li>
  );
}

export function TailorDiffCard({ card, onDismiss }: CardProps) {
  const tailoredId = str(card.data.tailored_id);
  const changes = list(card.data.changes).map(c => ({ op: str(c.op) ?? 'replace', place: str(c.place) ?? '', before: str(c.before), after: str(c.after), reason: str(c.reason) }));
  const total = typeof card.data.total === 'number' ? card.data.total : changes.length;
  const needs = Array.isArray(card.data.needs) ? card.data.needs.filter((n): n is string => typeof n === 'string' && !!n) : [];
  return (
    <CardShell testId="career-card-tailor_diff" icon={<Sparkles className="size-4" />} title={card.title} badge={<Badge tone="accent">{total ? `改了 ${total} 处` : '没改动'}</Badge>} onDismiss={onDismiss}>
      {changes.length > 0
        ? <ul className="space-y-2.5">{changes.map((c, i) => <ChangeRow key={`${c.place}-${i}`} c={c} />)}</ul>
        : <p className="text-sm text-[var(--ink-2)]">主简历已经贴合这个岗位，定制版和主简历一样。</p>}
      {total > changes.length && <p className="mt-2 text-xs text-[var(--subtle)]">其余 {total - changes.length} 处在整份里看。</p>}
      {needs.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-[var(--muted)]">岗位要、你的经历里还没写到的（没写进简历，不编）</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--ink-2)]">{needs.map(n => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {tailoredId && <Button variant="primary" onClick={() => openResumeDrawer(tailoredId)}>打开整份</Button>}
        {needs.length > 0 && <Button variant="ghost" onClick={() => suggestToChat(`这几条我其实做过：${needs.join('；')}。帮我补进经历库`, undefined, 'prefill')}>我做过，补一段</Button>}
      </div>
    </CardShell>
  );
}
