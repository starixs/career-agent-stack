/**
 * 工作台文档的小工具：不可变编辑、条目增删改移、占位符替换、新条目模板。
 */
import type { ResumeData } from '@career/resume-studio/schema';

/** 复制后在副本上改（文档几十 KB，按键级别复制可以接受，换来写法简单）。 */
export function edit(doc: ResumeData, mutate: (draft: ResumeData) => void): ResumeData {
  const draft = structuredClone(doc);
  mutate(draft);
  return draft;
}

export type ItemSectionKey = 'experience' | 'education' | 'projects' | 'skills' | 'awards' | 'certifications' | 'profiles' | 'languages' | 'interests' | 'publications' | 'volunteer' | 'references';

/** 工作台左栏展示的分区（中国校招 / 社招常用的放前面）。 */
export const EDITABLE_SECTIONS: Array<{ key: ItemSectionKey; label: string; addLabel: string }> = [
  { key: 'education', label: '教育经历', addLabel: '添加教育经历' },
  { key: 'experience', label: '实习 / 工作经历', addLabel: '添加经历' },
  { key: 'projects', label: '项目经历', addLabel: '添加项目' },
  { key: 'skills', label: '技能', addLabel: '添加技能' },
  { key: 'awards', label: '荣誉奖项', addLabel: '添加奖项' },
  { key: 'certifications', label: '证书', addLabel: '添加证书' },
  { key: 'languages', label: '语言', addLabel: '添加语言' },
  { key: 'profiles', label: '个人主页', addLabel: '添加主页' },
  { key: 'publications', label: '论文 / 出版', addLabel: '添加论文' },
  { key: 'volunteer', label: '社团 / 志愿', addLabel: '添加经历' },
  { key: 'interests', label: '兴趣爱好', addLabel: '添加兴趣' },
  { key: 'references', label: '推荐人', addLabel: '添加推荐人' },
];

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const site = () => ({ url: '', label: '', inlineLink: false });

/** 各分区的新条目（字段与 resume-studio schema 一致；必填的标题字段给中文占位）。 */
export function newItem(section: ItemSectionKey): Record<string, unknown> {
  const base = { id: uid(), hidden: false };
  switch (section) {
    case 'education': return { ...base, school: '新学校', degree: '', area: '', grade: '', location: '', period: '', website: site(), description: '' };
    case 'experience': return { ...base, company: '新单位', position: '', location: '', period: '', website: site(), description: '', roles: [] };
    case 'projects': return { ...base, name: '新项目', period: '', website: site(), description: '' };
    case 'skills': return { ...base, icon: '', iconColor: '', name: '新技能', proficiency: '', level: 0, keywords: [] };
    case 'awards': return { ...base, title: '新奖项', awarder: '', date: '', website: site(), description: '' };
    case 'certifications': return { ...base, title: '新证书', issuer: '', date: '', website: site(), description: '' };
    case 'languages': return { ...base, language: '英语', fluency: '', level: 0 };
    case 'profiles': return { ...base, icon: '', iconColor: '', network: 'GitHub', username: '', website: site() };
    case 'publications': return { ...base, title: '新论文', publisher: '', date: '', website: site(), description: '' };
    case 'volunteer': return { ...base, organization: '新组织', location: '', period: '', website: site(), description: '' };
    case 'interests': return { ...base, icon: '', iconColor: '', name: '新兴趣', keywords: [] };
    case 'references': return { ...base, name: '可应要求提供', position: '', website: site(), phone: '', description: '' };
  }
}

/** 条目的一行标题 / 副标题（左栏列表用）。 */
export function itemLabel(section: ItemSectionKey, item: Record<string, unknown>): { title: string; subtitle: string } {
  const s = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : '');
  switch (section) {
    case 'education': return { title: s('school'), subtitle: [s('degree'), s('area'), s('period')].filter(Boolean).join(' · ') };
    case 'experience': return { title: s('company'), subtitle: [s('position'), s('period')].filter(Boolean).join(' · ') };
    case 'projects': return { title: s('name'), subtitle: s('period') };
    case 'skills': return { title: s('name'), subtitle: Array.isArray(item.keywords) ? (item.keywords as string[]).join('、') : '' };
    case 'awards': return { title: s('title'), subtitle: [s('awarder'), s('date')].filter(Boolean).join(' · ') };
    case 'certifications': return { title: s('title'), subtitle: [s('issuer'), s('date')].filter(Boolean).join(' · ') };
    case 'languages': return { title: s('language'), subtitle: s('fluency') };
    case 'profiles': return { title: s('network'), subtitle: s('username') };
    case 'publications': return { title: s('title'), subtitle: [s('publisher'), s('date')].filter(Boolean).join(' · ') };
    case 'volunteer': return { title: s('organization'), subtitle: s('period') };
    case 'interests': return { title: s('name'), subtitle: '' };
    case 'references': return { title: s('name'), subtitle: s('position') };
  }
}

/** 预览用：把私密库占位符换成明文（只在内存里，不写回文档）。 */
export function withPreviewValues(doc: ResumeData, preview: Record<string, string>): ResumeData {
  const keys = Object.keys(preview);
  if (!keys.length) return doc;
  let json = JSON.stringify(doc);
  for (const k of keys) json = json.split(k).join(JSON.stringify(preview[k]).slice(1, -1));
  return JSON.parse(json) as ResumeData;
}

const PLACEHOLDER_LABELS: Record<string, string> = { name: '姓名', phone: '手机', email: '邮箱', idNumber: '证件号', address: '地址', wechat: '微信' };
/** 字段值是私密库占位符时给个可读说明（编辑区显示"来自私密信息：手机"而不是一串花括号）。 */
export function placeholderLabel(value: string): string | null {
  const m = value.match(/^\{\{vault:profile\.([a-zA-Z]+)\}\}$/);
  if (!m) return null;
  return PLACEHOLDER_LABELS[m[1]] ?? m[1];
}

export const moveItem = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
};
