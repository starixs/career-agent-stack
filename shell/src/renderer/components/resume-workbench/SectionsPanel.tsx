/**
 * 工作台左栏：基本信息 / 个人总结 / 各分区条目（拖拽排序、显隐、复制、删除、展开编辑）/ 自定义分区。
 */
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, GripVertical, ImagePlus, Lock, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';

import { BulletsEditor } from './BulletsEditor';
import { EDITABLE_SECTIONS, edit, itemLabel, moveItem, newItem, placeholderLabel, type ItemSectionKey } from './studioEdit';

type Update = (recipe: (d: ResumeData) => ResumeData, opts?: { merge?: string }) => void;
type Item = Record<string, unknown> & { id: string; hidden: boolean };

// ---------- 小部件 ----------
const INPUT = 'w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:border-[var(--primary)] focus:outline-none';

function TextField({ label, value, onChange, placeholder, wide }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; wide?: boolean }) {
  const vault = placeholderLabel(value);
  return (
    <label className={`flex flex-col gap-1 text-xs text-[var(--muted)] ${wide ? 'col-span-2' : ''}`}>
      <span>{label}</span>
      {vault
        ? <span className="flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--inset)] px-2 py-1 text-sm text-[var(--muted)]" title="这一项来自私密信息库：预览和导出时自动替换成真实值，助理看不到"><Lock className="size-3.5" />来自私密信息：{vault}</span>
        : <input aria-label={label} className={INPUT} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />}
    </label>
  );
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}
      className={`rounded p-1 text-[var(--subtle)] transition-colors hover:bg-[var(--inset)] ${danger ? 'hover:text-[var(--danger)]' : 'hover:text-[var(--ink)]'}`}>
      {children}
    </button>
  );
}

function Panel({ title, extra, children, defaultOpen = true, muted }: { title: ReactNode; extra?: ReactNode; children: ReactNode; defaultOpen?: boolean; muted?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--paper)]">
      <div className="flex items-center gap-1 px-3 py-2">
        <button type="button" onClick={() => setOpen(o => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="size-4 text-[var(--muted)]" /> : <ChevronRight className="size-4 text-[var(--muted)]" />}
          <span className={`truncate text-sm font-medium ${muted ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}`}>{title}</span>
        </button>
        {extra}
      </div>
      {open && <div className="border-t border-[var(--line)] px-3 py-3">{children}</div>}
    </section>
  );
}

// ---------- 各分区的字段 ----------
type FieldDef = { key: string; label: string; wide?: boolean; path?: string[]; list?: boolean };
const FIELDS: Record<ItemSectionKey, FieldDef[]> = {
  education: [{ key: 'school', label: '学校', wide: true }, { key: 'degree', label: '学历' }, { key: 'area', label: '专业' }, { key: 'grade', label: '成绩 / 排名' }, { key: 'period', label: '时间' }, { key: 'location', label: '城市', wide: true }],
  experience: [{ key: 'company', label: '单位', wide: true }, { key: 'position', label: '职位' }, { key: 'period', label: '时间' }, { key: 'location', label: '城市', wide: true }],
  projects: [{ key: 'name', label: '项目名称', wide: true }, { key: 'period', label: '时间' }, { key: 'url', label: '链接', path: ['website', 'url'] }],
  skills: [{ key: 'name', label: '技能组', wide: true }, { key: 'proficiency', label: '熟练度' }, { key: 'keywords', label: '具体技能（顿号分隔）', list: true }],
  awards: [{ key: 'title', label: '奖项', wide: true }, { key: 'awarder', label: '颁发方' }, { key: 'date', label: '时间' }],
  certifications: [{ key: 'title', label: '证书', wide: true }, { key: 'issuer', label: '颁发方' }, { key: 'date', label: '时间' }],
  languages: [{ key: 'language', label: '语言' }, { key: 'fluency', label: '水平（如 CET-6 / 雅思 7）' }],
  profiles: [{ key: 'network', label: '平台' }, { key: 'username', label: '用户名' }, { key: 'url', label: '链接', path: ['website', 'url'], wide: true }],
  publications: [{ key: 'title', label: '题目', wide: true }, { key: 'publisher', label: '期刊 / 会议' }, { key: 'date', label: '时间' }],
  volunteer: [{ key: 'organization', label: '组织', wide: true }, { key: 'period', label: '时间' }, { key: 'location', label: '城市' }],
  interests: [{ key: 'name', label: '兴趣', wide: true }, { key: 'keywords', label: '关键词（顿号分隔）', list: true, wide: true }],
  references: [{ key: 'name', label: '姓名', wide: true }, { key: 'position', label: '职位' }, { key: 'phone', label: '电话' }],
};
const HAS_DESCRIPTION = new Set<ItemSectionKey>(['education', 'experience', 'projects', 'awards', 'certifications', 'publications', 'volunteer', 'references']);

const getField = (item: Item, f: FieldDef): string => {
  if (f.path) { let v: unknown = item; for (const k of f.path) v = (v as Record<string, unknown> | undefined)?.[k]; return typeof v === 'string' ? v : ''; }
  const v = item[f.key];
  if (f.list) return Array.isArray(v) ? (v as string[]).join('、') : '';
  return typeof v === 'string' ? v : '';
};
const setField = (item: Item, f: FieldDef, value: string) => {
  if (f.path) {
    let obj = item as Record<string, unknown>;
    for (const k of f.path.slice(0, -1)) { obj[k] = { ...((obj[k] as Record<string, unknown>) ?? {}) }; obj = obj[k] as Record<string, unknown>; }
    obj[f.path[f.path.length - 1]] = value;
  } else if (f.list) {
    item[f.key] = value.split(/、|,|，/).map(x => x.trim()).filter(Boolean);
  } else {
    item[f.key] = value;
  }
};

// ---------- 可排序的条目 ----------
function SortableItem({ section, item, index, update, open, onToggle }: {
  section: ItemSectionKey; item: Item; index: number; update: Update; open: boolean; onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const label = itemLabel(section, item);
  const patch = (mutate: (it: Item) => void, merge?: string) => update(d => edit(d, draft => { mutate(draft.sections[section].items[index] as Item); }), merge ? { merge } : undefined);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`rounded-lg border bg-[var(--bg)] ${isDragging ? 'z-10 border-[var(--primary)] shadow-lg' : 'border-[var(--line)]'}`}>
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button type="button" aria-label="拖动排序" className="cursor-grab rounded p-1 text-[var(--subtle)] hover:text-[var(--ink)] active:cursor-grabbing" {...attributes} {...listeners}><GripVertical className="size-4" /></button>
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className={`truncate text-sm ${item.hidden ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}`}>{label.title || '（未命名）'}</div>
          {label.subtitle && <div className="truncate text-xs text-[var(--muted)]">{label.subtitle}</div>}
        </button>
        <IconButton label={item.hidden ? '在简历里显示' : '在简历里隐藏'} onClick={() => patch(it => { it.hidden = !it.hidden; })}>{item.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</IconButton>
        <IconButton label="复制一份" onClick={() => update(d => edit(d, draft => { const list = draft.sections[section].items as Item[]; list.splice(index + 1, 0, { ...structuredClone(item), id: (newItem(section) as Item).id }); }))}><Copy className="size-4" /></IconButton>
        <IconButton label="删除" danger onClick={() => update(d => edit(d, draft => { (draft.sections[section].items as Item[]).splice(index, 1); }))}><Trash2 className="size-4" /></IconButton>
      </div>
      {open && (
        <div className="space-y-3 border-t border-[var(--line)] px-3 py-3">
          <div className="grid grid-cols-2 gap-2">
            {FIELDS[section].map(f => (
              <TextField key={f.key} label={f.label} wide={f.wide} value={getField(item, f)} onChange={v => patch(it => setField(it, f, v), `${item.id}.${f.key}`)} />
            ))}
          </div>
          {HAS_DESCRIPTION.has(section) && (
            <BulletsEditor value={typeof item.description === 'string' ? item.description : ''} onChange={html => patch(it => { it.description = html; }, `${item.id}.description`)} />
          )}
        </div>
      )}
    </li>
  );
}

function ItemSection({ section, label, addLabel, data, update }: { section: ItemSectionKey; label: string; addLabel: string; data: ResumeData; update: Update }) {
  const s = data.sections[section];
  const items = s.items as Item[];
  const [openId, setOpenId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex(x => x.id === e.active.id), to = items.findIndex(x => x.id === e.over!.id);
    if (from < 0 || to < 0) return;
    update(d => edit(d, draft => { (draft.sections[section] as { items: Item[] }).items = moveItem(draft.sections[section].items as Item[], from, to); }));
  };
  const add = () => {
    const it = newItem(section) as Item;
    update(d => edit(d, draft => { (draft.sections[section].items as Item[]).push(it); }));
    setOpenId(it.id);
  };
  return (
    <Panel
      defaultOpen={items.length > 0}
      muted={s.hidden}
      title={<>{s.title || label}<span className="ml-1.5 text-xs font-normal text-[var(--muted)]">{items.length || ''}</span></>}
      extra={<IconButton label={s.hidden ? '显示这个分区' : '隐藏这个分区'} onClick={() => update(d => edit(d, draft => { draft.sections[section].hidden = !draft.sections[section].hidden; }))}>{s.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</IconButton>}
    >
      <label className="mb-2 flex items-center gap-2 text-xs text-[var(--muted)]">
        <span className="shrink-0">分区标题</span>
        <input aria-label={`${label}标题`} className={INPUT} placeholder={label} value={s.title} onChange={e => { const v = e.target.value; update(d => edit(d, draft => { draft.sections[section].title = v; }), { merge: `${section}.title` }); }} />
      </label>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map(x => x.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1.5">
            {items.map((it, i) => (
              <SortableItem key={it.id} section={section} item={it} index={i} update={update} open={openId === it.id} onToggle={() => setOpenId(o => (o === it.id ? null : it.id))} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <button type="button" onClick={add} className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--line)] px-2 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--primary)] hover:text-[var(--ink)]">
        <Plus className="size-3.5" />{addLabel}
      </button>
    </Panel>
  );
}

// ---------- 证件照 ----------
async function fileToDataUrl(file: File, max = 640): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('图片读取失败')); i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function BasicsPanel({ data, update }: { data: ResumeData; update: Update }) {
  const b = data.basics;
  const set = (key: 'name' | 'headline' | 'email' | 'phone' | 'location', v: string) => update(d => edit(d, draft => { draft.basics[key] = v; }), { merge: `basics.${key}` });
  const [photoError, setPhotoError] = useState<string | null>(null);
  return (
    <Panel title="基本信息">
      <div className="flex gap-3">
        <label className="group relative flex size-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-[var(--line)] bg-[var(--inset)] text-[var(--muted)] hover:border-[var(--primary)]" title="上传证件照（可选）">
          {data.picture.url && !data.picture.hidden
            ? <img src={data.picture.url} alt="证件照" className="size-full object-cover" />
            : <ImagePlus className="size-5" />}
          <input type="file" accept="image/*" className="hidden" aria-label="上传证件照" onChange={async e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            try { const url = await fileToDataUrl(f); setPhotoError(null); update(d => edit(d, draft => { draft.picture.url = url; draft.picture.hidden = false; })); } catch (err) { setPhotoError(err instanceof Error ? err.message : String(err)); }
          }} />
        </label>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
          <TextField label="姓名" value={b.name} onChange={v => set('name', v)} wide />
          <TextField label="求职意向 / 一句话" value={b.headline} onChange={v => set('headline', v)} wide />
        </div>
      </div>
      {data.picture.url && (
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
          <button type="button" className="hover:text-[var(--ink)]" onClick={() => update(d => edit(d, draft => { draft.picture.hidden = !draft.picture.hidden; }))}>{data.picture.hidden ? '显示照片' : '隐藏照片'}</button>
          <button type="button" className="hover:text-[var(--danger)]" onClick={() => update(d => edit(d, draft => { draft.picture.url = ''; draft.picture.hidden = true; }))}>删除照片</button>
        </div>
      )}
      {photoError && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{photoError}</div>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <TextField label="手机" value={b.phone} onChange={v => set('phone', v)} />
        <TextField label="邮箱" value={b.email} onChange={v => set('email', v)} />
        <TextField label="城市" value={b.location} onChange={v => set('location', v)} />
        <TextField label="个人主页 / 作品集" value={b.website.url} onChange={v => update(d => edit(d, draft => { draft.basics.website = { ...draft.basics.website, url: v }; }), { merge: 'basics.website' })} />
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="text-xs text-[var(--muted)]">其他信息（期望薪资、政治面貌、到岗时间…）</div>
        {b.customFields.map((f, i) => (
          <div key={f.id} className="flex items-center gap-1">
            <input aria-label={`其他信息 ${i + 1}`} className={INPUT} value={f.text} onChange={e => { const v = e.target.value; update(d => edit(d, draft => { draft.basics.customFields[i].text = v; }), { merge: `cf.${f.id}` }); }} />
            <IconButton label="删除" danger onClick={() => update(d => edit(d, draft => { draft.basics.customFields.splice(i, 1); }))}><Trash2 className="size-4" /></IconButton>
          </div>
        ))}
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--inset)] hover:text-[var(--ink)]"
          onClick={() => update(d => edit(d, draft => { draft.basics.customFields.push({ id: `user-${Date.now()}`, icon: 'info', text: '', link: '' }); }))}>
          <Plus className="size-3.5" />添加一项
        </button>
      </div>
    </Panel>
  );
}

function SummaryPanel({ data, update }: { data: ResumeData; update: Update }) {
  return (
    <Panel title={data.summary.title || '个人总结'} defaultOpen={!!data.summary.content} muted={data.summary.hidden}
      extra={<IconButton label={data.summary.hidden ? '显示' : '隐藏'} onClick={() => update(d => edit(d, draft => { draft.summary.hidden = !draft.summary.hidden; }))}>{data.summary.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</IconButton>}>
      <BulletsEditor label="内容" value={data.summary.content} onChange={html => update(d => edit(d, draft => { draft.summary.content = html; }), { merge: 'summary' })} />
    </Panel>
  );
}

export function SectionsPanel({ data, update }: { data: ResumeData; update: Update }) {
  const [showMore, setShowMore] = useState(false);
  const primary = EDITABLE_SECTIONS.slice(0, 6);
  const more = EDITABLE_SECTIONS.slice(6);
  const visibleMore = more.filter(s => showMore || data.sections[s.key].items.length > 0);
  return (
    <div data-testid="studio-sections" className="space-y-2">
      <BasicsPanel data={data} update={update} />
      <SummaryPanel data={data} update={update} />
      {primary.map(s => <ItemSection key={s.key} section={s.key} label={s.label} addLabel={s.addLabel} data={data} update={update} />)}
      {visibleMore.map(s => <ItemSection key={s.key} section={s.key} label={s.label} addLabel={s.addLabel} data={data} update={update} />)}
      {!showMore && visibleMore.length < more.length && (
        <button type="button" onClick={() => setShowMore(true)} className="w-full rounded-lg px-2 py-2 text-xs text-[var(--muted)] hover:bg-[var(--inset)] hover:text-[var(--ink)]">
          更多分区（语言、论文、社团志愿、兴趣…）
        </button>
      )}
    </div>
  );
}
