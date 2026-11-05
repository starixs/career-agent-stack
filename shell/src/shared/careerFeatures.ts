/**
 * 功能清单的唯一来源（plan-r3-suggest §4.4，2026-11-05）：功能市场（CareerGuide）和下一步条的"功能起头"格都从这里读，
 * 起头格和市场永不脱节。shared 不引 react：图标用 lucide 名字字符串，前端自己映射成组件。
 *
 * 起头三种：open 打开一页；prefill 把一句话预填进输入框；batch 回对话放一张批量勾选表。
 * 有公司时：prefillWith / chip 里的 `{company}` 由 resolveFeatureStart / featureChipText 换成公司名；
 * 没有公司时：prefill 用原句（与功能市场一字不差），起头格用 chipPlain。
 */

/** 能被打开的求职页（与 renderer 的 CareerPageKind 子集同名，结构上可直接当 NavTarget 用）。 */
export type FeaturePage = 'career-dossier' | 'career-material' | 'career-review' | 'career-live' | 'career-vault';

export type FeatureStart =
  | { open: { kind: FeaturePage; view?: string } }
  | { prefill: string }
  | { batch: true };

/** 市场里放哪一组：工作台（大功能有自己的页）、交给小芽（对话里办）、不上市场（只做起头格，如连手机、绑邮箱）。 */
export type FeatureGroup = 'workbench' | 'chat' | 'hidden';

export type FeatureIcon =
  | 'Users' | 'PenLine' | 'FileText' | 'Scale' | 'BarChart3' | 'Building2' | 'Layers' | 'Send' | 'Target'
  | 'Mail' | 'MessageSquareQuote' | 'Mic' | 'Crosshair' | 'History' | 'Compass' | 'Smartphone' | 'Inbox'
  | 'NotebookPen' | 'ClipboardList' | 'MessagesSquare';

export const FEATURE_IDS = [
  'interview', 'exam_search', 'resume_editor', 'offer', 'funnel', 'company_research',
  'batch', 'live', 'job_evaluate', 'mail_compose', 'open_q', 'self_intro', 'interview_predict', 'interview_retro', 'direction_explore',
  'exam_practice', 'interview_prep', 'interview_probe', 'mail_bind', 'phone_link',
] as const;

export type FeatureId = typeof FEATURE_IDS[number];

export interface CareerFeature {
  id: FeatureId;
  /** 市场上的名字。 */
  name: string;
  /** 市场上的一句说明。 */
  what: string;
  icon: FeatureIcon;
  group: FeatureGroup;
  start: FeatureStart;
  /** 下一步条上的起头格（≤22 字，第一人称；可含 `{company}`）。 */
  chip: string;
  /** 没有公司可点名时的起头格（chip 含 `{company}` 时必有）。 */
  chipPlain?: string;
  /** 有公司时的预填句（含 `{company}`）；没有公司时用 start.prefill 原句，不做任何替换。 */
  prefillWith?: string;
}

const dossier = (view: string): FeatureStart => ({ open: { kind: 'career-dossier', view } });

export const FEATURES: Readonly<Record<FeatureId, CareerFeature>> = {
  interview: { id: 'interview', name: '面试助力', what: '记录、模拟面试、深挖点、题库刷题', icon: 'Users', group: 'workbench', start: dossier('interview'), chip: '打开面试助力' },
  exam_search: { id: 'exam_search', name: '笔试助力', what: '截图出答案，先查这家往年题', icon: 'PenLine', group: 'workbench', start: dossier('exam-search'), chip: '考试时截图给你搜题' },
  resume_editor: { id: 'resume_editor', name: '简历编辑', what: '看成品，说一句就改', icon: 'FileText', group: 'workbench', start: { open: { kind: 'career-material', view: 'resume' } }, chip: '这份简历我想自己改一处' },
  offer: { id: 'offer', name: 'Offer 对比', what: '薪资、城市、成长比一比', icon: 'Scale', group: 'workbench', start: dossier('offer'), chip: '两家 Offer 列出来比' },
  funnel: { id: 'funnel', name: '求职漏斗与复盘', what: '投了多少、回了多少、卡在哪一环', icon: 'BarChart3', group: 'workbench', start: { open: { kind: 'career-review', view: 'funnel' } }, chip: '看我这个月的数' },
  company_research: { id: 'company_research', name: '公司调研与方向', what: '这家靠不靠谱、还有哪些方向', icon: 'Building2', group: 'workbench', start: { open: { kind: 'career-review', view: 'research' } }, chip: '先看{company}靠谱吗', chipPlain: '查一家公司靠不靠谱' },
  batch: { id: 'batch', name: '批量投递', what: '按你的方向挑一批投出', icon: 'Layers', group: 'chat', start: { batch: true }, chip: '再投一批' },
  live: { id: 'live', name: '网申进展', what: '每家投到哪一步了', icon: 'Send', group: 'chat', start: { open: { kind: 'career-live' } }, chip: '看正在投的几家' },
  job_evaluate: { id: 'job_evaluate', name: '岗位评估', what: '贴 JD，看值不值得投', icon: 'Target', group: 'chat', start: { prefill: '帮我评估这个岗位，JD 是：' }, chip: '丢个岗位给你看值不值得投' },
  mail_compose: { id: 'mail_compose', name: '投递邮件', what: '起草邮件，附上简历', icon: 'Mail', group: 'chat', start: { prefill: '帮我给这个岗位写投递邮件，附上简历 PDF' }, chip: '给{company}写封投递邮件', chipPlain: '给这家写封投递邮件' },
  open_q: { id: 'open_q', name: '开放题答案', what: '「为什么选我们」按公司写', icon: 'MessageSquareQuote', group: 'chat', start: { prefill: '帮我写「为什么选择我们」，300 字，给这家公司：' }, prefillWith: '帮我写「为什么选择我们」，300 字，给{company}', chip: '「为什么选我们」先写一版' },
  self_intro: { id: 'self_intro', name: '自我介绍', what: '一分钟、三分钟两版', icon: 'Mic', group: 'chat', start: { prefill: '给我一分钟和三分钟两个版本的自我介绍' }, chip: '一分钟自我介绍先备一版' },
  interview_predict: { id: 'interview_predict', name: '预测追问', what: '这家会深挖简历哪几处', icon: 'Crosshair', group: 'chat', start: { prefill: '预测一下这家公司会深挖我简历哪里：' }, prefillWith: '预测一下{company}会深挖我简历哪里', chip: '{company}会深挖我简历哪里', chipPlain: '这家会深挖我简历哪里' },
  interview_retro: { id: 'interview_retro', name: '面后复盘', what: '说说刚才的面试，下一轮不踩坑', icon: 'History', group: 'chat', start: { prefill: '帮我复盘刚才的面试：' }, prefillWith: '帮我复盘刚才{company}的面试：', chip: '面完我来复盘' },
  direction_explore: { id: 'direction_explore', name: '方向探索', what: '按经历和反馈找方向', icon: 'Compass', group: 'chat', start: { prefill: '帮我看看还有哪些方向适合我' }, chip: '看看还有哪些方向适合我' },
  exam_practice: { id: 'exam_practice', name: '笔试练习', what: '按公司挑几道往年题先练手', icon: 'NotebookPen', group: 'hidden', start: { prefill: '先给我出几道笔试题练练，公司是：' }, prefillWith: '先给我出几道{company}的笔试题练练', chip: '先练几道{company}的题', chipPlain: '先练几道笔试题' },
  interview_prep: { id: 'interview_prep', name: '面试准备', what: '按这场面试备好自我介绍、深挖点和要问的问题', icon: 'ClipboardList', group: 'hidden', start: { prefill: '帮我准备这场面试，公司是：' }, prefillWith: '帮我准备{company}这场面试', chip: '帮我准备{company}这场面试', chipPlain: '帮我准备这场面试' },
  interview_probe: { id: 'interview_probe', name: '模拟面试', what: '按这家的风格来一遍，问完给你复盘', icon: 'MessagesSquare', group: 'hidden', start: { prefill: '来一遍模拟面试，公司是：' }, prefillWith: '按{company}的风格来一遍模拟面试', chip: '来一遍{company}的模拟面试', chipPlain: '来一遍模拟面试' },
  mail_bind: { id: 'mail_bind', name: '绑定邮箱', what: '面试邀请、笔试和拒信自动进来', icon: 'Inbox', group: 'hidden', start: { open: { kind: 'career-vault' } }, chip: '手投过的从邮箱接过来' },
  phone_link: { id: 'phone_link', name: '连手机', what: '自动收验证码，不用盯着手机', icon: 'Smartphone', group: 'hidden', start: { open: { kind: 'career-vault' } }, chip: '连上手机自动收验证码' },
};

/** 市场里的"点子"：一句话 + 一个按钮，按钮走某个功能的起头（或自带一句预填）。 */
export interface FeatureIdea { text: string; button: string; start: FeatureStart }

export const FEATURE_IDEAS: readonly FeatureIdea[] = [
  { text: '口述一段实习或项目，写进简历', button: '口述一段', start: { prefill: '我先口述一段实习，帮我整理进简历：' } },
  { text: '绑定邮箱，面试邀请、笔试和拒信自动进来', button: '去绑定', start: FEATURES.mail_bind.start },
  { text: '两周没动静的投递，挑出可以关掉的', button: '挑一挑', start: { prefill: '帮我看看哪些投递很久没动静了，哪些可以关掉' } },
  { text: '明天面试：这家投的哪版简历、说过什么', button: '摊开卷宗', start: { prefill: '我明天面试，摊开这家公司的卷宗：' } },
];

/** 市场某一组的功能，按 FEATURE_IDS 顺序。 */
export function featuresInGroup(group: FeatureGroup): CareerFeature[] {
  return FEATURE_IDS.map(id => FEATURES[id]).filter(f => f.group === group);
}

export function isFeatureId(v: unknown): v is FeatureId {
  return FEATURE_IDS.some(id => id === v);
}

/**
 * 模型常写错的功能 id（真跑日志 11-05：explore / resume_build / resume_review）→ 清单里的 id。
 * 只收"一看就知道指哪个"的近似说法；指不出的不猜。
 */
const FEATURE_ALIASES: Readonly<Record<string, FeatureId>> = {
  explore: 'direction_explore', direction: 'direction_explore', career_explore: 'direction_explore',
  resume: 'resume_editor', resume_edit: 'resume_editor', resume_build: 'resume_editor', resume_review: 'resume_editor',
  resume_draft: 'resume_editor', research: 'company_research', company: 'company_research',
  exam: 'exam_search', interview_mock: 'interview_probe', mock_interview: 'interview_probe', retro: 'interview_retro',
  mail: 'mail_bind', email: 'mail_bind', phone: 'phone_link', apply: 'batch', batch_apply: 'batch',
};

/** 按名字模糊对时至少几个字：一个字（"面"）会对上一串功能。 */
const FEATURE_NAME_MIN = 2;

/** 模型写的功能 id / 名字 → 清单里的 id：原样 → 别名表 → 市场名字（含或被含）；都不中 null。 */
export function featureIdFrom(raw: string): FeatureId | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (isFeatureId(key)) return key;
  if (FEATURE_ALIASES[key]) return FEATURE_ALIASES[key];
  const name = raw.trim();
  return FEATURE_IDS.find(id => FEATURES[id].name === name)
    ?? (name.length >= FEATURE_NAME_MIN ? FEATURE_IDS.find(id => name.includes(FEATURES[id].name) || FEATURES[id].name.includes(name)) : undefined)
    ?? null;
}

/** 提示词用：全部功能 id=名字，一行。 */
export function featureCatalogLine(): string {
  return FEATURE_IDS.map(id => `${id}=${FEATURES[id].name}`).join(' ');
}

const COMPANY_TOKEN = '{company}';

/** 起头时真正要做的事：有公司且有 prefillWith 时换进公司名，否则原样（市场里的原句）。 */
export function resolveFeatureStart(id: FeatureId, args?: { company?: string }): FeatureStart {
  const f = FEATURES[id];
  const company = args?.company?.trim();
  if (!company || !f.prefillWith) return f.start;
  return { prefill: f.prefillWith.split(COMPANY_TOKEN).join(company) };
}

/** 起头格的文字：有公司用 chip，没有公司用 chipPlain（chip 不含 `{company}` 时直接用 chip）。 */
export function featureChipText(id: FeatureId, company?: string | null): string {
  const f = FEATURES[id];
  if (!f.chip.includes(COMPANY_TOKEN)) return f.chip;
  const name = company?.trim();
  return name ? f.chip.split(COMPANY_TOKEN).join(name) : (f.chipPlain ?? f.chip.split(COMPANY_TOKEN).join(''));
}
