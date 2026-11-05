/**
 * 小芽只背主线要用的工具（主线体验 §6.4 / face-pipeline 第 4 件，11-02 定）。
 *
 * 一次对话里挂着七十多个工具，每一轮都要读一遍它们的说明，DeepSeek 的注意力被稀释，
 * 说话也跟着散。主线（建档 → 方向 → 定制 → 投出 → 等你）用到的工具直接挂着；
 * 面试、笔试、Offer、邮件、调研这些主线之外的能力收进 more_actions 一个入口：
 * 说明里只列名字和一句话，用到时把 name 和 args 交给它，参数照原工具的 schema 校验后转给原工具。
 * 能力一个没少，只是不再每轮都背着。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type ZodModule = typeof import('zod/v4').z;
interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<CallToolResult> }

/** 主线常驻的工具。改这里就是改小芽每轮背着什么。 */
export const XIAOYA_TOOLS: ReadonlySet<string> = new Set([
  // 建档
  'resume_import', 'experience_interview', 'experience_add', 'experience_list', 'claim_confirm', 'vault_status',
  // 简历与方向
  'resume_list', 'resume_get', 'resume_master_create', 'resume_tailor', 'job_prefs',
  // 岗位与投出
  'jobs_board', 'jobs_propose', 'jobs_apply', 'apply_continue', 'review_queue',
  // 邮件投递（实习是主线：很多实习岗只收邮件）
  'mail_compose',
  // 回来、看全局、打开页面
  'today_queue', 'dossier_get', 'ui_open',
  // 读外面的东西
  'web_search', 'web_fetch',
]);

/**
 * 在对话这一轮里直接开浏览器填表的老入口：会把对话卡住几十秒（违背「启动就回」），也会让小芽多开一家没被要求的投递
 * （2026-11-02 实例 A：「先投一家看看」被投成两家）。投递一律走 jobs_apply 交后台；这几个不再给小芽。
 */
export const IN_TURN_APPLY_TOOLS: ReadonlySet<string> = new Set(['apply_prepare', 'apply_run', 'apply_batch']);

export const MORE_ACTIONS_TOOL = 'more_actions';
/** 目录里每个能力的说明截到多长：够认出是干什么的就行，细节在原工具说明里。 */
const CATALOG_SUMMARY_CHARS = 48;

function summary(description: string | undefined): string {
  const first = (description ?? '').split(/[。；\n]/)[0] ?? description;
  return first.length > CATALOG_SUMMARY_CHARS ? `${first.slice(0, CATALOG_SUMMARY_CHARS)}…` : first;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 把全部工具分成「小芽常驻」和「more_actions 里的」，返回挂到 MCP server 上的那一组。 */
export function routeCareerTools<T extends ToolDef>(all: T[], tool: (name: string, description: string, schema: Record<string, unknown>, handler: (args: { name: string; args?: Record<string, unknown> }, extra: unknown) => Promise<CallToolResult>) => T, z: ZodModule): T[] {
  const resident = all.filter(t => XIAOYA_TOOLS.has(t.name));
  const others = new Map(all.filter(t => !XIAOYA_TOOLS.has(t.name) && !IN_TURN_APPLY_TOOLS.has(t.name)).map(t => [t.name, t]));
  if (!others.size) return resident;
  const catalog = [...others.values()].map(t => `- ${t.name}：${summary(t.description)}`).join('\n');
  const more = tool(
    MORE_ACTIONS_TOOL,
    `主线之外的能力（面试、笔试、Offer、邮件、截止、卷宗、调研、浏览器等）。用户要这些时调用：name 选下面一个，args 按那个能力要的参数传；参数不对会返回它要的字段。\n${catalog}`,
    { name: z.enum([...others.keys()] as [string, ...string[]]), args: z.record(z.string(), z.unknown()).optional() },
    async ({ name, args }, extra) => {
      const target = others.get(name);
      if (!target) return errorResult(`没有这个能力：${name}`);
      const parsed = z.object(target.inputSchema as Parameters<ZodModule['object']>[0]).safeParse(args ?? {});
      if (!parsed.success) return errorResult(`${name} 的参数不对：${parsed.error.message}\n它要的说明：${target.description}`);
      return target.handler(parsed.data as never, extra);
    },
  );
  return [...resident, more];
}
