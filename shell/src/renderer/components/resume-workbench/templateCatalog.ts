/** 简历模板目录：版式面板的模板格与简历汇总页的模板名共用。 */
import type { ResumeData } from '@career/resume-studio/schema';

const THUMBS = import.meta.glob('./templates/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const thumbOf = (t: string): string | undefined => THUMBS[`./templates/${t}.jpg`];

export const TEMPLATES: Array<{ id: ResumeData['metadata']['template']; label: string }> = [
  { id: 'onyx', label: 'Onyx · 经典单栏' }, { id: 'azurill', label: 'Azurill · 双栏' }, { id: 'pikachu', label: 'Pikachu · 色块页眉' },
  { id: 'bronzor', label: 'Bronzor · 简洁' }, { id: 'chikorita', label: 'Chikorita · 侧栏' }, { id: 'ditto', label: 'Ditto · 横幅' },
  { id: 'gengar', label: 'Gengar · 深色侧栏' }, { id: 'glalie', label: 'Glalie · 浅色侧栏' }, { id: 'kakuna', label: 'Kakuna · 居中' },
  { id: 'lapras', label: 'Lapras · 卡片' }, { id: 'leafish', label: 'Leafish · 双色' }, { id: 'meowth', label: 'Meowth · 紧凑' },
  { id: 'rhyhorn', label: 'Rhyhorn · 线条' }, { id: 'scizor', label: 'Scizor · 现代' }, { id: 'ditgar', label: 'Ditgar · 混合' },
];

export function templateLabel(id: string | undefined): string {
  return TEMPLATES.find(t => t.id === id)?.label ?? id ?? '未知模板';
}
