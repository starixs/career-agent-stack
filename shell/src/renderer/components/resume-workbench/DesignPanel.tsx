/**
 * 工作台右栏：模板 / 版式（分区放主栏还是侧栏、顺序、侧栏宽度）/ 字体 / 配色 / 页面。
 */
import { ArrowDown, ArrowUp, Check, PanelLeft, PanelRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';
import { getFont } from '@career/resume-studio/fonts';

import CustomSelect from '@/components/CustomSelect';

import { EDITABLE_SECTIONS, edit } from './studioEdit';

type Update = (recipe: (d: ResumeData) => ResumeData, opts?: { merge?: string }) => void;

const THUMBS = import.meta.glob('./templates/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const thumbOf = (t: string) => THUMBS[`./templates/${t}.jpg`];

const TEMPLATES: Array<{ id: ResumeData['metadata']['template']; label: string }> = [
  { id: 'onyx', label: 'Onyx · 经典单栏' }, { id: 'azurill', label: 'Azurill · 双栏' }, { id: 'pikachu', label: 'Pikachu · 色块页眉' },
  { id: 'bronzor', label: 'Bronzor · 简洁' }, { id: 'chikorita', label: 'Chikorita · 侧栏' }, { id: 'ditto', label: 'Ditto · 横幅' },
  { id: 'gengar', label: 'Gengar · 深色侧栏' }, { id: 'glalie', label: 'Glalie · 浅色侧栏' }, { id: 'kakuna', label: 'Kakuna · 居中' },
  { id: 'lapras', label: 'Lapras · 卡片' }, { id: 'leafish', label: 'Leafish · 双色' }, { id: 'meowth', label: 'Meowth · 紧凑' },
  { id: 'rhyhorn', label: 'Rhyhorn · 线条' }, { id: 'scizor', label: 'Scizor · 现代' }, { id: 'ditgar', label: 'Ditgar · 混合' },
];

/** 字体：中文优先（中文字形由 Noto Sans SC 兜底，标题 / 西文用所选字体）。 */
const FONT_CHOICES = ['Noto Sans SC', 'Noto Serif SC', 'IBM Plex Serif', 'IBM Plex Sans', 'Inter', 'Lato', 'Merriweather', 'Open Sans', 'Roboto', 'Source Sans 3', 'PT Serif', 'EB Garamond', 'Lora', 'Montserrat', 'Nunito Sans']
  .filter(f => getFont(f));

const COLORS = ['#2563eb', '#0f766e', '#dc2626', '#7c3aed', '#ea580c', '#0e7490', '#be185d', '#111827'];
const hexToRgba = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 1)`; };
const rgbaToHex = (rgba: string) => {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '#000000';
  return `#${[m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('')}`;
};

const SECTION_LABEL: Record<string, string> = { summary: '个人总结', ...Object.fromEntries(EDITABLE_SECTIONS.map(s => [s.key, s.label])) };

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-[var(--line-subtle)] px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Range({ label, value, min, max, step = 1, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="block text-xs text-[var(--ink-muted)]">
      <div className="mb-1 flex justify-between"><span>{label}</span><span className="tabular-nums text-[var(--ink)]">{value}{unit}</span></div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-sm text-[var(--ink)]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="size-4 accent-[var(--accent)]" />
    </label>
  );
}

function weightsFor(family: string, want: string[]): string[] {
  const available = getFont(family)?.weights ?? ['400'];
  const pick = want.filter(w => available.includes(w as never));
  return pick.length ? pick : [available.includes('400' as never) ? '400' : available[0]];
}

export function DesignPanel({ data, update }: { data: ResumeData; update: Update }) {
  const m = data.metadata;
  const page0 = m.layout.pages[0];
  const [customColor, setCustomColor] = useState(rgbaToHex(m.design.colors.primary));

  const moveIn = (column: 'main' | 'sidebar', i: number, d: -1 | 1) => update(doc => edit(doc, draft => {
    const list = draft.metadata.layout.pages[0][column];
    const j = i + d; if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }));
  const switchColumn = (from: 'main' | 'sidebar', i: number) => update(doc => edit(doc, draft => {
    const p = draft.metadata.layout.pages[0];
    const [key] = p[from].splice(i, 1);
    p[from === 'main' ? 'sidebar' : 'main'].push(key);
  }));
  const labelOf = (key: string) => SECTION_LABEL[key] ?? data.customSections.find(c => c.id === key)?.title ?? key;

  return (
    <div data-testid="studio-design" className="text-sm">
      <Group title="模板">
        <div className="grid grid-cols-3 gap-2">
          {TEMPLATES.map(t => {
            const active = m.template === t.id;
            return (
              <button key={t.id} type="button" title={t.label} aria-label={t.label} aria-pressed={active} onClick={() => update(doc => edit(doc, draft => { draft.metadata.template = t.id; }))}
                className={`group relative overflow-hidden rounded-md border text-left transition-colors ${active ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/40' : 'border-[var(--line-subtle)] hover:border-[var(--line-strong)]'}`}>
                {thumbOf(t.id) ? <img src={thumbOf(t.id)} alt="" className="aspect-[1/1.414] w-full bg-white object-cover object-top" draggable={false} /> : <div className="aspect-[1/1.414] w-full bg-[var(--paper-inset)]" />}
                <div className="truncate px-1 py-0.5 text-xs text-[var(--ink-muted)]">{t.label.split(' · ')[0]}</div>
                {active && <Check className="absolute right-1 top-1 size-4 rounded-full bg-[var(--accent)] p-0.5 text-white" />}
              </button>
            );
          })}
        </div>
      </Group>

      {page0 && (
        <Group title="版式">
          <Toggle label="单栏（不用侧栏）" checked={page0.fullWidth} onChange={v => update(doc => edit(doc, draft => {
            const p = draft.metadata.layout.pages[0];
            p.fullWidth = v;
            if (v) { p.main.push(...p.sidebar); p.sidebar = []; }
          }))} />
          {!page0.fullWidth && <Range label="侧栏宽度" unit="%" min={20} max={45} value={m.layout.sidebarWidth} onChange={v => update(doc => edit(doc, draft => { draft.metadata.layout.sidebarWidth = v; }), { merge: 'sidebarWidth' })} />}
          {(['main', 'sidebar'] as const).filter(c => c === 'main' || !page0.fullWidth).map(column => (
            <div key={column}>
              <div className="mb-1 flex items-center gap-1 text-xs text-[var(--ink-muted)]">{column === 'main' ? <PanelLeft className="size-3.5" /> : <PanelRight className="size-3.5" />}{column === 'main' ? '主栏' : '侧栏'}</div>
              <ul className="space-y-1">
                {page0[column].map((key, i) => (
                  <li key={key} className="flex items-center gap-1 rounded-md border border-[var(--line-subtle)] bg-[var(--paper)] px-2 py-1">
                    <span className="min-w-0 flex-1 truncate">{labelOf(key)}</span>
                    <button type="button" aria-label={`${labelOf(key)} 上移`} className="rounded p-0.5 text-[var(--ink-subtle)] hover:text-[var(--ink)]" onClick={() => moveIn(column, i, -1)}><ArrowUp className="size-3.5" /></button>
                    <button type="button" aria-label={`${labelOf(key)} 下移`} className="rounded p-0.5 text-[var(--ink-subtle)] hover:text-[var(--ink)]" onClick={() => moveIn(column, i, 1)}><ArrowDown className="size-3.5" /></button>
                    {!page0.fullWidth && (
                      <button type="button" aria-label={`${labelOf(key)} 移到${column === 'main' ? '侧栏' : '主栏'}`} title={`移到${column === 'main' ? '侧栏' : '主栏'}`} className="rounded p-0.5 text-[var(--ink-subtle)] hover:text-[var(--ink)]" onClick={() => switchColumn(column, i)}>
                        {column === 'main' ? <PanelRight className="size-3.5" /> : <PanelLeft className="size-3.5" />}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Group>
      )}

      <Group title="字体">
        {(['body', 'heading'] as const).map(kind => (
          <div key={kind} className="space-y-2">
            <div className="text-xs text-[var(--ink-muted)]">{kind === 'body' ? '正文' : '标题'}</div>
            <CustomSelect
              ariaLabel={kind === 'body' ? '正文字体' : '标题字体'}
              value={m.typography[kind].fontFamily}
              options={FONT_CHOICES.map(f => ({ value: f, label: f }))}
              onChange={v => update(doc => edit(doc, draft => {
                const t = draft.metadata.typography[kind];
                t.fontFamily = v;
                t.fontWeights = weightsFor(v, kind === 'body' ? ['400', '600'] : ['600', '700']) as typeof t.fontWeights;
              }))}
            />
            <Range label="字号" unit="pt" min={kind === 'body' ? 8 : 10} max={kind === 'body' ? 13 : 20} step={0.5} value={m.typography[kind].fontSize} onChange={v => update(doc => edit(doc, draft => { draft.metadata.typography[kind].fontSize = v; }), { merge: `${kind}.size` })} />
            <Range label="行高" min={1} max={2} step={0.05} value={m.typography[kind].lineHeight} onChange={v => update(doc => edit(doc, draft => { draft.metadata.typography[kind].lineHeight = v; }), { merge: `${kind}.lh` })} />
          </div>
        ))}
      </Group>

      <Group title="配色">
        <div className="flex flex-wrap items-center gap-2">
          {COLORS.map(c => {
            const active = rgbaToHex(m.design.colors.primary).toLowerCase() === c;
            return (
              <button key={c} type="button" aria-label={`主色 ${c}`} aria-pressed={active} onClick={() => update(doc => edit(doc, draft => { draft.metadata.design.colors.primary = hexToRgba(c); }))}
                className={`size-7 rounded-full border-2 ${active ? 'border-[var(--ink)]' : 'border-transparent'}`} style={{ backgroundColor: c }} />
            );
          })}
          <label className="flex items-center gap-1 text-xs text-[var(--ink-muted)]">
            自定义
            <input type="color" aria-label="自定义主色" value={customColor} onChange={e => { const v = e.target.value; setCustomColor(v); update(doc => edit(doc, draft => { draft.metadata.design.colors.primary = hexToRgba(v); }), { merge: 'primary' }); }} className="size-7 cursor-pointer rounded border border-[var(--line)] bg-transparent" />
          </label>
        </div>
      </Group>

      <Group title="页面">
        <div className="flex gap-2">
          {(['a4', 'letter'] as const).map(f => (
            <button key={f} type="button" aria-pressed={m.page.format === f} onClick={() => update(doc => edit(doc, draft => { draft.metadata.page.format = f; }))}
              className={`flex-1 rounded-md border px-2 py-1 text-xs ${m.page.format === f ? 'border-[var(--accent)] text-[var(--ink)]' : 'border-[var(--line-subtle)] text-[var(--ink-muted)]'}`}>{f === 'a4' ? 'A4' : 'Letter'}</button>
          ))}
        </div>
        <Range label="左右页边距" unit="pt" min={6} max={40} value={m.page.marginX} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.marginX = v; }), { merge: 'marginX' })} />
        <Range label="上下页边距" unit="pt" min={6} max={40} value={m.page.marginY} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.marginY = v; }), { merge: 'marginY' })} />
        <Range label="分区间距" unit="pt" min={0} max={20} value={m.page.gapY} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.gapY = v; }), { merge: 'gapY' })} />
        <Toggle label="显示分区图标" checked={!m.page.hideSectionIcons} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.hideSectionIcons = !v; }))} />
        <Toggle label="显示联系方式图标" checked={!m.page.hideIcons} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.hideIcons = !v; }))} />
        <Toggle label="链接加下划线" checked={!m.page.hideLinkUnderline} onChange={v => update(doc => edit(doc, draft => { draft.metadata.page.hideLinkUnderline = !v; }))} />
      </Group>
    </div>
  );
}
