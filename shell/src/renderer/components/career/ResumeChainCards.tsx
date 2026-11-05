/**
 * 主链路「交简历 → 按岗位定制」在对话里的两张卡（立场 9：要用户做的，以预填好的卡片出现，下一步一眼可见）。
 *  - resume_intake：拖进来的简历读到了什么。基本信息已从简历补进私密库（只给脱敏预览），缺的项带输入框；
 *    说法在一张整批勾选表里（PickTable）：「全部通过」一下做完，或拖选 / Shift 连选后「只用所选」。
 *    生成后卡片原地换成「下一步」，不再回对话里来回确认。
 *  - tailor_diff：按岗位定制好了。逐处原文 → 新文、对上哪条 JD；被防编造闸门拦下的改动和经历里还没有的 JD 要求列在下面。
 */
import { FileCheck2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { Badge, Button, TextInput, suggestToChat } from './CareerPrimitives';
import { openResumeDrawer } from './CareerResumeDrawer';
import { CardShell, ErrorLine, list, str, useSubmit, type CardProps } from './FlowCardShell';
import { PickTable, allPicked, pickedIds, type PickGroup, type Picked } from './PickTable';

const span = (start: string | null, end: string | null) => [start, end].filter(Boolean).join(' – ');

function parseIntake(data: Record<string, unknown>) {
  return {
    intakeId: str(data.intake_id),
    profile: list(data.profile).map(p => ({ field: str(p.field) ?? '', label: str(p.label) ?? '', preview: str(p.preview) ?? '' })).filter(p => p.field),
    conflicts: list(data.conflicts).map(c => ({ field: str(c.field) ?? '', label: str(c.label) ?? '', resume: str(c.resume_preview) ?? '', vault: str(c.vault_preview) ?? '' })).filter(c => c.field),
    missing: list(data.missing).map(m => ({ field: str(m.field) ?? '', label: str(m.label) ?? '', hint: str(m.hint), sensitive: m.sensitive === true })).filter(m => m.field),
    education: list(data.education).map(e => [str(e.school), str(e.degree), str(e.major), span(str(e.start), str(e.end))].filter(Boolean).join(' · ')).filter(Boolean),
    experiences: list(data.experiences).map(e => ({
      id: str(e.id) ?? '', title: str(e.title) ?? '', when: span(str(e.start), str(e.end)),
      claims: list(e.claims).map(c => ({ id: str(c.id) ?? '', text: str(c.text) ?? '' })).filter(c => c.id && c.text),
    })).filter(e => e.id),
  };
}

/** 口述建的旧经历：不进主简历，留在经历库标「来自口述」；这里给一键清掉（10-30 用户定，不自动删）。 */
function OralLeftover({ intakeId, count }: { intakeId: string | null; count: number }) {
  const [left, setLeft] = useState(count);
  const { busy, error, run } = useSubmit();
  if (!intakeId || left <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]" data-testid="intake-oral">
      <span>经历库里还有 {left} 段之前口述的经历（标着「来自口述」），没进主简历。</span>
      <Button variant="ghost" busy={busy} onClick={() => void run(async () => { await careerApi.clearOralExperiences(intakeId); setLeft(0); })}>清掉这些</Button>
      <ErrorLine error={error} />
    </div>
  );
}

function IntakeDone({ masterId, intakeId, oral, onDone }: { masterId: string | null; intakeId: string | null; oral: number; onDone: () => void }) {
  return (
    <div className="grid gap-2" data-testid="career-card-resume_intake-done">
      <p className="text-sm text-[var(--ink)]">主简历好了。</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => { requestNavigation({ kind: 'career-dossier', view: 'apply' }); onDone(); }}>去岗位库挑一个</Button>
        <Button variant="secondary" onClick={() => openResumeDrawer(masterId)}>看看主简历</Button>
      </div>
      <OralLeftover intakeId={intakeId} count={oral} />
    </div>
  );
}

function MissingInputs({ missing, values, onChange }: { missing: ReturnType<typeof parseIntake>['missing']; values: Record<string, string>; onChange: (field: string, v: string) => void }) {
  if (!missing.length) return null;
  return (
    <div>
      <div className="text-xs text-[var(--muted)]">简历上没写的</div>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {missing.map(m => (
          <label key={m.field} className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            <span>{m.label}{m.sensitive ? ' · 私密' : ''}</span>
            <TextInput aria-label={m.label} autoComplete="off" placeholder={m.hint ?? ''} value={values[m.field] ?? ''} onChange={e => onChange(m.field, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

type Choice = Record<string, 'resume' | 'vault'>;

/** 简历和资料对不上：并排一张表，整列一键选，个别行再改；默认以刚上传的简历为准。 */
function ConflictTable({ rows, choice, onChange }: { rows: ReturnType<typeof parseIntake>['conflicts']; choice: Choice; onChange: (next: Choice) => void }) {
  if (!rows.length) return null;
  const all = (v: 'resume' | 'vault') => onChange(Object.fromEntries(rows.map(r => [r.field, v])));
  const col = (v: 'resume' | 'vault', text: string) => (
    <button type="button" onClick={() => all(v)} className="text-left text-xs text-[var(--primary)] underline-offset-2 hover:underline">{text}</button>
  );
  return (
    <div data-testid="intake-conflicts" className="overflow-hidden rounded-lg border border-[var(--line)]">
      <div className="px-2 py-1.5 text-xs text-[var(--muted)]">这份简历和基本资料有 {rows.length} 项不一样，以哪份为准？</div>
      <table className="w-full text-sm">
        <thead><tr className="border-t border-[var(--line)] text-left"><th className="px-2 py-1 font-normal text-[var(--muted)]" />
          <th className="px-2 py-1">{col('resume', '全部以简历为准')}</th><th className="px-2 py-1">{col('vault', '全部保留资料里的')}</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.field} className="border-t border-[var(--line)]">
              <td className="px-2 py-1 text-xs text-[var(--muted)]">{r.label}</td>
              {(['resume', 'vault'] as const).map(v => (
                <td key={v} className="px-2 py-1">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name={`conflict-${r.field}`} aria-label={`${r.label}：${v === 'resume' ? '用简历上的' : '用资料里的'}`} checked={(choice[r.field] ?? 'resume') === v} onChange={() => onChange({ ...choice, [r.field]: v })} />
                    <span className={(choice[r.field] ?? 'resume') === v ? 'text-[var(--ink)]' : 'text-[var(--subtle)]'}>{v === 'resume' ? r.resume : r.vault}</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResumeIntakeCard({ card, onDone, onDismiss }: CardProps) {
  const d = parseIntake(card.data);
  const groups: PickGroup[] = d.experiences.map(e => ({ id: e.id, title: e.title, meta: e.when, rows: e.claims }));
  const [picked, setPicked] = useState<Picked>(() => allPicked(groups));
  const [values, setValues] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Choice>({});
  const [masterId, setMasterId] = useState<string | null | undefined>(undefined);
  const [oral, setOral] = useState(0);
  const { busy, error, run } = useSubmit();
  const chosen = pickedIds(picked);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const generate = (claimIds: string[]) => run(async () => {
    if (!d.intakeId) throw new Error('这张卡缺少导入记录，请重新拖一次简历');
    for (const m of d.missing) {
      const v = (values[m.field] ?? '').trim();
      if (v) await careerApi.vaultSet({ scope: 'profile', field: m.field, value: v });
    }
    const out = await careerApi.confirmResumeIntake(d.intakeId, claimIds, Object.fromEntries(d.conflicts.map(c => [c.field, choice[c.field] ?? 'resume'])));
    setOral(out.oral);
    setMasterId(out.masterId);
    openResumeDrawer(out.masterId);
  });
  const allIds = groups.flatMap(g => g.rows.map(r => r.id));
  const actions = (
    <>
      {chosen.length < total && <Button variant="secondary" busy={busy} disabled={!chosen.length} onClick={() => void generate(chosen)}>只用所选 {chosen.length} 条</Button>}
      <Button variant="primary" busy={busy} onClick={() => void generate(allIds)}>全部通过，生成主简历</Button>
    </>
  );
  return (
    <CardShell testId="career-card-resume_intake" icon={<FileCheck2 className="size-4" />} title={card.title} badge={masterId === undefined ? <Badge tone="accent">点一下生成主简历</Badge> : <Badge tone="success">已生成</Badge>} onDismiss={onDismiss}>
      {masterId !== undefined ? <IntakeDone masterId={masterId} intakeId={d.intakeId} oral={oral} onDone={onDone} /> : (
        <div className="grid gap-3">
          {d.profile.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--ink-2)]">
              {d.profile.map(p => <span key={p.field}><span className="text-[var(--muted)]">{p.label}</span> {p.preview}</span>)}
            </div>
          )}
          <ConflictTable rows={d.conflicts} choice={choice} onChange={setChoice} />
          <MissingInputs missing={d.missing} values={values} onChange={(field, v) => setValues(x => ({ ...x, [field]: v }))} />
          {d.education.length > 0 && <ul className="text-sm text-[var(--ink)]">{d.education.map(e => <li key={e}>{e}</li>)}</ul>}
          {groups.length > 0
            ? <PickTable groups={groups} picked={picked} onChange={setPicked} actions={actions} />
            : <div className="flex justify-end">{actions}</div>}
          <ErrorLine error={error} />
        </div>
      )}
    </CardShell>
  );
}

function ChangeRow({ c }: { c: { op: string; place: string; before: string | null; after: string | null; reason: string | null; jd: string[] } }) {
  return (
    <li className="grid gap-0.5">
      <span className="text-xs text-[var(--muted)]">{c.place}{c.op === 'add' ? ' · 新加' : c.op === 'remove' ? ' · 删掉' : ''}</span>
      {c.before && <span className="text-sm text-[var(--subtle)] line-through">{c.before}</span>}
      {c.after && <span className="text-sm text-[var(--ink)]">{c.after}</span>}
      {(c.reason || c.jd.length > 0) && <span className="text-xs text-[var(--subtle)]">{c.jd.length > 0 && <>对上 JD：{c.jd.join('、')}{c.reason ? '；' : ''}</>}{c.reason}</span>}
    </li>
  );
}

export function TailorDiffCard({ card, onDismiss }: CardProps) {
  const tailoredId = str(card.data.tailored_id);
  const changes = list(card.data.changes).map(c => ({ op: str(c.op) ?? 'replace', place: str(c.place) ?? '', before: str(c.before), after: str(c.after), reason: str(c.reason), jd: Array.isArray(c.jd) ? c.jd.filter((k): k is string => typeof k === 'string') : [] }));
  const blocked = list(card.data.blocked).map(b => ({ place: str(b.place) ?? '', after: str(b.after), why: str(b.why) ?? '' }));
  const total = typeof card.data.total === 'number' ? card.data.total : changes.length;
  const needs = Array.isArray(card.data.needs) ? card.data.needs.filter((n): n is string => typeof n === 'string' && !!n) : [];
  return (
    <CardShell testId="career-card-tailor_diff" icon={<Sparkles className="size-4" />} title={card.title} badge={<Badge tone="accent">{total ? `改了 ${total} 处` : '没改动'}</Badge>} onDismiss={onDismiss}>
      {changes.length > 0
        ? <ul className="space-y-2.5">{changes.map((c, i) => <ChangeRow key={`${c.place}-${i}`} c={c} />)}</ul>
        : <p className="text-sm text-[var(--ink-2)]">主简历已经贴合这个岗位，定制版和主简历一样。</p>}
      {total > changes.length && <p className="mt-2 text-xs text-[var(--subtle)]">其余 {total - changes.length} 处在整份里看。</p>}
      {blocked.length > 0 && (
        <div className="mt-3" data-testid="tailor-blocked">
          <div className="text-xs text-[var(--muted)]">拦下了 {blocked.length} 处没依据的改动</div>
          <ul className="mt-1 space-y-1">{blocked.map((b, i) => <li key={`${b.place}-${i}`} className="text-xs text-[var(--subtle)]">{b.place}：{b.why}{b.after ? `（「${b.after.slice(0, 40)}」）` : ''}</li>)}</ul>
        </div>
      )}
      {needs.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-[var(--muted)]">岗位要、你的经历里还没写到的</div>
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
