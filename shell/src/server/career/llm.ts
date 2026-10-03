/**
 * ShellLLM：用壳自身已解析的 provider（默认内置 `career-llm`）实现 @career/core 的 `LLM` 接口。
 *
 * 直连 Anthropic Messages API（`${baseUrl}/v1/messages`，`anthropic-version: 2023-06-01`），
 * 内置模型为 DeepSeek 的 Anthropic 兼容入口 `https://api.deepseek.com/anthropic`；
 * 只用 fetch，不依赖任何模型 SDK，也不经 OpenAI 翻译桥。
 * `json: true` 时在 system 末尾追加"只输出 JSON"的指令（不依赖 response_format），
 * 调用方仍应用 `extractJson` 容错解析。
 */
import type { LLM, LlmRequest, LlmResponse } from '@career/core';
import { CAREER_LLM_PROVIDER_ID } from '../../shared/career-build-constants';
import { resolveProviderEnv, loadConfig, type ResolvedProviderEnv } from '../utils/admin-config';

export const ANTHROPIC_VERSION = '2023-06-01';

/** `json: true` 时追加到 system 末尾的指令。 */
export const JSON_ONLY_INSTRUCTION = '只输出一个合法的 JSON（对象或数组），不要 Markdown 代码块、解释或任何其他文字。';

export interface ShellLlmOptions {
  /** 覆盖 provider（默认 config.defaultProviderId → career-llm）。 */
  providerId?: string;
  /** 覆盖模型名（默认 provider 的 sonnet 别名 / primaryModel）。 */
  model?: string;
  /** 测试注入：解析 provider env。 */
  resolveEnv?: (providerId: string) => ResolvedProviderEnv | undefined;
  /** 测试注入：fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  defaultMaxTokens?: number;
}

/** Anthropic Messages API 响应中本实现用到的字段。 */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { type?: string; message?: string } | string;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class ShellLLM implements LLM {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveEnv: (providerId: string) => ResolvedProviderEnv | undefined;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;

  constructor(private readonly options: ShellLlmOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.resolveEnv = options.resolveEnv ?? ((id) => resolveProviderEnv(id));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    // 技能产出（简历 JSON、调研报告）常超过 4K；8K 是 DeepSeek / 主流第三方端点都接受的上限
    this.defaultMaxTokens = options.defaultMaxTokens ?? 8192;
  }

  /** 解析当前可用的 provider；不可用时抛 LlmUnavailableError（中文说明）。 */
  resolve(): { env: ResolvedProviderEnv; model: string; baseUrl: string } {
    const providerId = this.options.providerId ?? defaultProviderId();
    let env = this.resolveEnv(providerId);
    if (!env && providerId !== CAREER_LLM_PROVIDER_ID) env = this.resolveEnv(CAREER_LLM_PROVIDER_ID);
    if (!env) {
      throw new LlmUnavailableError('内置模型还没有 API Key：请在「设置 → 通用 → 求职助理：模型与搜索」或对话里的「配置模型 Key」卡片填写');
    }
    if (env.apiProtocol && env.apiProtocol !== 'anthropic') {
      throw new LlmUnavailableError(`求职助理只支持 Anthropic Messages 协议，当前 provider（${env.providerId ?? providerId}）协议为 ${env.apiProtocol}`);
    }
    if (env.credentialSource || env.endpointSource) {
      throw new LlmUnavailableError(`求职助理不支持托管订阅 provider（${env.providerId ?? providerId}）`);
    }
    const baseUrl = (env.baseUrl ?? '').replace(/\/+$/, '');
    if (!baseUrl) throw new LlmUnavailableError('模型 baseUrl 为空');
    if (!env.apiKey?.trim()) throw new LlmUnavailableError('模型 API Key 为空：请在「设置 → 通用 → 求职助理：模型与搜索」填写');
    const model = this.options.model ?? env.modelAliases?.sonnet ?? env.modelAliases?.opus ?? env.modelAliases?.haiku;
    if (!model) throw new LlmUnavailableError('无法确定模型名');
    return { env, model, baseUrl };
  }

  /** 模型名含 flash / vision / vl / seed / glm-5.3-flash 之类视觉标记即视为支持图片；可用 CAREER_LLM_VISION=1/0 强制。 */
  supportsImages(): boolean {
    const forced = process.env.CAREER_LLM_VISION?.trim();
    if (forced === '1' || forced === 'true') return true;
    if (forced === '0' || forced === 'false') return false;
    try { return /flash|vision|-vl|vl-|seed|omni/i.test(this.resolve().model); } catch { return false; }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { env, model, baseUrl } = this.resolve();

    const systemParts: string[] = [];
    if (req.system?.trim()) systemParts.push(req.system);
    if (req.json) systemParts.push(JSON_ONLY_INSTRUCTION);
    const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    const hasImages = req.messages.some(m => m.images?.length);
    if (hasImages && !this.supportsImages()) throw new Error(`当前模型（${model}）不支持图片输入`);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? env.maxOutputTokens ?? this.defaultMaxTokens,
      // 有图片时用 Anthropic 内容块；纯文本仍用字符串（与现有单测 / 录制保持一致）
      messages: req.messages.map(m => (m.images?.length
        ? { role: m.role, content: [...m.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })), { type: 'text', text: m.content }] }
        : { role: m.role, content: m.content })),
    };
    if (system) body.system = system;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    // 混合推理模型（DeepSeek V4 等）不传 thinking 时默认开启思考：思考吃光 max_tokens 后只剩 thinking 块，
    // text 为空 → 工具报"模型回复中没有 JSON"。主对话对非 Claude 模型也是显式关闭（agent-session thinkingConfig）。
    if (!isClaudeModel(model)) body.thinking = { type: 'disabled' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: buildHeaders(env),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const reason = error instanceof Error && error.name === 'AbortError' ? '请求超时' : (error instanceof Error ? error.message : String(error));
      throw new Error(`模型请求失败：${reason}`);
    }
    clearTimeout(timer);

    const text = await response.text();
    let parsed: MessagesResponse | undefined;
    try {
      parsed = JSON.parse(text) as MessagesResponse;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
      throw new Error(`模型返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    if (!parsed) throw new Error('模型返回了非 JSON 响应');
    const outText = Array.isArray(parsed.content)
      ? parsed.content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('')
      : '';
    if (!outText.trim()) {
      const kinds = Array.isArray(parsed.content) ? [...new Set(parsed.content.map(b => b?.type ?? '?'))].join(',') : 'none';
      throw new Error(parsed.stop_reason === 'max_tokens'
        ? `模型输出被截断（只返回了 ${kinds}，没有正文）：请重试或换用更大输出上限的模型`
        : `模型没有返回正文（stop_reason=${parsed.stop_reason ?? '未知'}，内容块：${kinds}）`);
    }
    return {
      text: outText,
      usage: {
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
      },
    };
  }
}

/**
 * 鉴权头按 provider 的 authType 选择：`auth_token*` → `Authorization: Bearer`（DeepSeek /
 * 第三方网关常见），`api_key` → `x-api-key`，`both` 两者都带。
 */
function buildHeaders(env: ResolvedProviderEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const key = env.apiKey ?? '';
  const authType = env.authType ?? 'both';
  if (authType === 'api_key' || authType === 'both') headers['x-api-key'] = key;
  if (authType !== 'api_key') headers.Authorization = `Bearer ${key}`;
  return headers;
}

function defaultProviderId(): string {
  try {
    const id = (loadConfig() as { defaultProviderId?: string }).defaultProviderId;
    return typeof id === 'string' && id.trim() ? id.trim() : CAREER_LLM_PROVIDER_ID;
  } catch {
    return CAREER_LLM_PROVIDER_ID;
  }
}

let shared: ShellLLM | null = null;

/** 进程级共享实例（工具与路由共用）。 */
export function getShellLLM(): ShellLLM {
  if (!shared) shared = new ShellLLM();
  return shared;
}

export function setShellLLM(llm: ShellLLM | null): void {
  shared = llm;
}

/** 与 agent-session 的判定一致：只有 Claude 系模型才保留思考；第三方混合推理模型一律关闭。 */
export function isClaudeModel(model: string): boolean {
  const m = model.toLowerCase();
  return /claude|sonnet-[45]|opus-[45]|fable-5|mythos-5|haiku-4/.test(m);
}
