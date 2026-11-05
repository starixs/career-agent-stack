/**
 * SDK hook 入口（agent-session 只挂这里的函数）：UserPromptSubmit 注入附件文字、低谷开场。
 * 依赖惰性加载；任何失败都只记日志并放行，附件和开场都不能挡住对话。
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

/** 低谷开场：连收拒信后他第一次说话时，让助理开头说一句带基数的话（见 low-point.ts）。 */
export async function careerLowPointPromptHook(_input: HookInput): Promise<HookJSONOutput> {
  try {
    const [{ getRepos }, { lowPointOpener }] = await Promise.all([import('./db'), import('./low-point')]);
    const context = lowPointOpener(await getRepos(), new Date().toISOString());
    if (!context) return {};
    console.log('[career-low-point] opener injected');
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  } catch (error) {
    console.warn('[career-low-point] 开场判断失败（放行）：', error instanceof Error ? error.message : error);
    return {};
  }
}

/** 主线进度一行：每轮给模型当前进度，省掉开场摸底和反问（见 mainline-state.ts）。 */
export async function careerMainlineStateHook(_input: HookInput): Promise<HookJSONOutput> {
  try {
    const [{ getRepos }, { formatMainlineState, readMainlineFacts }] = await Promise.all([import('./db'), import('./mainline-state')]);
    const context = formatMainlineState(readMainlineFacts(await getRepos(), new Date().toISOString()));
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  } catch (error) {
    console.warn('[career-mainline] 进度读取失败（放行）：', error instanceof Error ? error.message : error);
    return {};
  }
}
