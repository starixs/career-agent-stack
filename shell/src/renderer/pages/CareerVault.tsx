/**
 * 私密信息：本人基本信息（姓名 / 手机 / 邮箱 / 证件号…）、投递网站账号密码、经历的保密补充。
 *
 * 这里是产品里唯一能看到明文的地方：值加密存在本机 SQLite（密钥单独保存），
 * 模型工具只能拿到字段名、脱敏预览和占位符 {{vault:...}}；填表 / 登录 / 导出时由产品在本机替换成真实值。
 */
import { Eye, EyeOff, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextInput, formatDate,
} from '@/components/career/CareerPrimitives';
import type { ExperienceNode, VaultAccessLogRow, VaultItemMeta, VaultOverview, VaultProfileFieldDef } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { VaultExperienceFields } from '@/components/career/VaultExperienceFields';

const GROUP_TITLES: Record<VaultProfileFieldDef['group'], string> = { identity: '身份', contact: '联系方式', education: '教育', preference: '求职偏好' };
const GROUP_ORDER: VaultProfileFieldDef['group'][] = ['identity', 'contact', 'education', 'preference'];
const ACTOR_LABELS: Record<string, string> = { ui: '你在本页查看', form_fill: '网申填表', login_fill: '登录页代填', resume_export: '导出简历', resolve: '替换占位符', test: '测试' };

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
  const data = query.data;
  const filledCount = data?.status.profile.filled.length ?? 0;
  const [showLog, setShowLog] = useState(false);

  return (
    <CareerPage
      title="私密信息"
      subtitle={data ? `${filledCount} 项基本信息 · ${data.status.sites.length} 个网站账号 · 加密保存在本机，不进入模型对话` : '加密保存在本机，不进入模型对话'}
      examples={['检查我的私密信息还缺什么', '把联系方式用占位符写进简历', '帮我投这个岗位（会自动用这里的资料填表）']}
      actions={<Button variant="ghost" onClick={() => setShowLog(v => !v)}>{showLog ? '收起访问记录' : '访问记录'}</Button>}
    >
      <div className="space-y-5 px-4 py-3">
        <div className="flex items-start gap-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-3 py-2 text-xs text-[var(--ink-muted)]">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>这一页的内容不会进入个人助理的对话上下文。助理只知道"哪些项已填"，需要时用占位符（如 <code className="rounded bg-[var(--paper)] px-1">{'{{vault:profile.phone}}'}</code>）指代；填网申、登录投递网站、导出简历时，产品在本机把占位符替换成真实值，并记录每一次使用。</span>
        </div>
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && (
          <>
            {showLog && <AccessLog />}
            <ProfileSection data={data} onChanged={query.reload} />
            <SitesSection data={data} onChanged={query.reload} />
            <ExperienceSection data={data} experiences={experiences.data ?? []} focusExperienceId={focusExperienceId} onChanged={query.reload} />
          </>
        )}
      </div>
    </CareerPage>
  );
}

// ─── 本人基本信息 ───

function ProfileSection({ data, onChanged }: { data: VaultOverview; onChanged: () => void }) {
  const byField = useMemo(() => new Map(data.items.filter(i => i.scope === 'profile').map(i => [i.field, i])), [data.items]);
  return (
    <section>
      <SectionTitle>本人基本信息（{data.status.profile.filled.length} / {data.profileFields.length}）</SectionTitle>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {GROUP_ORDER.map(group => {
          const fields = data.profileFields.filter(f => f.group === group);
          if (!fields.length) return null;
          return (
            <Card key={group} title={GROUP_TITLES[group]}>
              <ul className="divide-y divide-[var(--line-subtle)]">
                {fields.map(f => <ProfileFieldRow key={f.field} def={f} item={byField.get(f.field)} onChanged={onChanged} />)}
              </ul>
            </Card>
          );
        })}
      </div>
    </section>
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
    <li className="py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm text-[var(--ink)]">
            <span>{def.label}</span>
            <Badge tone={def.sensitive ? 'accent' : 'neutral'} title={def.sensitive ? '模型只能看到占位符' : '可以明文给模型（用于起草）'}>{def.sensitive ? '不进模型' : '可给模型'}</Badge>
          </div>
          {!editing && (
            <div className="mt-0.5 text-xs text-[var(--ink-muted)]" data-testid={`vault-preview-${def.field}`}>
              {item ? (item.preview || '已设置') : <span className="text-[var(--ink-subtle)]">未填</span>}
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
          {def.hint && <div className="text-xs text-[var(--ink-subtle)]">{def.hint}</div>}
          <div className="flex gap-2">
            <Button variant="primary" busy={action.busy} onClick={() => void save()}>保存</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); setValue(''); }}>取消</Button>
            {item && <Button variant="danger" busy={action.busy} onClick={() => void clear()}><Trash2 className="h-3.5 w-3.5" />清除</Button>}
          </div>
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--error)]">{action.error}</div>}
    </li>
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
      <p className="mb-2 text-xs text-[var(--ink-muted)]">
        遇到登录页时，产品可以在本机把账号密码填进输入框（需要你打开"自动代填"），但登录按钮、验证码、短信码仍由你本人完成。密码不会给助理，也不会出现在对话里。
      </p>
      {adding && <SiteForm onDone={() => { setAdding(false); onChanged(); }} onCancel={() => setAdding(false)} />}
      {sites.length === 0 && !adding && <EmptyState title="还没有保存网站账号" hint="例如智联、前程无忧、牛客、各公司官网的网申账号。" />}
      <ul className="space-y-2">
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
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--ink)]">{site.label ? `${site.label} · ` : ''}{site.host}</div>
        <div className="text-xs text-[var(--ink-muted)]">账号 {site.usernamePreview || '未填'} · 密码 {site.hasPassword ? '已设置' : '未填'}</div>
      </div>
      <Badge tone={site.autofill ? 'success' : 'neutral'}>{site.autofill ? '自动代填：开' : '自动代填：关'}</Badge>
      <Button variant="ghost" busy={action.busy} onClick={() => void toggleAutofill()} aria-label={`切换 ${site.host} 自动代填`}>{site.autofill ? '关闭代填' : '开启代填'}</Button>
      <Button variant="danger" busy={action.busy} onClick={() => void remove()} aria-label={`删除 ${site.host}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      {action.error && <div role="alert" className="w-full text-xs text-[var(--error)]">{action.error}</div>}
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
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
        <input type="checkbox" checked={form.autofill} onChange={e => setForm(f => ({ ...f, autofill: e.target.checked }))} />
        遇到该网站登录页时自动把账号密码填进输入框（不点登录）
      </label>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{action.error}</div>}
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
  const [openId, setOpenId] = useState<string | null>(focusExperienceId ?? null);
  const focusRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusExperienceId) { setOpenId(focusExperienceId); focusRef.current?.scrollIntoView?.({ block: 'start' }); }
  }, [focusExperienceId]);
  const list = experiences.length ? experiences : [...byExp.keys()].map(id => ({ id, title: id } as ExperienceNode));

  return (
    <section>
      <SectionTitle>经历的保密补充</SectionTitle>
      <p className="mb-2 text-xs text-[var(--ink-muted)]">
        经历库里只写脱敏说法（如"某头部电商"），真实公司名、客户名、保密数据放这里。助理只能看到占位符，导出简历或填网申时产品会替换成真实值。
      </p>
      {list.length === 0 && <EmptyState title="经历库还是空的" hint="先在「经历库」添加经历，再回来补充它的保密信息。" />}
      <ul className="space-y-2">
        {list.map(e => {
          const items = byExp.get(e.id) ?? [];
          const open = openId === e.id;
          return (
            <li key={e.id} ref={e.id === focusExperienceId ? focusRef : undefined} className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
              <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpenId(open ? null : e.id)} aria-expanded={open}>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{e.title}</span>
                <span className="text-xs text-[var(--ink-muted)]">{[e.org, e.role].filter(Boolean).join(' · ')}{e.start_date ? ` · ${formatDate(e.start_date)}` : ''}</span>
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
    <div className="mt-2 border-t border-[var(--line-subtle)] pt-2">
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
      {log.data && log.data.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">还没有任何读取记录</div>}
      {log.data && log.data.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-auto text-xs text-[var(--ink-muted)]">
          {log.data.map(row => (
            <li key={row.id}>{formatDate(row.at)} · {ACTOR_LABELS[row.actor] ?? row.actor}{row.purpose ? ` · ${row.purpose}` : ''}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
