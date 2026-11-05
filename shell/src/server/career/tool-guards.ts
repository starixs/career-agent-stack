/**
 * 求职对话的两条工具守卫（PreToolUse，纯函数；agent-session 只负责挂上）。
 *
 * 1. Read 只读工作区里的文件。附件转出的文字、图片原图都在工作区里（attachment-reader 的 text_path / path）；
 *    工作区外是本机日志、配置、别的项目——模型读了会对用户说「服务端返回 200、CSP 拦下 WebAssembly」
 *    这类控制台话（10-03 会话实例），既不像学长，也泄露本机内容。
 * 2. 提问卡（AskUserQuestion）一次一个问题、最多三个选项：人群前提是没耐心、不想做选择题；
 *    一次三问的诊断问卷（10-10 实例）就是新的劳动。超了退回给模型重组，不打扰用户。
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** 一张提问卡最多几个问题 / 几个选项（人群：没耐心，选项多了就不选）。 */
export const ASK_MAX_QUESTIONS = 1;
export const ASK_MAX_OPTIONS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 路径存在就取真实路径，不存在（或无权限）就按字面解析；Read 读不存在的文件会自己报错。 */
function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Read 的目标在工作区外时返回拒绝原因；其余（含不是 Read、没有路径）返回 null。 */
export function readScopeDenial(toolName: string, toolInput: unknown, workspace: string | undefined): string | null {
  if (toolName !== 'Read' || !workspace || !isRecord(toolInput)) return null;
  const target = toolInput.file_path;
  if (typeof target !== 'string' || target.trim() === '') return null;
  // 两边都取真实路径：工作区可能经软链（iCloud、外接盘、自定目录）进来，CLI 给的 cwd 是物理路径
  const rel = relative(realOrResolved(workspace), realOrResolved(resolve(workspace, target)));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return null;
  return '只能读这次对话工作区里的文件（附件转出的文字、图片原图都在这里）。工作区外的本机文件不要读，也不要向用户提日志、接口这类内部细节。';
}

/** 提问卡超出「一问、三选」时返回给模型的重组要求；合规返回 null。 */
export function askShapeDenial(toolName: string, toolInput: unknown): string | null {
  if (toolName !== 'AskUserQuestion' || !isRecord(toolInput)) return null;
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  if (questions.length > ASK_MAX_QUESTIONS) {
    return `一次只问一件事：把这 ${questions.length} 个问题里最要紧的一个留下，其余你先按最常见的情况自己定，后面需要再问。`;
  }
  const options = isRecord(questions[0]) && Array.isArray(questions[0].options) ? questions[0].options : [];
  if (options.length > ASK_MAX_OPTIONS) {
    return `选项最多 ${ASK_MAX_OPTIONS} 个：留下最可能的几个，把你最推荐的放第一个。`;
  }
  return null;
}
