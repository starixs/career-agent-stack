/**
 * 对话内流程卡片：对话是主场，凡是"要用户动手的一步"都在对话里就地完成，不用跳到一级入口。
 *
 *  - vault_missing  补齐网申基本信息 → 写私密库（值不经过模型）
 *  - needs_user     网申表里需要你填的项 → 资料类写私密库，其余写答案库；完成后让助理从当前页继续
 *  - drafts         开放题草稿 → 可改，确认后写答案库（下次填表直接用）
 *  - claims_confirm 经历里的说法 → 勾选确认（进简历前必须确认）
 *  - site_login     卡在登录页 → 保存该站账号密码进私密库（产品在登录页代填，点登录仍由用户）
 *  - mail_bind      绑定求职邮箱（地址 + 授权码，不经过模型）
 *  - interview_prep 面试准备卡：时间、上一轮卡点、高风险深挖点、题、开始模拟
 *  - 批量投递进度   → 暂停 / 停止 / 在旁边看现场
 *
 * 卡片由 SSE `career:card` 推来（TabProvider.careerCards），按 id 去重；完成或忽略后从对话里移除。
 * 写入走产品自己的接口；完成后用 suggestToChat 告诉助理"做完了，继续"，助理据此接着干。
 */
import { CheckCircle2, ClipboardCheck, Search, KeyRound, ListTodo, Mail, PenLine, Play, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';

import { careerApi } from './careerApi';
import { CareerKeysPanel } from './CareerKeysPanel';
import { openLiveDrawer } from './CareerLiveDrawer';
import { ApplyGapsCard, ReviewCard } from './CareerReviewCard';
import { Badge, Button, TextArea, TextInput, suggestToChat } from './CareerPrimitives';
import { MailConnectCenter } from './mail-connect/MailConnectCenter';
import { CardShell, list, str, type CardProps } from './FlowCardShell';
import { InterviewPrepCard } from './InterviewPrepCard';
import type { BatchState, CareerCard, CareerCardState } from './types';

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</div> : null);
const PrivacyNote = () => <p className="mt-2 text-xs text-[var(--subtle)]">只存进本机私密库，填表时在本地替换，助理看不到原文。</p>;


// ---------- 补齐基本信息 ----------
export function VaultMissingCard({ card, onDone, onDismiss }: CardProps) {
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
    <CardShell testId="career-card-vault_missing" icon={<KeyRound className="size-4" />} title={card.title} badge={<Badge tone="warning">缺 {fields.length} 项</Badge>} onDismiss={onDismiss}>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map(f => (
          <label key={f.field} className="flex flex-col gap-1 text-xs text-[var(--muted)]">
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
export function NeedsUserCard({ card, onDone, onDismiss }: CardProps) {
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
    suggestToChat(`网申里需要我填的 ${filled.length} 项已在卡片里补齐，请从当前页继续填。`, { surface: 'apply', refs: actionId ? { action_id: actionId } : {}, note: '缺项已补进私密库 / 答案库：调用 apply_continue(action_id) 从当前页继续并重新检查。' });
  });
  return (
    <CardShell testId="career-card-needs_user" icon={<ListTodo className="size-4" />} title={card.title} badge={<Badge tone="warning">等你填</Badge>} onDismiss={onDismiss}>
      <div className="space-y-2">
        {items.map(i => (
          <label key={i.label} className="flex flex-col gap-1 text-xs text-[var(--muted)]">
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
export function DraftsCard({ card, onDone, onDismiss }: CardProps) {
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
    suggestToChat(`我确认了 ${chosen.length} 道开放题的回答，请用确认后的版本继续填。`, { surface: 'apply', refs: actionId ? { action_id: actionId } : {}, note: '开放题答案已确认进答案库：调用 apply_continue(action_id) 从当前页继续并重新检查。' });
  });
  return (
    <CardShell testId="career-card-drafts" icon={<PenLine className="size-4" />} title={card.title} badge={<Badge tone="info">草稿</Badge>} onDismiss={onDismiss}>
      <div className="space-y-3">
        {items.map(i => (
          <div key={i.label}>
            <label className="flex items-center gap-2 text-xs font-medium text-[var(--ink)]">
              <input type="checkbox" checked={!!picked[i.label]} onChange={e => setPicked(p => ({ ...p, [i.label]: e.target.checked }))} aria-label={`采用：${i.label}`} />
              {i.label}
            </label>
            {i.note && <div className="mt-0.5 text-xs text-[var(--subtle)]">{i.note}</div>}
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
export function ClaimsConfirmCard({ card, onDone, onDismiss }: CardProps) {
  const title = str(card.data.experience_title) ?? '这段经历';
  const claims = list(card.data.claims).map(c => ({ id: str(c.id) ?? '', text: str(c.text) ?? '', metric: str(c.result_metric), attribution: str(c.attribution) })).filter(c => c.id && c.text);
  // 面试复盘回流：答不上来的事实，等用户去补（不是主张，不能勾选确认）
  const gaps = Array.isArray(card.data.gaps) ? card.data.gaps.filter((g): g is string => typeof g === 'string' && !!g.trim()) : [];
  const fromRetro = card.data.source === 'interview_retro';
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
    <CardShell testId="career-card-claims_confirm" icon={<ClipboardCheck className="size-4" />} title={card.title} badge={<Badge tone="accent">待确认</Badge>} onDismiss={onDismiss}>
      <ul className="space-y-1.5">
        {claims.map(c => (
          <li key={c.id}>
            <label className="flex items-start gap-2 text-sm text-[var(--ink)]">
              <input type="checkbox" className="mt-1" checked={!!picked[c.id]} onChange={e => setPicked(p => ({ ...p, [c.id]: e.target.checked }))} aria-label={c.text} />
              <span>
                {c.text}
                {c.metric && <span className="ml-1 text-xs text-[var(--muted)]">（{c.metric}）</span>}
                {c.attribution === 'team' && <Badge tone="neutral">团队成果</Badge>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {gaps.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-[var(--muted)]">{fromRetro ? '这场面试里没答上来、还要补的事实' : '还要补的事实'}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--ink-2)]">{gaps.map(g => <li key={g}>{g}</li>)}</ul>
        </div>
      )}
      {claims.length > 0 && <p className="mt-2 text-xs text-[var(--subtle)]">只有确认过的说法才会写进简历和网申回答{fromRetro ? '；已经投出去的那版不会变，下次定制时才会用上' : ''}。</p>}
      <ErrorLine error={error} />
      <div className="mt-3 flex items-center gap-2">
        {claims.length > 0 && <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void save()}>确认所选 {chosen.length} 条</Button>}
        {gaps.length > 0 && <Button variant={claims.length ? 'ghost' : 'primary'} onClick={() => { suggestToChat(`帮我把「${title}」补上：${gaps.join('；')}`); if (!claims.length) onDone(); }}>去补这几处</Button>}
      </div>
    </CardShell>
  );
}

// ---------- 保存登录账号 ----------
export function SiteLoginCard({ card, onDone, onDismiss }: CardProps) {
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
    <CardShell testId="career-card-site_login" icon={<UserRound className="size-4" />} title={card.title} badge={<Badge tone="warning">需要登录</Badge>} onDismiss={onDismiss}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          <span>账号（手机号 / 邮箱 / 用户名）</span>
          <TextInput aria-label="账号" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          <span>密码</span>
          <TextInput aria-label="密码" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
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
export function MailBindCard({ card, onDone, onDismiss }: CardProps) {
  // 从对话进连接中心：连好后关掉卡片，回到对话播报并请助理归档
  const [connected, setConnected] = useState<string | null>(null);
  return (
    <CardShell testId="career-card-mail_bind" icon={<Mail className="size-4" />} title={card.title} onDismiss={onDismiss}>
      {connected
        ? <div role="status" className="text-sm text-[var(--success)]">已连接 {connected}，正在后台收近半年的求职邮件。</div>
        : <MailConnectCenter from="chat" onConnected={account => { setConnected(account.address); onDone(); suggestToChat('邮箱已经连好了，等历史邮件收完，帮我看看有哪些要我处理的'); }} />}
    </CardShell>
  );
}

// ---------- 配置搜索 Key（web_search / company_research 发现没配置时推出） ----------
export function SearchSetupCard({ card, onDone, onDismiss }: CardProps) {
  return (
    <CardShell testId="career-card-search_setup" icon={<Search className="size-4" />} title={card.title} badge={<Badge tone="info">建议</Badge>} onDismiss={onDismiss}>
      <CareerKeysPanel show="search" onSaved={() => { onDone(); suggestToChat('搜索 Key 已在卡片里配好了，请重新搜索'); }} />
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
      <div className="mt-1 text-xs text-[var(--muted)]">已填好 {local.done} · 等你处理 {local.handoffs} · 队列 {local.queued} · 今日 {local.todayCount}</div>
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
const RENDERERS: Record<string, (props: CardProps) => ReactNode> = {
  vault_missing: props => <VaultMissingCard {...props} />,
  needs_user: props => <NeedsUserCard {...props} />,
  drafts: props => <DraftsCard {...props} />,
  claims_confirm: props => <ClaimsConfirmCard {...props} />,
  site_login: props => <SiteLoginCard {...props} />,
  mail_bind: props => <MailBindCard {...props} />,
  search_setup: props => <SearchSetupCard {...props} />,
  review: props => <ReviewCard {...props} />,
  apply_gaps: props => <ApplyGapsCard {...props} />,
  interview_prep: props => <InterviewPrepCard {...props} />,
};

export const isRenderableCard = (c: CareerCard): boolean => !!RENDERERS[c.kind];

/** 已处理的卡片折叠成一行：完成显示"已完成"，忽略的可以重新打开。 */
function CollapsedCardRow({ card, onReopen }: { card: CareerCard; onReopen: () => void }) {
  const done = card.state === 'completed';
  return (
    <div data-testid={`career-card-collapsed-${card.kind}`} className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--inset)] px-3 py-1.5 text-xs text-[var(--muted)]">
      {done ? <CheckCircle2 className="size-3.5 text-[var(--success)]" /> : <ListTodo className="size-3.5" />}
      <span className="min-w-0 flex-1 truncate">{done ? '已完成' : '已跳过'}：{card.title}</span>
      {!done && <Button variant="ghost" onClick={onReopen}>重新打开</Button>}
    </div>
  );
}

/**
 * 渲染一组卡片：pending 显示完整卡片，completed / dismissed 折叠成一行。
 * 既用于回复下面的锚定卡片（Message.tsx），也用于对话底部的无锚点卡片（CareerChatCards）。
 */
export function CareerFlowCards({ cards, batch, onStateChange }: {
  cards: CareerCard[];
  batch?: BatchState | null;
  onStateChange: (id: string, state: CareerCardState) => void;
}) {
  const known = useMemo(() => cards.filter(isRenderableCard), [cards]);
  const showBatch = !!batch && (batch.status === 'running' || batch.status === 'paused');
  if (!known.length && !showBatch) return null;
  return (
    <>
      {showBatch && <BatchProgressCard batch={batch!} />}
      {known.map(c => (
        <div key={c.id}>
          {(c.state ?? 'pending') === 'pending'
            ? RENDERERS[c.kind]({ card: c, onDone: () => onStateChange(c.id, 'completed'), onDismiss: () => onStateChange(c.id, 'dismissed') })
            : <CollapsedCardRow card={c} onReopen={() => onStateChange(c.id, 'pending')} />}
        </div>
      ))}
    </>
  );
}
