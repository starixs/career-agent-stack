/**
 * 哪些求职技能列给对话模型。
 *
 * 下面这些技能只由工具在后台用 `askSkill` / 系统提示词直接读取 app/skills 原件，
 * 是工具内部的一次独立模型调用。再把它们列给对话模型有两份代价：
 *   1. 技能清单每次模型调用都重发；
 *   2. 模型会调 Skill 把 1–1.5k 字的正文拉进上下文，和工具重复干一遍活。
 * 所以从 SDK 的 `skills` 白名单里拿掉（SDK 语义：不在白名单的技能不出现在清单里、Skill 工具也拒绝），
 * 文件仍在磁盘上，工具照常读取。
 *
 * 留给对话模型的是对话里一步步走的做法：apply-playbook、campus-timeline、
 * experience-interview、inbox-triage、interview-retro，以及 anydoc、语音识别。
 */
export const CAREER_TOOL_INTERNAL_SKILLS: readonly string[] = [
  // 系统提示词主体（system-prompt.ts 读它的正文），再列成技能就是重复。
  'assistant-core',
  'company-research',
  'derivatives',
  'direction-explore',
  'gap-plan',
  'greeting',
  'interview-probe',
  'interview-questions',
  'jd-parse',
  'job-evaluate',
  'material-draft',
  'offer-compare',
  'probe-predict',
  'project-story',
  'resume-draft',
  'resume-import',
  'resume-tailor',
];

const INTERNAL = new Set(CAREER_TOOL_INTERNAL_SKILLS);

/** 去掉工具内部技能，其余原样保留（顺序不变，便于提示词前缀稳定、缓存命中）。 */
export function chatVisibleSkills(allowlist: readonly string[]): string[] {
  return allowlist.filter(name => !INTERNAL.has(name));
}
