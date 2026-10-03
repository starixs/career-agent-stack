/**
 * 对话内流程卡片：对话是主场，凡是"要用户动手的一步"都在对话里就地完成，不用跳到一级入口。
 *
 *  - vault_missing  补齐网申基本信息 → 写私密库（值不经过模型）
 *  - needs_user     网申表里需要你填的项 → 资料类写私密库，其余写答案库；完成后让助理从当前页继续
 *  - drafts         开放题草稿 → 可改，确认后写答案库（下次填表直接用）
 *  - claims_confirm 经历里的说法 → 勾选确认（进简历前必须确认）
 *  - resume_diff    定制简历改动 → 勾选应用
 *  - site_login     卡在登录页 → 保存该站账号密码进私密库（产品在登录页代填，点登录仍由用户）
 *  - mail_bind      绑定求职邮箱（地址 + 授权码，不经过模型）
 *  - 批量投递进度   → 暂停 / 停止 / 在旁边看现场
 *
 * 卡片由 SSE `career:card` 推来（TabProvider.careerCards），按 id 去重；完成或忽略后从对话里移除。
 * 写入走产品自己的接口；完成后用 suggestToChat 告诉助理"做完了，继续"，助理据此接着干。
 */
import { ClipboardCheck, FileDiff, KeyRound, ListTodo, Mail, PenLine, Play, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';

import { careerApi } from './careerApi';
import { openLiveDrawer } from './CareerLiveDrawer';
import { openResumeDrawer } from './CareerResumeDrawer';
import { Badge, Button, TextArea, TextInput, suggestToChat } from './CareerPrimitives';
import type { BatchState, CareerCard } from './types';

// ---------- 数据解析（card.data 来自服务端，逐项校验） ----------
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

const OP_LABELS: Record<string, string> = { replace: '改写', add: '新增', remove: '删除', move: '调整顺序' };
const SECTION_LABELS: Record<string, string> = {
  basics: '基本信息', summary: '个人简介', experiences: '经历', experience: '经历', projects: '项目', education: '教育', skills: '技能', awards: '奖项', bullets: '要点',
};
/** `/experiences/0/bullets/1` → `经历 1 · 要点 2`。 */
export function humanizePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) { if (out.length) out[out.length - 1] += ` ${Number(p) + 1}`; continue; }
    if (p === '-') { if (out.length) out[out.length - 1] += '（末尾）'; continue; }
    out.push(SECTION_LABELS[p] ?? p);
  }
  return out.join(' · ') || path;
}

function CardShell({ testId, icon, title, badge, children, onDismiss }: { testId: string; icon: ReactNode; title: string; badge?: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">{title}</span>
            {badge}
          </div>
        </div>
        {onDismiss && <Button variant="ghost" onClick={onDismiss} aria-label="稍后再说">稍后</Button>}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <div role="alert" className="mt-2 text-xs text-[var(--error)]">{error}</div> : null);
const PrivacyNote = () => <p className="mt-2 text-xs text-[var(--ink-subtle)]">只存进本机私密库，填表时在本地替换，助理看不到原文。</p>;

// ---------- 补齐基本信息 ----------
export function VaultMissingCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const fields = list(card.data.fields).map(f => ({ field: str(f.field) ?? '', label: str(f.label) ?? String(f.field), hint: str(f.hint), sensitive: f.sensitive === true })).filter(f => f.field);
  const [values, setValues] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  const filled = fields.filter(f => (values[f.field] ?? '').trim());
  const save = () => run(async () => {
    for (const f of filled) await careerApi.vaultSet({ scope: 'profile', field: f.field, value: values[f.field].trim() });
  }).then(ok => {
    if (!ok) return;
    onDone();
    suggestToChat(`基本信息已在卡片里补齐（${filled.map(f => f.label).join('、')}），请继续`);
  });
  return (
    <CardShell testId="career-card-vault_missing" icon={<KeyRound className="size-4" />} title={card.title} badge={<Badge tone="warning">缺 {fields.length} 项</Badge>} onDismiss={onDone}>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map(f => (
          <label key={f.field} className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
            <span>{f.label}{f.sensitive ? ' · 私密' : ''}</span>
            <TextInput aria-label={f.label} autoComplete="off" placeholder={f.hint ?? ''} value={values[f.field] ?? ''} onChange={e => setValues(v => ({ ...v, [f.field]: e.target.value }))} />
          </label>
        ))}
      </div>
      <PrivacyNote />
      <ErrorLine error={error} />
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!filled.length} onClick={() => void save()}>保存{filled.length ? ` ${filled.length} 项` : ''}</Button>
      </div>
    </CardShell>
  );
}

// ---------- 网申里需要你填的项 ----------
export function NeedsUserCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const actionId = str(card.data.action_id);
  const items = list(card.data.items).map(i => ({ label: str(i.label) ?? '', note: str(i.note), vaultField: str(i.vault_field), sensitive: i.sensitive === true })).filter(i => i.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  const filled = items.filter(i => (values[i.label] ?? '').trim());
  const save = () => run(async () => {
    for (const i of filled) {
      const value = values[i.label].trim();
      if (i.vaultField) await careerApi.vaultSet({ scope: 'profile', field: i.vaultField, value });
      else await careerApi.saveAnswer({ question_key: i.label, question_text: i.label, answer: value, confirmed: true });
    }
  }).then(ok => {
    if (!ok) return;
    onDone();
    suggestToChat(`网申里需要我填的 ${filled.length} 项已在卡片里补齐，请从当前页继续填表${actionId ? `（action_id: ${actionId}）` : ''}`);
  });
  return (
    <CardShell testId="career-card-needs_user" icon={<ListTodo className="size-4" />} title={card.title} badge={<Badge tone="warning">等你填</Badge>} onDismiss={onDone}>
      <div className="space-y-2">
        {items.map(i => (
          <label key={i.label} className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
            <span>{i.label}{i.vaultField ? ' · 存私密库' : ''}{i.note ? ` · ${i.note}` : ''}</span>
            <TextInput aria-label={i.label} autoComplete="off" value={values[i.label] ?? ''} onChange={e => setValues(v => ({ ...v, [i.label]: e.target.value }))} />
          </label>
        ))}
      </div>
      {items.some(i => i.vaultField) && <PrivacyNote />}
      <ErrorLine error={error} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!filled.length} onClick={() => void save()}>保存并继续填表</Button>
        <Button variant="ghost" onClick={() => openLiveDrawer()}>在旁边看现场</Button>
      </div>
    </CardShell>
  );
}

// ---------- 开放题草稿 ----------
export function DraftsCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const actionId = str(card.data.action_id);
  const items = list(card.data.items).map(i => ({ label: str(i.label) ?? '', value: typeof i.value === 'string' ? i.value : '', note: str(i.note) })).filter(i => i.label);
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(items.map(i => [i.label, i.value])));
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map(i => [i.label, true])));
  const { busy, error, run } = useSubmit();
  const chosen = items.filter(i => picked[i.label] && (texts[i.label] ?? '').trim());
  const save = () => run(async () => {
    for (const i of chosen) await careerApi.saveAnswer({ question_key: i.label, question_text: i.label, answer: texts[i.label].trim(), confirmed: true, high_impact: true });
  }).then(ok => {
    if (!ok) return;
    onDone();
    suggestToChat(`我确认了 ${chosen.length} 道开放题的回答，请用确认后的版本继续填表${actionId ? `（action_id: ${actionId}）` : ''}`);
  });
  return (
    <CardShell testId="career-card-drafts" icon={<PenLine className="size-4" />} title={card.title} badge={<Badge tone="info">草稿</Badge>} onDismiss={onDone}>
      <div className="space-y-3">
        {items.map(i => (
          <div key={i.label}>
            <label className="flex items-center gap-2 text-xs font-medium text-[var(--ink)]">
              <input type="checkbox" checked={!!picked[i.label]} onChange={e => setPicked(p => ({ ...p, [i.label]: e.target.checked }))} aria-label={`采用：${i.label}`} />
              {i.label}
            </label>
            {i.note && <div className="mt-0.5 text-xs text-[var(--ink-subtle)]">{i.note}</div>}
            <TextArea aria-label={`回答：${i.label}`} className="mt-1" value={texts[i.label] ?? ''} onChange={e => setTexts(t => ({ ...t, [i.label]: e.target.value }))} />
          </div>
        ))}
      </div>
      <ErrorLine error={error} />
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void save()}>确认 {chosen.length} 条并继续</Button>
      </div>
    </CardShell>
  );
}

// ---------- 经历里的说法 ----------
export function ClaimsConfirmCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const title = str(card.data.experience_title) ?? '这段经历';
  const claims = list(card.data.claims).map(c => ({ id: str(c.id) ?? '', text: str(c.text) ?? '', metric: str(c.result_metric), attribution: str(c.attribution) })).filter(c => c.id && c.text);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(claims.map(c => [c.id, true])));
  const { busy, error, run } = useSubmit();
  const chosen = claims.filter(c => picked[c.id]);
  const save = () => run(async () => {
    for (const c of chosen) await careerApi.confirmClaim(c.id);
  }).then(ok => {
    if (!ok) return;
    onDone();
    const left = claims.length - chosen.length;
    suggestToChat(`我确认了「${title}」里的 ${chosen.length} 条说法${left ? `，另外 ${left} 条先不用` : ''}`);
  });
  return (
    <CardShell testId="career-card-claims_confirm" icon={<ClipboardCheck className="size-4" />} title={card.title} badge={<Badge tone="accent">待确认</Badge>} onDismiss={onDone}>
      <ul className="space-y-1.5">
        {claims.map(c => (
          <li key={c.id}>
            <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
              <input type="checkbox" className="mt-1" checked={!!picked[c.id]} onChange={e => setPicked(p => ({ ...p, [c.id]: e.target.checked }))} aria-label={c.text} />
              <span>
                {c.text}
                {c.metric && <span className="ml-1 text-xs text-[var(--ink-muted)]">（{c.metric}）</span>}
                {c.attribution === 'team' && <Badge tone="neutral">团队成果</Badge>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--ink-subtle)]">只有确认过的说法才会写进简历和网申回答。</p>
      <ErrorLine error={error} />
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void save()}>确认所选 {chosen.length} 条</Button>
      </div>
    </CardShell>
  );
}

// ---------- 定制简历改动 ----------
export function ResumeDiffCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const tailoredId = str(card.data.tailored_id);
  const ops = list(card.data.ops).map(o => ({ op: str(o.op) ?? 'replace', path: str(o.path) ?? '', value: typeof o.value === 'string' ? o.value : null, reason: str(o.reason) })).filter(o => o.path);
  const unresolved = Array.isArray(card.data.unresolved) ? (card.data.unresolved as unknown[]).map(u => (typeof u === 'string' ? u : JSON.stringify(u))) : [];
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(ops.map(o => [o.path, true])));
  const { busy, error, run } = useSubmit();
  const chosen = ops.filter(o => picked[o.path]);
  const save = () => run(async () => {
    if (!tailoredId) throw new Error('缺少定制简历 id');
    await careerApi.confirmResume(tailoredId, chosen.map(o => o.path));
  }).then(ok => {
    if (!ok) return;
    onDone();
    // 应用后直接在聊天旁打开这一版，用户可以接着手改、看预览、导出
    openResumeDrawer(tailoredId);
    suggestToChat(`定制简历已应用 ${chosen.length} 处改动${ops.length - chosen.length ? `（另 ${ops.length - chosen.length} 处没采用）` : ''}，我在旁边的编辑器里看一下`);
  });
  return (
    <CardShell testId="career-card-resume_diff" icon={<FileDiff className="size-4" />} title={card.title} badge={<Badge tone="accent">待应用</Badge>} onDismiss={onDone}>
      <ul className="space-y-2">
        {ops.map(o => (
          <li key={o.path} className="rounded-md border border-[var(--line-subtle)] px-2.5 py-2">
            <label className="flex items-start gap-2 text-xs text-[var(--ink-muted)]">
              <input type="checkbox" className="mt-0.5" checked={!!picked[o.path]} onChange={e => setPicked(p => ({ ...p, [o.path]: e.target.checked }))} aria-label={`应用：${humanizePath(o.path)}`} />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-[var(--ink)]">{OP_LABELS[o.op] ?? o.op} · {humanizePath(o.path)}</span>
                {o.value && <span className="mt-1 block whitespace-pre-wrap text-sm text-[var(--ink)]">{o.value}</span>}
                {o.reason && <span className="mt-1 block">理由：{o.reason}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {unresolved.length > 0 && (
        <div className="mt-2 text-xs text-[var(--warning)]">还有 {unresolved.length} 处想改但缺少已确认的经历支撑：{unresolved.slice(0, 3).join('；')}</div>
      )}
      <ErrorLine error={error} />
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!chosen.length || !tailoredId} onClick={() => void save()}>应用所选 {chosen.length} 处</Button>
        <Button variant="ghost" disabled={!tailoredId} onClick={() => openResumeDrawer(tailoredId)}>在旁边打开简历</Button>
      </div>
    </CardShell>
  );
}

// ---------- 保存登录账号 ----------
export function SiteLoginCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const host = str(card.data.host) ?? '';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [autofill, setAutofill] = useState(true);
  const { busy, error, run } = useSubmit();
  const save = () => run(async () => {
    const policy = { autofill };
    if (username.trim()) await careerApi.vaultSet({ scope: 'site', ref_id: host, field: 'username', value: username.trim(), policy });
    await careerApi.vaultSet({ scope: 'site', ref_id: host, field: 'password', value: password, policy });
  }).then(ok => {
    if (!ok) return;
    onDone();
    openLiveDrawer();
  });
  return (
    <CardShell testId="career-card-site_login" icon={<UserRound className="size-4" />} title={card.title} badge={<Badge tone="warning">需要登录</Badge>} onDismiss={onDone}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
          <span>账号（手机号 / 邮箱 / 用户名）</span>
          <TextInput aria-label="账号" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
          <span>密码</span>
          <TextInput aria-label="密码" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
        <input type="checkbox" checked={autofill} onChange={e => setAutofill(e.target.checked)} />
        以后在 {host} 的登录页自动代填（点登录、验证码仍由你来）
      </label>
      <PrivacyNote />
      <ErrorLine error={error} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!password} onClick={() => void save()}>保存并去登录</Button>
        <Button variant="ghost" onClick={() => openLiveDrawer()}>不保存，直接在现场登录</Button>
      </div>
    </CardShell>
  );
}

// ---------- 绑定求职邮箱 ----------
export function MailBindCard({ card, onDone }: { card: CareerCard; onDone: () => void }) {
  const presets = list(card.data.presets).map(p => ({ provider: str(p.provider) ?? '', label: str(p.label) ?? '', help: str(p.help) ?? '' })).filter(p => p.provider);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  const hint = presets.find(p => domain && (domain.startsWith(`${p.provider}.`) || (p.provider === 'outlook' && /outlook|hotmail|live/.test(domain)) || (p.provider === 'gmail' && domain === 'gmail.com')));
  const bind = () => run(async () => {
    const out = await careerApi.bindMailAccount({ address: address.trim(), password });
    if (out.verify?.error) throw new Error(`已保存，但连接失败：${out.verify.error}`);
    setResult(`已绑定，拉到 ${out.verify?.fetched ?? 0} 封，其中 ${out.verify?.job_related ?? 0} 封与求职有关`);
  }).then(ok => {
    if (!ok) return;
    onDone();
    suggestToChat('邮箱已在卡片里绑定好了，请把新邮件里和求职有关的归档一下');
  });
  return (
    <CardShell testId="career-card-mail_bind" icon={<Mail className="size-4" />} title={card.title} onDismiss={onDone}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
          <span>邮箱地址</span>
          <TextInput aria-label="邮箱地址" autoComplete="off" placeholder="name@qq.com" value={address} onChange={e => setAddress(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ink-muted)]">
          <span>授权码 / 应用密码</span>
          <TextInput aria-label="授权码" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
      </div>
      {hint?.help && <p className="mt-2 text-xs text-[var(--ink-muted)]">{hint.label}：{hint.help}</p>}
      <p className="mt-2 text-xs text-[var(--ink-subtle)]">授权码只存在本机（仅你的账户可读），助理看不到。</p>
      <ErrorLine error={error} />
      {result && <div role="status" className="mt-2 text-xs text-[var(--success)]">{result}</div>}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!address.includes('@') || !password} onClick={() => void bind()}>绑定并同步</Button>
      </div>
    </CardShell>
  );
}

// ---------- 批量投递进度（来自 Global 事件桥） ----------
export function useBatchState(): BatchState | null {
  const [batch, setBatch] = useState<BatchState | null>(null);
  useEffect(() => onEvent<BatchState>('career:batch', b => { if (b && typeof b.status === 'string') setBatch(b); }), []);
  return batch;
}

export function BatchProgressCard({ batch }: { batch: BatchState }) {
  const { busy, error, run } = useSubmit();
  const [local, setLocal] = useState<BatchState>(batch);
  useEffect(() => { setLocal(batch); }, [batch]);
  const cmd = (c: 'start' | 'pause' | 'stop') => run(async () => { const b = await careerApi.batchCommand(c); if (b) setLocal(b); });
  const running = local.status === 'running';
  return (
    <CardShell testId="career-card-batch" icon={<Play className="size-4" />} title="批量投递" badge={<Badge tone={running ? 'success' : 'neutral'}>{running ? '进行中' : local.status === 'paused' ? '已暂停' : local.status}</Badge>}>
      <div className="text-sm text-[var(--ink)]">{local.message ?? local.currentTitle ?? ''}</div>
      <div className="mt-1 text-xs text-[var(--ink-muted)]">已填好 {local.done} · 等你处理 {local.handoffs} · 队列 {local.queued} · 今日 {local.todayCount}</div>
      <ErrorLine error={error} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running
          ? <Button busy={busy} onClick={() => void cmd('pause')}>暂停</Button>
          : <Button variant="primary" busy={busy} onClick={() => void cmd('start')}>继续</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => void cmd('stop')}>停止</Button>
        <Button variant="ghost" onClick={() => openLiveDrawer()}>在旁边看现场</Button>
      </div>
    </CardShell>
  );
}

// ---------- 注册表 ----------
const RENDERERS: Record<string, (props: { card: CareerCard; onDone: () => void }) => ReactNode> = {
  vault_missing: props => <VaultMissingCard {...props} />,
  needs_user: props => <NeedsUserCard {...props} />,
  drafts: props => <DraftsCard {...props} />,
  claims_confirm: props => <ClaimsConfirmCard {...props} />,
  resume_diff: props => <ResumeDiffCard {...props} />,
  site_login: props => <SiteLoginCard {...props} />,
  mail_bind: props => <MailBindCard {...props} />,
};

export function CareerFlowCards({ cards, batch, onDismiss }: { cards: CareerCard[]; batch?: BatchState | null; onDismiss: (id: string) => void }) {
  const known = useMemo(() => cards.filter(c => RENDERERS[c.kind]), [cards]);
  const showBatch = !!batch && (batch.status === 'running' || batch.status === 'paused');
  if (!known.length && !showBatch) return null;
  return (
    <>
      {showBatch && <BatchProgressCard batch={batch!} />}
      {known.map(c => <div key={c.id}>{RENDERERS[c.kind]({ card: c, onDone: () => onDismiss(c.id) })}</div>)}
    </>
  );
}
