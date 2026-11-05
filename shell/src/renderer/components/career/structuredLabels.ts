/**
 * 技能产出的 JSON（面试复盘、模拟面试报告、公司研究、方向理由、差距计划）在页面上显示时用的中文名。
 * 认得的键换成中文；不认得的英文键不露给用户：对象 / 列表直接略过，单个值归到「其他」。
 * 键名来自 skills/ 下各技能的输出格式（interview-retro / interview-probe / company-research / direction-explore / gap-plan）。
 */
import { INTERVIEW_RESULT_LABELS, INTERVIEW_RESULT_SOURCE_LABELS, TRAFFIC_LIGHT_LABELS } from './careerConstants';

/** 只是内部关联用的键：不显示。 */
const HIDDEN_KEYS = new Set(['id', 'claim_id', 'experience_id', 'company_code', 'meta', 'raw', 'report_md', 'source_level']);

export const STRUCTURED_KEY_LABELS: Record<string, string> = {
  // 面试复盘
  session: '本场信息', company_type: '企业性质', role: '岗位', round: '轮次', interviewer_role_guess: '面试官可能是',
  track: '招聘类型', language: '语言', duration_min: '时长（分钟）', result: '结果', result_source: '结果来源',
  questions: '被问到的题', type: '题型', intent: '考察意图', quote: '原题', content_tags: '内容标签', delivery_tags: '表达标签',
  language_tags: '用词标签', stuck_layer: '卡在第几层', interviewer_doubt: '面试官的疑虑', evidence: '依据', alternative: '其他可能',
  signals: '信号', tag: '标签', fact: '看到的事实', interpretation: '一种解释', focus_this_round: '这一轮的重点',
  next_round_probes: '下一轮可能追问', retakes: '重答一遍', question: '题目', answer: '回答', needs_verification: '还要核实',
  todo: '还要补', facts: '要补的事实', delivery: '表达上要练', claim_followups: '经历补充', new_fact: '新事实', attribution: '是谁做的',
  went_well: '做得好的', improve: '要改进的', strengths: '做得好的', weaknesses: '要改进的', suggestions: '建议',
  gap: '缺口', unobservable: '看不出来的', cross_session: '跨场归纳', enabled: '已开启', note: '备注', tags: '标签',
  // 模拟面试报告
  verdict: '结论', diagnosis: '诊断', claim: '简历里的说法', broke_at_layer: '第几层答不上', issue: '问题', interviewer_thought: '面试官会怎么想',
  red_flags: '容易被怀疑的地方', suspicious: '可疑', inflated: '说大了', scripted: '像背的', reference_answers: '参考回答',
  gaps: '差距', jd_requirement: '岗位要求', real_gap: '确实欠缺', strategy: '怎么应对',
  // 公司研究
  company: '公司', jurisdiction: '地区', summary: '结论速览', points: '分数', light: '红绿灯', reasons: '理由', entity: '主体识别',
  matched: '已对上', recommended: '推荐主体', confidence: '把握', candidates: '候选', name: '名称', score: '得分', sources: '来源',
  business: '工商信息', legal_representative: '法定代表人', legal_rep: '法定代表人', registered_capital: '注册资本', founded: '成立时间',
  legal_name: '公司全称', fields: '其他信息', red_lines: '红线核验', status: '状态', keyword: '关键词', category: '类别', severity: '严重程度',
  hits: '命中次数', strong_hits: '强相关', blocked: '被拦截', reviews: '员工评价', platform: '平台', title: '标题', url: '链接',
  pitfalls: '坑点', risk: '风险', interview_questions: '面试时可以问', manual_checks: '要自己核实的', item: '事项', what_to_check: '核实什么',
  traffic_light: '红绿灯', overview: '概览', finance: '财务', team: '团队', culture: '文化', compensation: '薪酬', hiring: '招聘',
  legal: '法律', news: '新闻', competition: '竞争', growth: '成长',
  // 方向与差距
  reason: '理由', rationale: '理由', why: '为什么', uncertainty: '不确定的地方', uncertainties: '不确定的地方', risks: '风险',
  typical_titles: '典型岗位', fit_reasons: '适合的理由', how_to_validate: '怎么验证', capabilities: '能力', hard: '硬技能', soft: '软技能',
  directions: '方向', questions_for_user: '想问你的', excluded: '排除的', requirement: '要求', what_to_collect: '要补的材料',
  text: '内容', deliverable: '产出', acceptance: '验收标准', est_hours: '预计小时', priority: '优先级', steps: '步骤',
  budget: '时间预算', weekly_hours: '每周小时', total_hours: '总小时', deadline: '截止', fits: '来得及',
};

/** 常见的枚举值：显示成中文。 */
const VALUE_LABELS: Record<string, string> = {
  ...INTERVIEW_RESULT_SOURCE_LABELS, ...INTERVIEW_RESULT_LABELS, ...TRAFFIC_LIGHT_LABELS,
  campus: '校招', social: '社招', intern: '实习', self: '自己', team: '团队', unknown: '不清楚',
  pass: '能过', borderline: '悬', fail: '过不了', hit: '命中', unverified: '未核实', clean: '没问题',
  high: '高', mid: '中', medium: '中', low: '低',
};

/** 键的中文名；认不得的英文键返回 null（不显示键名）。中文键原样用。 */
export function structuredKeyLabel(key: string): string | null {
  if (HIDDEN_KEYS.has(key)) return null;
  return STRUCTURED_KEY_LABELS[key] ?? (/[一-鿿]/.test(key) ? key : null);
}

export function isHiddenKey(key: string): boolean {
  return HIDDEN_KEYS.has(key);
}

/** 单个值的显示文字：枚举换中文，布尔换是 / 否。 */
export function structuredValueText(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return VALUE_LABELS[value] ?? value;
  return String(value);
}

/**
 * 列表里一项的一句话：字符串原样；对象取它的文字值连成一句（跳过内部键和链接）。
 * 什么文字都取不到就返回 null，由调用方略过，不显示原始 JSON。
 */
export function briefText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return structuredValueText(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parts = Object.entries(value)
    .filter(([k, v]) => !HIDDEN_KEYS.has(k) && k !== 'url' && typeof v === 'string' && v.trim())
    .map(([, v]) => structuredValueText(String(v).trim()));
  return parts.length ? parts.join('：') : null;
}
