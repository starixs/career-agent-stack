/**
 * SDK hook 入口（agent-session 只挂这里的函数）：UserPromptSubmit 注入附件文字。
 * 依赖惰性加载；任何失败都只记日志并放行，附件不能挡住对话。
 */
import type { HookInput, HookJSONOutput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';

/** 附件读取：本轮消息引用的 PDF / Word / 表格 / 图片在本地转成文字注入（见 attachment-reader.ts）。 */
export async function careerAttachmentPromptHook(input: HookInput): Promise<HookJSONOutput> {
  const { prompt, cwd } = input as UserPromptSubmitHookInput;
  if (!prompt || !cwd || !prompt.includes('@')) return {};
  try {
    const { buildAttachmentContext, defaultConvertDeps } = await import('./attachment-reader');
    const context = await buildAttachmentContext(prompt, cwd, defaultConvertDeps(cwd));
    if (!context) return {};
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  } catch (error) {
    console.warn('[career-attach] 读取附件失败（放行）：', error instanceof Error ? error.message : error);
    return {};
  }
}
