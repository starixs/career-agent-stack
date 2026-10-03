/**
 * 简历：左列 master → tailored 版本树；主区 schema_json 分区编辑；右侧 PDF 预览；导出 pdf/docx/png。
 */
import { Download, FolderOpen, Save } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { getServerUrl } from '@/api/tauriClient';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { RESUME_STRENGTH_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, TextInput,
  fileDirname, formatDate,
} from '@/components/career/CareerPrimitives';
import type { Job, ResumeMaster, ResumeTailored } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { isTauriEnvironment } from '@/utils/browserMock';
import { openExternal } from '@/utils/openExternal';

type ResumeSchema = Record<string, unknown>;
type SectionKey = 'basics' | 'education' | 'experience' | 'projects' | 'skills';
const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'basics', label: '基本信息' }, { key: 'education', label: '教育' }, { key: 'experience', label: '经历' },
  { key: 'projects', label: '项目' }, { key: 'skills', label: '技能' },
];
const BASICS_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'name', label: '姓名' }, { key: 'title', label: '目标职位' }, { key: 'email', label: '邮箱' }, { key: 'phone', label: '电话' },
  { key: 'location', label: '所在地' }, { key: 'summary', label: '一句话概述' },
];
const LIST_FIELD_HINTS: Record<string, Array<{ key: string; label: string }>> = {
  education: [{ key: 'school', label: '学校' }, { key: 'degree', label: '学位' }, { key: 'major', label: '专业' }, { key: 'start', label: '开始' }, { key: 'end', label: '结束' }],
  experience: [{ key: 'org', label: '机构' }, { key: 'role', label: '角色' }, { key: 'start', label: '开始' }, { key: 'end', label: '结束' }],
  projects: [{ key: 'name', label: '项目' }, { key: 'role', label: '角色' }, { key: 'start', label: '开始' }, { key: 'end', label: '结束' }],
};

type SelectedResume = { kind: 'master'; row: ResumeMaster } | { kind: 'tailored'; row: ResumeTailored };

async function loadAll() {
  const [resumes, jobs] = await Promise.all([careerApi.resumes(), careerApi.jobs().catch(() => [] as Job[])]);
  return { ...resumes, jobs };
}

export default function CareerResume({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(loadAll, ['resume_master', 'resume_tailored', 'resume_snapshot', 'job']);
  const masters = useMemo(() => query.data?.masters ?? [], [query.data]);
  const tailored = useMemo(() => query.data?.tailored ?? [], [query.data]);
  const jobs = useMemo(() => query.data?.jobs ?? [], [query.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected: SelectedResume | null = useMemo(() => {
    const m = masters.find(x => x.id === selectedId);
    if (m) return { kind: 'master', row: m };
    const t = tailored.find(x => x.id === selectedId);
    if (t) return { kind: 'tailored', row: t };
    return masters[0] ? { kind: 'master', row: masters[0] } : null;
  }, [masters, tailored, selectedId]);
  const activeId = selected?.row.id ?? null;

  const jobById = useMemo(() => new Map(jobs.map(j => [j.id, j])), [jobs]);

  return (
    <CareerPage embedded={embedded} title="简历" examples={['帮我生成主简历', '帮我针对这个岗位改一版简历', '把简历导出成 PDF']}>
      <div className="px-4 py-3">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !query.data && <LoadingRow />}
        {!query.loading && masters.length === 0 && (
          <EmptyState title="还没有简历" hint="先把经历库整理好，再让助理生成主简历；针对岗位的版本会挂在主简历下面。" example="帮我生成主简历" />
        )}
        {masters.length > 0 && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_minmax(280px,38%)]">
            <div>
              <SectionTitle>版本树</SectionTitle>
              <ul className="space-y-2">
                {masters.map(m => (
                  <li key={m.id}>
                    <VersionButton active={activeId === m.id} onClick={() => setSelectedId(m.id)}>
                      <div className="truncate text-sm font-medium">{m.name}</div>
                      <div className="text-xs text-[var(--ink-muted)]">主简历{m.direction ? ` · ${m.direction}` : ''} · {formatDate(m.updated_at)}</div>
                    </VersionButton>
                    <ul className="ml-3 mt-1 space-y-1 border-l border-[var(--line-subtle)] pl-2">
                      {tailored.filter(t => t.master_id === m.id).map(t => {
                        const job = t.job_id ? jobById.get(t.job_id) : undefined;
                        return (
                          <li key={t.id}>
                            <VersionButton active={activeId === t.id} onClick={() => setSelectedId(t.id)}>
                              <div className="truncate text-sm">{job ? `${job.company_name ?? '未知公司'} · ${job.title}` : '未关联岗位'}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                                <Badge tone="accent">{RESUME_STRENGTH_LABELS[t.strength] ?? t.strength}</Badge>
                                {t.diff_confirmed_at
                                  ? <Badge tone="success">diff 已确认</Badge>
                                  : <Badge tone="warning">diff 待确认</Badge>}
                              </div>
                            </VersionButton>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
            {selected && <ResumeEditor key={selected.row.id} selected={selected} job={selected.kind === 'tailored' && selected.row.job_id ? jobById.get(selected.row.job_id) : undefined} onSaved={query.reload} />}
            {selected && <ResumePreview resumeId={selected.row.id} />}
          </div>
        )}
      </div>
    </CareerPage>
  );
}

function VersionButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--line-subtle)] hover:bg-[var(--paper-inset)]'}`}
    >
      {children}
    </button>
  );
}

function ResumeEditor({ selected, job, onSaved }: { selected: SelectedResume; job?: Job; onSaved: () => void }) {
  const [schema, setSchema] = useState<ResumeSchema>(() => safeJson<ResumeSchema>(selected.row.schema_json, {}));
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState(() => JSON.stringify(schema, null, 2));
  const [dirty, setDirty] = useState(false);
  const save = useCareerAction();
  const exp = useCareerAction();
  const [exportResult, setExportResult] = useState<{ format: string; path: string } | null>(null);

  const update = (next: ResumeSchema) => { setSchema(next); setRaw(JSON.stringify(next, null, 2)); setDirty(true); };

  const doSave = () => save.run(async () => {
    let payload = schema;
    if (rawMode) {
      payload = JSON.parse(raw) as ResumeSchema;
      setSchema(payload);
    }
    await careerApi.saveResume(selected.row.id, JSON.stringify(payload));
    setDirty(false);
    onSaved();
  });

  const doExport = (format: 'pdf' | 'docx' | 'png') => exp.run(async () => {
    const r = await careerApi.exportResume(selected.row.id, format);
    const path = typeof r.path === 'string' ? r.path : '';
    setExportResult({ format, path: path || '（后端未返回路径）' });
  });

  return (
    <div className="min-w-0 space-y-3">
      <Card
        title={selected.kind === 'master' ? `主简历：${selected.row.name}` : '针对岗位的版本'}
        extra={(
          <>
            <Button variant="ghost" onClick={() => setRawMode(v => !v)}>{rawMode ? '表单' : 'JSON'}</Button>
            <Button variant="primary" busy={save.busy} disabled={!dirty && !rawMode} onClick={() => void doSave()}><Save className="h-3.5 w-3.5" />保存</Button>
          </>
        )}
      >
        {selected.kind === 'tailored' && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            <span>针对：{job ? `${job.company_name ?? '未知公司'} · ${job.title}` : '未关联岗位'}</span>
            <Badge tone="accent">强度：{RESUME_STRENGTH_LABELS[selected.row.strength] ?? selected.row.strength}</Badge>
            {selected.row.diff_confirmed_at
              ? <Badge tone="success">diff 已确认 {formatDate(selected.row.diff_confirmed_at)}</Badge>
              : <Badge tone="warning">diff 待确认（在对话里说「确认这版简历的改动」）</Badge>}
          </div>
        )}
        {save.error && <div role="alert" className="mb-2 text-xs text-[var(--error)]">{save.error}</div>}
        {rawMode ? (
          <TextArea aria-label="简历 JSON" value={raw} onChange={e => { setRaw(e.target.value); setDirty(true); }} className="min-h-[360px] font-[var(--font-code)] text-xs" />
        ) : (
          <div className="space-y-4">
            {SECTIONS.map(s => (
              <SectionEditor key={s.key} sectionKey={s.key} label={s.label} value={schema[s.key]} onChange={v => update({ ...schema, [s.key]: v })} />
            ))}
          </div>
        )}
      </Card>
      <Card title="导出">
        <div className="flex flex-wrap items-center gap-2">
          {(['pdf', 'docx', 'png'] as const).map(f => (
            <Button key={f} busy={exp.busy} onClick={() => void doExport(f)}><Download className="h-3.5 w-3.5" />{f.toUpperCase()}</Button>
          ))}
        </div>
        {exp.error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{exp.error}</div>}
        {exportResult && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            <span>已导出 {exportResult.format.toUpperCase()}：</span>
            <code className="break-all text-[var(--ink)]">{exportResult.path}</code>
            {exportResult.path.startsWith('（') ? null : (
              <Button variant="ghost" onClick={() => void openExternal(fileDirname(exportResult.path))}><FolderOpen className="h-3.5 w-3.5" />打开所在文件夹</Button>
            )}
          </div>
        )}
        <div className="mt-2 text-xs text-[var(--ink-subtle)]">
          {selected.kind === 'tailored' && [selected.row.export_pdf, selected.row.export_docx, selected.row.export_png].some(Boolean)
            ? `历史导出：${[selected.row.export_pdf, selected.row.export_docx, selected.row.export_png].filter(Boolean).join('，')}`
            : '导出文件写到 CAREER_DATA_DIR/exports/'}
        </div>
      </Card>
    </div>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function SectionEditor({ sectionKey, label, value, onChange }: { sectionKey: SectionKey; label: string; value: unknown; onChange: (v: unknown) => void }) {
  if (sectionKey === 'basics') {
    const basics = isRecord(value) ? value : {};
    const extraKeys = Object.keys(basics).filter(k => !BASICS_FIELDS.some(f => f.key === k));
    return (
      <div>
        <SectionTitle>{label}</SectionTitle>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {[...BASICS_FIELDS, ...extraKeys.map(k => ({ key: k, label: k }))].map(f => (
            <Field key={f.key} label={f.label}>
              <TextInput value={stringOf(basics[f.key])} onChange={e => onChange({ ...basics, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
      </div>
    );
  }
  if (sectionKey === 'skills') {
    const text = Array.isArray(value) ? value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n') : stringOf(value);
    return (
      <div>
        <SectionTitle>{label}</SectionTitle>
        <Field label="每行一项" hint="保存时按行拆成数组">
          <TextArea value={text} onChange={e => onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))} />
        </Field>
      </div>
    );
  }
  const items = Array.isArray(value) ? value : [];
  const hints = LIST_FIELD_HINTS[sectionKey] ?? [];
  const setItem = (i: number, next: unknown) => onChange(items.map((it, j) => (j === i ? next : it)));
  return (
    <div>
      <SectionTitle extra={<Button variant="ghost" onClick={() => onChange([...items, {}])}>添加一条</Button>}>{label}（{items.length}）</SectionTitle>
      {items.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">暂无内容</div>}
      <div className="space-y-2">
        {items.map((item, i) => {
          const obj: Record<string, unknown> = isRecord(item) ? item : { value: item };
          const bulletsKey = Array.isArray(obj.bullets) ? 'bullets' : Array.isArray(obj.highlights) ? 'highlights' : 'bullets';
          const bullets = Array.isArray(obj[bulletsKey]) ? (obj[bulletsKey] as unknown[]) : [];
          const otherKeys = Object.keys(obj).filter(k => k !== bulletsKey && !hints.some(h => h.key === k) && typeof obj[k] !== 'object');
          return (
            <div key={i} className="rounded-lg border border-[var(--line-subtle)] p-2">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {[...hints, ...otherKeys.map(k => ({ key: k, label: k }))].map(f => (
                  <Field key={f.key} label={f.label}>
                    <TextInput value={stringOf(obj[f.key])} onChange={e => setItem(i, { ...obj, [f.key]: e.target.value })} />
                  </Field>
                ))}
              </div>
              <div className="mt-2">
                <Field label="要点（每行一条）">
                  <TextArea
                    value={bullets.map(b => (typeof b === 'string' ? b : JSON.stringify(b))).join('\n')}
                    onChange={e => setItem(i, { ...obj, [bulletsKey]: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
                  />
                </Field>
              </div>
              <div className="mt-1 text-right">
                <Button variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}>删除这条</Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function stringOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** 桌面端 iframe 不能用相对路径，需要拼 Sidecar 绝对地址；浏览器开发模式走 Vite 代理的相对路径。 */
function useSidecarBase(): string | null | undefined {
  const tauri = isTauriEnvironment();
  const [base, setBase] = useState<string | null | undefined>(tauri ? undefined : '');
  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    getServerUrl().then(url => { if (!cancelled) setBase(url); }).catch(() => { if (!cancelled) setBase(null); });
    return () => { cancelled = true; };
  }, [tauri]);
  return base;
}

function ResumePreview({ resumeId }: { resumeId: string }) {
  const relative = careerApi.resumeFilePath(resumeId, 'pdf');
  const base = useSidecarBase();
  const [nonce, setNonce] = useState(0);
  const src = base == null ? null : `${base}${relative}`;
  return (
    <div className="min-w-0">
      <SectionTitle extra={<Button variant="ghost" onClick={() => setNonce(n => n + 1)}>刷新</Button>}>PDF 预览</SectionTitle>
      {src ? (
        <iframe key={`${src}#${nonce}`} title="简历 PDF 预览" src={`${src}${src.includes('?') ? '&' : '?'}_=${nonce}`} className="h-[640px] w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]" />
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-6 text-center text-xs text-[var(--ink-muted)]">预览不可用</div>
      )}
    </div>
  );
}
