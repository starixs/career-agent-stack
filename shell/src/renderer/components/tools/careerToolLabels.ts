/**
 * 求职助理（career MCP）工具在对话工具行里的中文动作短语。
 * 工具行既在运行中也在完成后显示，所以用不带时态的动作（"看今天的待办"），不写"正在 / 已"。
 */
const CAREER_TOOL_PREFIX = 'mcp__career__';

export const CAREER_TOOL_LABELS: Record<string, string> = {
  account_fetch_report: '记下账号抓取结果',
  application_set_stage: '更新投递进度',
  application_correct: '更正投递进度',
  apply_auto_mode: '查看自动投递设置',
  apply_batch: '安排批量投递',
  apply_continue: '接着填网申',
  web_fetch: '读网页',
  browser_wait_user: '等你帮一下',
  browser_solve_captcha: '过验证码',
  browser_open: '打开网页',
  browser_observe: '看一眼网页',
  browser_act: '在网页上操作',
  experience_remove: '删掉一段经历',
  claim_remove: '删掉一条说法',
  browser_cdp: '在网页上操作',
  browser_sop: '想想网页怎么操作',
  browser_read: '读网页内容',
  browser_capture_job: '收录这个岗位',
  apply_prepare: '准备材料并开始填网申',
  apply_run: '打开网申页填表',
  learned_rules: '看我替你记下的规则',
  career_overview: '看求职全局',
  claim_confirm: '记下你确认的经历',
  company_research: '查公司信息',
  deadline_add: '记一个截止时间',
  deadline_done: '把截止事项划掉',
  deadline_list: '看截止时间',
  deadline_update: '改截止时间',
  direction_explore: '看看可选方向',
  dossier_get: '翻公司档案',
  dossier_list: '看档案列表',
  dossier_note_add: '往档案里记一笔',
  exam_practice: '笔试练习',
  experience_add: '记下一段经历',
  experience_interview: '聊聊你的经历',
  experience_list: '翻经历库',
  gap_plan: '对照岗位找差距',
  greeting_compose: '写打招呼的话',
  inbox_capture: '归档收到的消息',
  inbox_correct: '更正读错的消息',
  inbox_dismiss: '收起一条消息',
  inbox_list: '看收件箱',
  ingest_document: '读你给的文档',
  ingest_repo: '看你的代码仓库',
  interview_book: '记一场面试',
  interview_predict: '预测面试追问',
  interview_prep: '准备这场面试',
  interview_probe: '模拟面试追问',
  interview_project_story: '理项目故事',
  interview_questions: '准备面试题',
  interview_retro: '面试复盘',
  jd_parse: '读岗位要求',
  job_evaluate: '评估这个岗位',
  job_import: '收下岗位',
  job_prefs: '看求职条件',
  job_target: '标为目标岗位',
  jobs_board: '查岗位库',
  jobs_apply: '开始批量投',
  jobs_sync: '同步岗位库',
  mail_accounts: '看绑定的邮箱',
  mail_compose: '写投递邮件',
  mail_list: '看邮件',
  mail_sync: '收邮件',
  material_draft: '起草材料',
  material_list: '翻材料库',
  material_save: '存下材料',
  material_use_record: '记下说过的话',
  offer_compare: '比较 offer',
  offer_list: '查看 offer',
  offer_save: '记录 offer',
  question_add: '把题收进题库',
  question_attempt: '记下这次作答',
  question_bank: '翻题库',
  resume_ats: '做机筛自检',
  resume_export: '导出简历',
  resume_get: '读简历',
  resume_list: '看简历列表',
  resume_master_create: '起草主简历',
  resume_save: '存简历',
  resume_tailor: '对照岗位改简历',
  review_queue: '看待你批准的事',
  today_queue: '看今天的待办',
  ui_open: '打开页面',
  vault_status: '看私密信息库',
  web_search: '上网搜一下',
  month_review: '打开我的求职月',
};

/** career 工具返回中文动作短语；不是 career 工具返回 null。没登记的工具去掉前缀、下划线换空格。 */
export function getCareerToolLabel(toolName: string): string | null {
  if (!toolName.startsWith(CAREER_TOOL_PREFIX)) return null;
  const action = toolName.slice(CAREER_TOOL_PREFIX.length);
  return CAREER_TOOL_LABELS[action] ?? action.replace(/_/g, ' ');
}

/** 主线之外的能力收进了 more_actions 一个入口（server/tools/career-tool-router.ts）；前端按里面真正调用的那个工具来认。 */
const MORE_ACTIONS_TOOL = `${CAREER_TOOL_PREFIX}more_actions`;

function parseInput(raw: unknown, json: string | undefined): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    // 输入还在流式传来、JSON 不完整：先按外层工具认，传完再认里面那个
    return null;
  }
}

/** more_actions(name, args) → 当作 mcp__career__<name>(args) 看待；其他工具原样返回。 */
export function unwrapCareerTool<T extends { name: string; parsedInput?: unknown; inputJson?: string }>(tool: T): T {
  if (tool.name !== MORE_ACTIONS_TOOL) return tool;
  const input = parseInput(tool.parsedInput, tool.inputJson);
  const inner = input?.name;
  if (typeof inner !== 'string' || !inner) return tool;
  const args = input?.args && typeof input.args === 'object' ? input.args : {};
  return { ...tool, name: `${CAREER_TOOL_PREFIX}${inner}`, parsedInput: args, inputJson: JSON.stringify(args) };
}
