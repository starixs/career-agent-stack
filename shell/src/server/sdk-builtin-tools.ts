/**
 * keystone' product-owned Claude Agent SDK builtin catalog.
 *
 * This is deliberately separate from permission policy: exposing a tool to the
 * model does not auto-approve it. Keeping an explicit catalog also prevents a
 * Claude Code patch from silently adding a new builtin with no keystone owner.
 */
export const SDK_BUILTIN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'Agent',
  'Task',
  'TaskStop',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'Monitor',
  'ReportFindings',
  'Workflow',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
] as const;

export const SDK_EXCLUDED_BUILTIN_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'PushNotification',
  'DesignSync',
] as const;

/**
 * 求职助理对话实际交给模型的内置工具（`tools:` 可见边界，权限仍由 canUseTool 等管）。
 *
 * 为什么只留这几个：每个内置工具的英文描述都随每次模型调用重发，全量 29 个约占
 * 每次请求 8–12k token，而求职对话只用到读附件（Read，限工作区内，见 career/tool-guards.ts）、提问卡片、
 * 技能和计划模式的退出（输入框还能切到计划模式，没有 ExitPlanMode 就出不来）。
 * 编码、搜索本机文件（Grep/Glob）、子代理、任务清单、定时、工作树这类通用 Agent 工具不属于本产品。
 */
export const CAREER_SDK_TOOLS = [
  'Read',
  'AskUserQuestion',
  'Skill',
  'ExitPlanMode',
] as const satisfies readonly (typeof SDK_BUILTIN_TOOLS)[number][];
