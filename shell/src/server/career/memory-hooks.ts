/**
 * SDK hook 入口（agent-session 只挂这里的函数）：UserPromptSubmit 注入记忆与附件文字，Stop 排队提炼。
 * 依赖全部惰性加载；任何失败都只记日志并放行，记忆和附件都不能挡住对话。
 */
import type { HookInput, HookJSONOutput, StopHookInput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';

import { getRepos } from './db';
import { extractMemories, onTurnStop, onUserPrompt } from './memory-service';

export async function careerMemoryPromptHook(input: HookInput): Promise<HookJSONOutput> {
  try {
    const context = await onUserPrompt(input as UserPromptSubmitHookInput & { agent_id?: string }, getRepos);
    if (!context) return {};
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  } catch (error) {
    console.warn('[career-memory] 注入记忆失败（放行）：', error instanceof Error ? error.message : error);
    return {};
  }
}

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

export async function careerMemoryStopHook(input: HookInput): Promise<HookJSONOutput> {
  onTurnStop(input as StopHookInput & { agent_id?: string }, async turn => {
    const [{ getVault }, { getShellLLM }, { loadSkillPrompt }, { loadCore }] = await Promise.all([
      import('./vault'), import('./llm'), import('./skills'), import('./core-module'),
    ]);
    const core = await loadCore();
    const result = await extractMemories({
      repos: await getRepos(),
      vault: await getVault().catch(() => null),
      llm: getShellLLM(),
      systemPrompt: () => loadSkillPrompt('memory-extract'),
      extractJson: text => core.extractJson(text),
      log: msg => console.log(`[career-memory] ${msg}`),
    }, turn);
    if (result.written.length || result.forgotten.length) {
      console.log(`[career-memory] 本轮记下 ${result.written.length} 条、忘掉 ${result.forgotten.length} 条（转走 ${result.routed}，丢弃 ${result.dropped}）`);
    }
  });
  return {};
}
