/**
 * 简历内容（@career/resume 的 Resume，工具 / 定制 / 导出的权威）⇄ 简历工作台文档（resume-studio ResumeData：
 * 内容 + 模板 / 布局 / 字体 / 配色 / 富文本）。
 *
 *  - toStudio(resume, base)：用内容生成工作台文档；base 是已有的工作台文档时保留它的排版（metadata、图片样式、
 *    分区显示设置、自定义分区类型），只替换内容。条目 id 沿用 resume 里的 id（没有就生成稳定 id）。
 *  - fromStudio(studio, prev)：工作台保存时把内容写回 Resume；工作台表达不了的字段（部门、主张 claim_ids、
 *    项目角色 / 所属组织、起止拆分）按条目 id 从 prev 里继承，所以来回一圈不会丢。
 *
 * 富文本约定：要点列表 ⇄ `<ul><li>…</li></ul>`；工作台里写成段落也会按段落拆成要点。
 */
import type { Resume } from '@career/resume';
import type { ResumeData } from '@career/resume-studio/schema';

type Html = string;
type AnyItem = Record<string, unknown> & { id: string; hidden?: boolean };

// ---------- HTML ⇄ 要点 ----------
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

export function bulletsToHtml(bullets: readonly string[], lead?: readonly string[]): Html {
  const head = (lead ?? []).filter(Boolean).map(l => `<p>${escapeHtml(l)}</p>`).join('');
  const list = bullets.filter(b => b.trim());
  return head + (list.length ? `<ul>${list.map(b => `<li><p>${escapeHtml(b)}</p></li>`).join('')}</ul>` : '');
}

/** 富文本 → 纯文本行：列表项、段落、换行都拆成一行；去掉标签、解实体。 */
export function htmlToLines(html: string | undefined | null): string[] {
  if (!html) return [];
  const blocks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li|p|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(blocks).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ---------- 时间段 ----------
const PERIOD_SEP = /\s*(?:-|–|—|~|～|至|to)\s*/;
export function joinPeriod(start: string, end: string): string {
  if (start && end) return `${start} - ${end}`;
  return start || end || '';
}
export function splitPeriod(period: string): { start: string; end: string } {
  const p = period.trim();
  if (!p) return { start: '', end: '' };
  // "2024.06 至今" / "2024.06 - 至今"：至今是结束值，不是分隔符
  const ongoing = p.match(/^(.*?)\s*(?:-|–|—|~|～)?\s*(至今|今|present|now)$/i);
  if (ongoing && ongoing[1]) return { start: ongoing[1].trim(), end: '至今' };
  const parts = p.split(PERIOD_SEP).filter(Boolean);
  if (parts.length >= 2) return { start: parts[0], end: parts.slice(1).join(' ') };
  return { start: p, end: '' };
}

// ---------- 小工具 ----------
const LEAD_ROLE = '角色：';
const LEAD_ORG = '所属：';
const LEAD_COURSES = '主修课程：';
const LEAD_SUBTITLE = '';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const stableId = (prefix: string, i: number, id?: string | null) => (id && id.trim() ? id : `${prefix}-${i + 1}`);
const byId = <T extends { id?: string }>(list: readonly T[]) => new Map(list.filter(x => x.id).map(x => [x.id as string, x]));
const website = (url = '', label = '') => ({ url, label, inlineLink: false });

/** 去掉以 lead 开头的那几行，返回 [前导值, 剩余行]。 */
function takeLead(lines: string[], lead: string): [string, string[]] {
  const i = lines.findIndex(l => l.startsWith(lead));
  if (i < 0) return ['', lines];
  return [lines[i].slice(lead.length).trim(), lines.filter((_, j) => j !== i)];
}

const CUSTOM_FIELD_DEFS = [
  { key: 'expected_salary', id: 'cf-expected-salary', icon: 'currency-cny', label: '期望薪资' },
  { key: 'target_cities', id: 'cf-target-cities', icon: 'map-pin', label: '期望城市' },
  { key: 'political_status', id: 'cf-political-status', icon: 'flag', label: '政治面貌' },
  { key: 'availability', id: 'cf-availability', icon: 'calendar', label: '到岗' },
] as const;

const SECTION_MAP = {
  education: 'education', experience: 'experience', projects: 'projects', skills: 'skills', awards: 'awards', certifications: 'certifications',
} as const;
type MappedKey = keyof typeof SECTION_MAP;

// ---------- Resume → 工作台文档 ----------
export function toStudio(resume: Resume, base: ResumeData): ResumeData {
  const out = structuredClone(base) as ResumeData;
  const b = resume.basics;
  const prevFields = new Map(out.basics.customFields.map(f => [f.id, f]));
  const customFields: ResumeData['basics']['customFields'] = CUSTOM_FIELD_DEFS.flatMap(def => {
    const raw = b[def.key as keyof typeof b];
    const value = Array.isArray(raw) ? raw.filter(Boolean).join(' / ') : str(raw);
    if (!value) return [];
    const prev = prevFields.get(def.id);
    return [{ id: def.id as string, icon: prev?.icon ?? def.icon, text: `${def.label}：${value}`, link: '' }];
  });
  // 主链接放 website，其余链接作为自定义字段
  const [firstLink, ...moreLinks] = b.links ?? [];
  moreLinks.forEach((l, i) => customFields.push({ id: `cf-link-${i + 1}`, icon: prevFields.get(`cf-link-${i + 1}`)?.icon ?? 'link', text: l.label || l.url, link: l.url }));
  // 用户在工作台里自己加的自定义字段（不是由内容生成的）保留
  for (const f of out.basics.customFields) if (!f.id.startsWith('cf-')) customFields.push(f);

  out.basics = {
    ...out.basics,
    name: b.name, headline: b.objective, email: b.email, phone: b.phone, location: b.city,
    website: { url: firstLink?.url ?? '', label: firstLink?.label ?? '' },
    customFields,
  };
  out.picture = { ...out.picture, url: b.photo_url, hidden: out.picture.hidden && !!b.photo_url ? out.picture.hidden : !b.photo_url };

  const titled = (key: MappedKey | 'custom_sections') => resume.section_titles?.[key as keyof Resume['section_titles']] ?? '';
  const keep = <T extends AnyItem>(section: { items: AnyItem[] }, id: string) => (section.items.find(x => x.id === id) as T | undefined);

  const s = out.sections;
  s.education = { ...s.education, title: titled('education') || s.education.title, items: resume.education.map((e, i) => {
    const id = stableId('edu', i, e.id);
    return { ...(keep(s.education, id) ?? {}), id, hidden: keep(s.education, id)?.hidden ?? false, school: e.school || '（学校）', degree: e.degree, area: e.major, grade: e.gpa, location: keep(s.education, id)?.location as string ?? '', period: joinPeriod(e.start, e.end), website: website(), description: bulletsToHtml(e.bullets, e.courses.length ? [`${LEAD_COURSES}${e.courses.join('、')}`] : []) };
  }) } as typeof s.education;
  s.experience = { ...s.experience, title: titled('experience') || s.experience.title, items: resume.experience.map((e, i) => {
    const id = stableId('exp', i, e.id);
    const prev = keep(s.experience, id);
    return { ...(prev ?? {}), id, hidden: prev?.hidden ?? false, company: e.org || '（单位）', position: e.position, location: e.location, period: joinPeriod(e.start, e.end), website: website(), description: bulletsToHtml(e.bullets),
      roles: e.roles.map((r, j) => ({ id: stableId(`${id}-role`, j, r.id), position: r.position, period: joinPeriod(r.start, r.end), description: bulletsToHtml(r.bullets) })) };
  }) } as typeof s.experience;
  s.projects = { ...s.projects, title: titled('projects') || s.projects.title, items: resume.projects.map((p, i) => {
    const id = stableId('prj', i, p.id);
    const prev = keep(s.projects, id);
    const lead = [p.role ? `${LEAD_ROLE}${p.role}` : '', p.org ? `${LEAD_ORG}${p.org}` : ''].filter(Boolean);
    return { ...(prev ?? {}), id, hidden: prev?.hidden ?? false, name: p.name || '（项目）', period: joinPeriod(p.start, p.end), website: website(p.link), description: bulletsToHtml(p.bullets, lead) };
  }) } as typeof s.projects;
  s.skills = { ...s.skills, title: titled('skills') || s.skills.title, items: resume.skills.map((k, i) => {
    const id = stableId('skl', i, k.id);
    const prev = keep(s.skills, id);
    return { ...(prev ?? {}), id, hidden: prev?.hidden ?? false, icon: (prev?.icon as string) ?? '', iconColor: (prev?.iconColor as string) ?? '', name: k.name || '（技能）', proficiency: k.level, level: (prev?.level as number) ?? 0, keywords: k.keywords };
  }) } as typeof s.skills;
  s.awards = { ...s.awards, title: titled('awards') || s.awards.title, items: resume.awards.map((a, i) => {
    const id = stableId('awd', i, a.id);
    const prev = keep(s.awards, id);
    return { ...(prev ?? {}), id, hidden: prev?.hidden ?? false, title: a.title || '（奖项）', awarder: a.issuer, date: a.date, website: website(), description: a.description ? bulletsToHtml([], [a.description]) : '' };
  }) } as typeof s.awards;
  s.certifications = { ...s.certifications, title: titled('certifications') || s.certifications.title, items: resume.certifications.map((c, i) => {
    const id = stableId('crt', i, c.id);
    const prev = keep(s.certifications, id);
    return { ...(prev ?? {}), id, hidden: prev?.hidden ?? false, title: c.title || '（证书）', issuer: c.issuer, date: c.date, website: website(), description: (prev?.description as string) ?? '' };
  }) } as typeof s.certifications;

  // 自定义分区 → 经历型自定义分区（标题 = 公司位，副标题 = 职位位）
  const prevCustom = new Map(out.customSections.map(c => [c.id, c]));
  const fromContent = resume.custom_sections.map((c, i) => {
    const id = stableId('cus', i, c.id);
    const prev = prevCustom.get(id) as (typeof out.customSections)[number] | undefined;
    return {
      ...(prev ?? { icon: 'star', columns: 1, hidden: false, showHeading: true, keepTogether: false, startOnNewPage: false }),
      id, type: 'experience' as const, title: c.title || '补充信息',
      items: c.items.map((it, j) => ({ id: stableId(`${id}-it`, j, it.id), hidden: false, company: it.title || '（条目）', position: it.subtitle, location: '', period: it.date, website: website(), description: bulletsToHtml(it.bullets), roles: [] })),
    };
  });
  const contentIds = new Set(fromContent.map(c => c.id));
  out.customSections = [...fromContent, ...out.customSections.filter(c => !contentIds.has(c.id) && !c.id.startsWith('cus-'))] as typeof out.customSections;

  ensureLayout(out);
  return out;
}

/** 布局里补上有内容但没被放进任何页面的分区（新增分区不会"消失"）。 */
function ensureLayout(data: ResumeData): void {
  const placed = new Set(data.metadata.layout.pages.flatMap(p => [...p.main, ...p.sidebar]));
  const want: string[] = ['summary', ...Object.keys(SECTION_MAP), ...data.customSections.map(c => c.id)];
  const page = data.metadata.layout.pages[0];
  if (!page) return;
  for (const key of want) if (!placed.has(key)) page.main.push(key);
}

// ---------- 工作台文档 → Resume ----------
export function fromStudio(studio: ResumeData, prev: Resume): Resume {
  const b = studio.basics;
  const fieldValue = (id: string, label: string) => {
    const f = b.customFields.find(x => x.id === id);
    if (!f) return '';
    return f.text.startsWith(`${label}：`) ? f.text.slice(label.length + 1).trim() : f.text.trim();
  };
  const linkFields = b.customFields.filter(f => f.id.startsWith('cf-link-')).map(f => ({ label: f.text, url: f.link }));
  const links = [...(b.website.url ? [{ label: b.website.label, url: b.website.url }] : []), ...linkFields];

  const prevEdu = byId(prev.education), prevExp = byId(prev.experience), prevPrj = byId(prev.projects);
  const prevSkl = byId(prev.skills), prevAwd = byId(prev.awards), prevCrt = byId(prev.certifications), prevCus = byId(prev.custom_sections);
  const s = studio.sections;
  const titleOf = (key: MappedKey) => (s[key].title ? { [key]: s[key].title } : {});

  return {
    ...prev,
    basics: {
      ...prev.basics,
      name: b.name, objective: b.headline, email: b.email, phone: b.phone, city: b.location,
      photo_url: studio.picture.hidden ? prev.basics.photo_url : studio.picture.url,
      expected_salary: fieldValue('cf-expected-salary', '期望薪资'),
      target_cities: fieldValue('cf-target-cities', '期望城市').split(/\s*\/\s*|、|,|，/).filter(Boolean),
      political_status: fieldValue('cf-political-status', '政治面貌'),
      availability: fieldValue('cf-availability', '到岗'),
      links,
    },
    education: s.education.items.map(it => {
      const p = prevEdu.get(it.id);
      const [courses, rest] = takeLead(htmlToLines(it.description), LEAD_COURSES);
      const { start, end } = splitPeriod(it.period);
      return { ...(p ?? { claim_ids: [] }), id: it.id, school: it.school, degree: it.degree, major: it.area, gpa: it.grade, start, end, courses: courses ? courses.split(/、|,|，/).map(x => x.trim()).filter(Boolean) : [], bullets: rest };
    }),
    experience: s.experience.items.map(it => {
      const p = prevExp.get(it.id);
      const { start, end } = splitPeriod(it.period);
      const prevRoles = byId(p?.roles ?? []);
      return { ...(p ?? { department: '', claim_ids: [] }), id: it.id, org: it.company, position: it.position, location: it.location, start, end, bullets: htmlToLines(it.description),
        roles: (it.roles ?? []).map(r => { const pr = prevRoles.get(r.id); const per = splitPeriod(r.period); return { ...(pr ?? { claim_ids: [] }), id: r.id, position: r.position, start: per.start, end: per.end, bullets: htmlToLines(r.description) }; }) };
    }),
    projects: s.projects.items.map(it => {
      const p = prevPrj.get(it.id);
      const lines = htmlToLines(it.description);
      const [role, afterRole] = takeLead(lines, LEAD_ROLE);
      const [org, bullets] = takeLead(afterRole, LEAD_ORG);
      const { start, end } = splitPeriod(it.period);
      return { ...(p ?? { claim_ids: [] }), id: it.id, name: it.name, role, org, start, end, link: it.website?.url ?? '', bullets };
    }),
    skills: s.skills.items.map(it => ({ ...(prevSkl.get(it.id) ?? { claim_ids: [] }), id: it.id, name: it.name, level: it.proficiency, keywords: it.keywords })),
    awards: s.awards.items.map(it => ({ ...(prevAwd.get(it.id) ?? { claim_ids: [] }), id: it.id, title: it.title, issuer: it.awarder, date: it.date, description: htmlToLines(it.description).join(' ') })),
    certifications: s.certifications.items.map(it => ({ ...(prevCrt.get(it.id) ?? { claim_ids: [] }), id: it.id, title: it.title, issuer: it.issuer, date: it.date })),
    custom_sections: studio.customSections.filter(c => c.type === 'experience').map(c => ({
      ...(prevCus.get(c.id) ?? {}), id: c.id, title: c.title,
      items: c.items.map(it => { const x = it as AnyItem; return { id: x.id, title: str(x.company), subtitle: str(x.position) || LEAD_SUBTITLE, date: str(x.period), bullets: htmlToLines(str(x.description)), claim_ids: (prevCus.get(c.id)?.items.find(pi => pi.id === x.id)?.claim_ids) ?? [] }; }),
    })),
    section_titles: { ...prev.section_titles, ...titleOf('education'), ...titleOf('experience'), ...titleOf('projects'), ...titleOf('skills'), ...titleOf('awards'), ...titleOf('certifications') },
  };
}
