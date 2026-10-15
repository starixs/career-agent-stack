/**
 * 我的资料 › 基本资料（2026-10-13 会议定：第一眼干净，越少越好）。
 * 上面是身份（姓名 / 性别 / 出生日期 / 身份证号），下面是联系方式和绑定账号。教育、求职偏好、经历这些不再让用户填：
 * 从简历和对话里拿，网申用到时再问（私密库里仍有这些字段，助理问到后会存进去）。
 * 绑定账号的意义是「多拿一点信息」：绑一次就让助理抓一次，过期了再绑再抓，不天天爬。
 *
 * 这里是产品里唯一能看到明文的地方：值加密存在本机 SQLite（密钥单独保存），
 * 模型工具只能拿到字段名、脱敏预览和占位符 {{vault:...}}；填表 / 登录 / 导出时由产品在本机替换成真实值。
 */
import { ChevronRight, Eye, EyeOff, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AnswerBankPanel } from '@/components/career/AnswerBankPanel';
import { careerApi } from '@/components/career/careerApi';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextInput, formatDate, useSuggestToChat,
} from '@/components/career/CareerPrimitives';
import { BindMailForm, MailAccountRow } from '@/components/career/MailBinding';
import type { ExperienceNode, MailAccount, MailPreset, VaultAccessLogRow, VaultItemMeta, VaultOverview, VaultProfileFieldDef } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { VaultExperienceFields } from '@/components/career/VaultExperienceFields';

const IDENTITY_FIELDS = ['name', 'gender', 'birthday', 'idNumber'] as const;
const CONTACT_FIELDS = ['phone', 'email', 'wechat'] as const;
const ACTOR_LABELS: Record<string, string> = { ui: '你在本页查看', form_fill: '网申填表', login_fill: '登录页代填', resume_export: '导出简历', resolve: '替换占位符', test: '测试' };

/** 可绑定的账号。值存在私密库的 profile 字段里（不敏感，可给模型），绑定后让助理抓一次。 */
export interface AccountDef {
  field: string; label: string;
  /** 绑定时要用户填的东西；没有就只是授权一次（如学信网）。 */
  input: { label: string; placeholder: string } | null;
  /** 需要登录才能看的站点：助理打开它，登录交给用户。 */
  loginUrl: string | null;
  /** 抓什么。 */
  fetches: string;
}
export const ACCOUNTS: readonly AccountDef[] = [
  { field: 'linkedin', label: '领英', input: { label: '领英主页链接', placeholder: 'https://www.linkedin.com/in/…' }, loginUrl: 'https://www.linkedin.com/login', fetches: '个人主页上的经历、教育和技能' },
  { field: 'maimai', label: '脉脉', input: { label: '脉脉主页链接或昵称', placeholder: '昵称或 https://maimai.cn/…' }, loginUrl: 'https://maimai.cn', fetches: '个人主页上的经历和职业标签' },
  { field: 'github', label: 'GitHub', input: { label: 'GitHub 用户名或主页', placeholder: 'https://github.com/…' }, loginUrl: null, fetches: '公开仓库，挑出能写进简历的项目' },
  { field: 'portfolio', label: '个人网站', input: { label: '网址', placeholder: 'https://' }, loginUrl: null, fetches: '网站上的作品和自我介绍' },
  { field: 'chsi', label: '学信网', input: null, loginUrl: 'https://my.chsi.com.cn', fetches: '学籍和学历信息（学校、专业、学历、入学与毕业时间）' },
];

/** 绑定后发给助理的一句话：只抓这一次。 */
export function accountFetchMessage(def: AccountDef, value: string | null): string {
  const what = `${def.label}${value ? `（${value}）` : ''}`;
  if (def.loginUrl) return `我绑定了${what}。请用浏览器打开 ${def.loginUrl}，需要登录就交给我自己登录；登录好后把我的${def.fetches}抓一次，整理进我的资料。只抓这一次。`;
  return `我绑定了${what}。请把${def.fetches}抓一次，整理进我的资料。`;
}

export function placeholderOf(scope: 'profile' | 'experience', refId: string, field: string): string {
  return scope === 'profile' ? `{{vault:profile.${field}}}` : `{{vault:exp.${refId}.${field}}}`;
}

/** 站点级汇总：username / password / note 三项合成一行。 */
export function groupSites(items: VaultItemMeta[]): Array<{ host: string; label: string | null; items: VaultItemMeta[]; hasPassword: boolean; usernamePreview: string; autofill: boolean }> {
  const map = new Map<string, VaultItemMeta[]>();
  for (const i of items) if (i.scope === 'site') map.set(i.ref_id, [...(map.get(i.ref_id) ?? []), i]);
  return [...map.entries()].map(([host, list]) => ({
    host,
    label: list.find(i => i.label)?.label ?? null,
    items: list,
    hasPassword: list.some(i => i.field === 'password'),
    usernamePreview: list.find(i => i.field === 'username')?.preview ?? '',
    autofill: list.some(i => i.policy?.autofill === true),
  })).sort((a, b) => a.host.localeCompare(b.host));
}

export default function CareerVault({ focusExperienceId }: { focusExperienceId?: string; isActive?: boolean; onOpenChat?: () => void }) {
  const query = useCareerQuery(careerApi.vault, ['vault']);
  const experiences = useCareerQuery(careerApi.experiences, ['experience']);
  const mail = useCareerQuery(careerApi.mailAccounts, ['mail_account']);
  const data = query.data;
  const [showLog, setShowLog] = useState(false);

  return (
    <CareerPage
      title="基本资料"
      subtitle="加密保存在本机，不进入模型对话"
      actions={<Button variant="ghost" onClick={() => setShowLog(v => !v)}>{showLog ? '收起访问记录' : '访问记录'}</Button>}
    >
      <div className="max-w-4xl space-y-6 px-6 py-6">
        <div className="flex items-start gap-2 border-l-2 border-[var(--line-2)] pl-3 text-xs text-[var(--muted)]">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>只需要填这几项。学校、专业这些不用填：小芽会从你的简历和对话里拿，网申用到时再问你。这一页的内容不会进入对话，填网申、登录、导出简历时由产品在本机替换。</span>
        </div>
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && (
          <>
            {showLog && <AccessLog />}
            <FieldsCard title="身份" fields={IDENTITY_FIELDS} data={data} onChanged={query.reload} />
            <Card title="联系方式与账号">
              <FieldGrid fields={CONTACT_FIELDS} data={data} onChanged={query.reload} />
              <div className="mt-4 border-t border-[var(--line)] pt-3">
                <div className="mb-1 text-xs font-medium text-[var(--muted)]">绑定账号：绑得越多，小芽越懂你，网申要填的也越少</div>
                <ul className="divide-y divide-[var(--line)]">
                  <MailBindingRow accounts={mail.data?.accounts ?? []} presets={mail.data?.presets ?? {}} loading={mail.loading && !mail.data} onChanged={mail.reload} />
                  {ACCOUNTS.map(def => <AccountRow key={def.field} def={def} item={data.items.find(i => i.scope === 'profile' && i.field === def.field)} onChanged={query.reload} />)}
                </ul>
              </div>
            </Card>
            <MoreSection open={!!focusExperienceId}>
              <AnswerBankPanel />
              <SitesSection data={data} onChanged={query.reload} />
              <ExperienceSection data={data} experiences={experiences.data ?? []} focusExperienceId={focusExperienceId} onChanged={query.reload} />
            </MoreSection>
          </>
        )}
      </div>
    </CareerPage>
  );
}

// ─── 身份 / 联系方式 ───

function FieldsCard({ title, fields, data, onChanged }: { title: string; fields: readonly string[]; data: VaultOverview; onChanged: () => void }) {
  return <Card title={title}><FieldGrid fields={fields} data={data} onChanged={onChanged} /></Card>;
}

/** 两列排开；字段定义来自后端，前端只挑要显示的几项。 */
function FieldGrid({ fields, data, onChanged }: { fields: readonly string[]; data: VaultOverview; onChanged: () => void }) {
  const byField = useMemo(() => new Map(data.items.filter(i => i.scope === 'profile').map(i => [i.field, i])), [data.items]);
  const defs = fields.map(f => data.profileFields.find(d => d.field === f)).filter((d): d is VaultProfileFieldDef => !!d);
  return (
    <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
      {defs.map(def => <ProfileFieldRow key={def.field} def={def} item={byField.get(def.field)} onChanged={onChanged} />)}
    </div>
  );
}

function ProfileFieldRow({ def, item, onChanged }: { def: VaultProfileFieldDef; item?: VaultItemMeta; onChanged: () => void }) {
  const action = useCareerAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const inputType = def.sensitive && !visible ? 'password' : 'text';

  const startEdit = () => action.run(async () => {
    setValue(item ? await careerApi.vaultReveal(item.id) : '');
    setVisible(!def.sensitive);
    setEditing(true);
  });
  const save = () => action.run(async () => {
    await careerApi.vaultSet({ scope: 'profile', field: def.field, value });
    setEditing(false);
    setValue('');
    onChanged();
  });
  const clear = () => action.run(async () => {
    if (!item) return;
    await careerApi.vaultDelete(item.id);
    setEditing(false);
    onChanged();
  });

  return (
    <div className="border-b border-[var(--line)] py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm text-[var(--ink)]">
            <span>{def.label}</span>
            <Badge tone={def.sensitive ? 'accent' : 'neutral'} title={def.sensitive ? '模型只能看到占位符' : '可以明文给模型（用于起草）'}>{def.sensitive ? '不进模型' : '可给模型'}</Badge>
          </div>
          {!editing && (
            <div className="mt-0.5 text-xs text-[var(--muted)]" data-testid={`vault-preview-${def.field}`}>
              {item ? (item.preview || '已设置') : <span className="text-[var(--subtle)]">未填</span>}
            </div>
          )}
        </div>
        {!editing && <Button variant="ghost" busy={action.busy} onClick={() => void startEdit()} aria-label={`编辑${def.label}`}>{item ? '编辑' : '填写'}</Button>}
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1">
            <TextInput
              aria-label={def.label}
              type={inputType}
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={def.hint}
              autoComplete="off"
            />
            {def.sensitive && (
              <Button variant="ghost" onClick={() => setVisible(v => !v)} aria-label={visible ? '隐藏' : '显示'}>
                {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
          {def.hint && <div className="text-xs text-[var(--subtle)]">{def.hint}</div>}
          <div className="flex gap-2">
            <Button variant="primary" busy={action.busy} onClick={() => void save()}>保存</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); setValue(''); }}>取消</Button>
            {item && <Button variant="danger" busy={action.busy} onClick={() => void clear()}><Trash2 className="h-3.5 w-3.5" />清除</Button>}
          </div>
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{action.error}</div>}
    </div>
  );
}

// ─── 绑定账号 ───

function MailBindingRow({ accounts, presets, loading, onChanged }: { accounts: MailAccount[]; presets: Record<string, MailPreset>; loading: boolean; onChanged: () => void }) {
  const [binding, setBinding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <li className="py-2">
      <div className="flex min-h-9 items-center gap-3">
        <span className="w-20 shrink-0 text-sm text-[var(--ink)]">邮箱同步</span>
        <span className="min-w-0 flex-1 text-xs text-[var(--muted)]">{loading ? '…' : accounts.length ? '笔试、面试、拒信邮件自动识别' : '绑定后笔试、面试、拒信邮件自动识别'}</span>
        {!loading && accounts.length === 0 && <Button variant="secondary" size="sm" onClick={() => setBinding(v => !v)}>{binding ? '收起' : '绑定'}</Button>}
      </div>
      {note && <div role="status" className="text-xs text-[var(--success)]">{note}</div>}
      {accounts.length > 0 && (
        <ul className="divide-y divide-[var(--line)] pl-[92px]">
          {accounts.map(acc => <MailAccountRow key={acc.id} account={acc} preset={presets[acc.provider]} onChanged={onChanged} />)}
        </ul>
      )}
      {binding && accounts.length === 0 && <BindMailForm presets={presets} onBound={message => { setNote(message); setBinding(false); onChanged(); }} />}
    </li>
  );
}

function AccountRow({ def, item, onChanged }: { def: AccountDef; item?: VaultItemMeta; onChanged: () => void }) {
  const action = useCareerAction();
  const suggest = useSuggestToChat();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const bound = !!item;

  const bind = () => action.run(async () => {
    const v = value.trim();
    if (def.input && !v) throw new Error(`请填写${def.input.label}`);
    await careerApi.vaultSet({ scope: 'profile', field: def.field, value: v || `已绑定 ${new Date().toISOString().slice(0, 10)}`, label: def.label, sensitive: false });
    setEditing(false);
    setValue('');
    onChanged();
    suggest(accountFetchMessage(def, v || null), { surface: 'vault', note: `绑定账号 · ${def.label}` });
  });
  const refetch = () => action.run(async () => {
    const v = item && def.input ? await careerApi.vaultReveal(item.id) : null;
    suggest(accountFetchMessage(def, v), { surface: 'vault', note: `重新抓取 · ${def.label}` });
  });
  const unbind = () => action.run(async () => {
    if (!item) return;
    await careerApi.vaultDelete(item.id);
    onChanged();
  });

  return (
    <li className="py-2">
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <span className="w-20 shrink-0 text-sm text-[var(--ink)]">{def.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]" data-testid={`account-${def.field}`}>
          {bound ? <><Badge tone="success">已绑定</Badge><span className="ml-2">{item?.preview}</span></> : <span className="text-[var(--subtle)]">未绑定</span>}
        </span>
        {!bound && !editing && <Button variant="secondary" size="sm" busy={action.busy} onClick={() => (def.input ? setEditing(true) : void bind())}>绑定</Button>}
        {bound && (
          <>
            <Button variant="ghost" size="sm" busy={action.busy} onClick={() => void refetch()}>重新抓取</Button>
            <Button variant="ghost" size="sm" busy={action.busy} onClick={() => void unbind()} aria-label={`解绑${def.label}`}>解绑</Button>
          </>
        )}
      </div>
      {editing && def.input && (
        <div className="mt-2 flex flex-wrap items-end gap-2 pl-[92px]">
          <div className="min-w-[240px] flex-1">
            <Field label={def.input.label} hint={def.loginUrl ? '绑定后小芽会打开网站，登录由你自己完成，账号密码不经过它' : undefined}>
              <TextInput aria-label={def.input.label} value={value} onChange={e => setValue(e.target.value)} placeholder={def.input.placeholder} />
            </Field>
          </div>
          <Button variant="primary" busy={action.busy} onClick={() => void bind()}>绑定</Button>
          <Button variant="ghost" onClick={() => { setEditing(false); setValue(''); }}>取消</Button>
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{action.error}</div>}
    </li>
  );
}

// ─── 更多：一般用不到，收起来 ───

function MoreSection({ open, children }: { open: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <section className="border-t border-[var(--line)] pt-3">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="flex items-center gap-1 rounded-sm text-sm text-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]">
        <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
        更多：网申答案、投递网站登录、经历的保密补充
      </button>
      {expanded && <div className="mt-4 space-y-8">{children}</div>}
    </section>
  );
}

// ─── 投递网站账号 ───

function SitesSection({ data, onChanged }: { data: VaultOverview; onChanged: () => void }) {
  const sites = useMemo(() => groupSites(data.items), [data.items]);
  const [adding, setAdding] = useState(false);
  return (
    <section>
      <SectionTitle extra={<Button onClick={() => setAdding(v => !v)}><Plus className="h-3.5 w-3.5" />添加网站账号</Button>}>
        投递网站账号（{sites.length}）
      </SectionTitle>
      <p className="mb-2 text-xs text-[var(--muted)]">
        遇到登录页时，产品可以在本机把账号密码填进输入框（需要你打开「自动代填」），但登录按钮、验证码、短信码仍由你本人完成。密码不会给助理，也不会出现在对话里。
      </p>
      {adding && <SiteForm onDone={() => { setAdding(false); onChanged(); }} onCancel={() => setAdding(false)} />}
      {sites.length === 0 && !adding && <EmptyState title="还没有保存网站账号" hint="例如智联、前程无忧、牛客、各公司官网的网申账号。" />}
      <ul className="divide-y divide-[var(--line)]">
        {sites.map(site => <SiteRow key={site.host} site={site} onChanged={onChanged} />)}
      </ul>
    </section>
  );
}

function SiteRow({ site, onChanged }: { site: ReturnType<typeof groupSites>[number]; onChanged: () => void }) {
  const action = useCareerAction();
  const toggleAutofill = () => action.run(async () => {
    for (const item of site.items) await careerApi.vaultSetPolicy(item.id, { autofill: !site.autofill });
    onChanged();
  });
  const remove = () => action.run(async () => {
    if (!window.confirm(`删除 ${site.host} 的账号密码？`)) return;
    await careerApi.vaultDeleteSite(site.host);
    onChanged();
  });
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--ink)]">{site.label ? `${site.label} · ` : ''}{site.host}</div>
        <div className="text-xs text-[var(--muted)]">账号 {site.usernamePreview || '未填'} · 密码 {site.hasPassword ? '已设置' : '未填'}</div>
      </div>
      <Badge tone={site.autofill ? 'success' : 'neutral'}>{site.autofill ? '自动代填：开' : '自动代填：关'}</Badge>
      <Button variant="ghost" busy={action.busy} onClick={() => void toggleAutofill()} aria-label={`切换 ${site.host} 自动代填`}>{site.autofill ? '关闭代填' : '开启代填'}</Button>
      <Button variant="danger" busy={action.busy} onClick={() => void remove()} aria-label={`删除 ${site.host}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      {action.error && <div role="alert" className="w-full text-xs text-[var(--danger)]">{action.error}</div>}
    </li>
  );
}

function SiteForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ host: '', label: '', username: '', password: '', autofill: false });
  const [showPw, setShowPw] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = () => action.run(async () => {
    if (!form.host.trim()) throw new Error('请填写网站域名，例如 zhaopin.com');
    if (!form.username.trim() && !form.password) throw new Error('账号和密码至少填一项');
    const policy = { autofill: form.autofill };
    if (form.username.trim()) await careerApi.vaultSet({ scope: 'site', ref_id: form.host, field: 'username', value: form.username.trim(), label: form.label || null, policy });
    if (form.password) await careerApi.vaultSet({ scope: 'site', ref_id: form.host, field: 'password', value: form.password, label: form.label || null, policy });
    onDone();
  });
  return (
    <Card title="添加网站账号" className="mb-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Field label="网站域名"><TextInput value={form.host} onChange={set('host')} placeholder="例如 zhaopin.com / nowcoder.com" /></Field>
        <Field label="备注名"><TextInput value={form.label} onChange={set('label')} placeholder="例如 智联招聘" /></Field>
        <Field label="账号 / 手机 / 邮箱"><TextInput value={form.username} onChange={set('username')} autoComplete="off" /></Field>
        <Field label="密码">
          <div className="flex items-center gap-1">
            <TextInput type={showPw ? 'text' : 'password'} value={form.password} onChange={set('password')} autoComplete="new-password" />
            <Button variant="ghost" onClick={() => setShowPw(v => !v)} aria-label={showPw ? '隐藏密码' : '显示密码'}>{showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button>
          </div>
        </Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
        <input type="checkbox" checked={form.autofill} onChange={e => setForm(f => ({ ...f, autofill: e.target.checked }))} />
        遇到该网站登录页时自动把账号密码填进输入框（不点登录）
      </label>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}

// ─── 经历的保密补充 ───

function ExperienceSection({ data, experiences, focusExperienceId, onChanged }: { data: VaultOverview; experiences: ExperienceNode[]; focusExperienceId?: string; onChanged: () => void }) {
  const byExp = useMemo(() => {
    const map = new Map<string, VaultItemMeta[]>();
    for (const i of data.items) if (i.scope === 'experience') map.set(i.ref_id, [...(map.get(i.ref_id) ?? []), i]);
    return map;
  }, [data.items]);
  // 初始展开从经历库跳过来的那一段；之后由用户点击控制
  const [openId, setOpenId] = useState<string | null>(focusExperienceId ?? null);
  const focusRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusExperienceId) focusRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focusExperienceId]);
  const list = experiences.length ? experiences : [...byExp.keys()].map(id => ({ id, title: id } as ExperienceNode));

  return (
    <section>
      <SectionTitle>经历的保密补充</SectionTitle>
      <p className="mb-2 text-xs text-[var(--muted)]">
        经历库里只写脱敏说法（如「某头部电商」），真实公司名、客户名、保密数据放这里。助理只能看到占位符，导出简历或填网申时产品会替换成真实值。
      </p>
      {list.length === 0 && <EmptyState title="经历库还是空的" hint="先在「经历库」添加经历，再回来补充它的保密信息。" />}
      <ul className="divide-y divide-[var(--line)]">
        {list.map(e => {
          const items = byExp.get(e.id) ?? [];
          const open = openId === e.id;
          return (
            <li key={e.id} ref={e.id === focusExperienceId ? focusRef : undefined} className="py-2">
              <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpenId(open ? null : e.id)} aria-expanded={open}>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{e.title}</span>
                <span className="text-xs text-[var(--muted)]">{[e.org, e.role].filter(Boolean).join(' · ')}{e.start_date ? ` · ${formatDate(e.start_date)}` : ''}</span>
                <Badge tone={items.length ? 'accent' : 'neutral'}>{items.length ? `${items.length} 项保密` : '无'}</Badge>
              </button>
              {open && <ExperienceFields experienceId={e.id} items={items} onChanged={onChanged} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ExperienceFields({ experienceId, items, onChanged }: { experienceId: string; items: VaultItemMeta[]; onChanged: () => void }) {
  return (
    <div className="mt-2 border-t border-[var(--line)] pt-2">
      <VaultExperienceFields experienceId={experienceId} items={items} onChanged={onChanged} />
    </div>
  );
}

// ─── 访问记录 ───

function AccessLog() {
  const log = useCareerQuery<VaultAccessLogRow[]>(careerApi.vaultAccessLog, ['vault']);
  return (
    <Card title="最近访问记录">
      {log.loading && !log.data && <LoadingRow />}
      {log.data && log.data.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有任何读取记录</div>}
      {log.data && log.data.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-auto text-xs text-[var(--muted)]">
          {log.data.map(row => (
            <li key={row.id}>{formatDate(row.at)} · {ACTOR_LABELS[row.actor] ?? row.actor}{row.purpose ? ` · ${row.purpose}` : ''}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
