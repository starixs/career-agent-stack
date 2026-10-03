import { describe, expect, it, vi } from 'vitest';

import { ANTHROPIC_VERSION, JSON_ONLY_INSTRUCTION, LlmUnavailableError, ShellLLM, isClaudeModel } from './llm';

const env = {
  providerId: 'career-llm',
  providerName: '内置求职模型',
  baseUrl: 'https://api.deepseek.com/anthropic/',
  apiKey: 'sk-test',
  authType: 'auth_token' as const,
  modelAliases: { fable: 'deepseek-chat', sonnet: 'deepseek-chat', opus: 'deepseek-chat', haiku: 'deepseek-chat' },
};

function fetchMock(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

function lastCall(fetchImpl: typeof fetch): { url: string; init: RequestInit; headers: Record<string, string>; body: Record<string, unknown> } {
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe('ShellLLM (Anthropic Messages API)', () => {
  it('posts to /v1/messages with Bearer auth + anthropic-version and maps text + usage', async () => {
    const fetchImpl = fetchMock(200, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '{"a":1}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const llm = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl });
    const res = await llm.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], json: true, temperature: 0.2, maxTokens: 99 });
    expect(res).toEqual({ text: '{"a":1}', usage: { input_tokens: 12, output_tokens: 3 } });

    const { url, init, headers, body } = lastCall(fetchImpl);
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-api-key']).toBeUndefined();
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(99);
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    // json: true → system 末尾追加"只输出 JSON"指令，不发 response_format
    expect(body.system).toBe(`sys\n\n${JSON_ONLY_INSTRUCTION}`);
    expect(body.response_format).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it('omits system when none given and json is false; uses provider maxOutputTokens', async () => {
    const fetchImpl = fetchMock(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const llm = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => ({ ...env, maxOutputTokens: 500 }), fetchImpl });
    await llm.complete({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }] });
    const { body } = lastCall(fetchImpl);
    expect(body.system).toBeUndefined();
    expect(body.max_tokens).toBe(500);
    expect(body.messages).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
      { role: 'user', content: 'z' },
    ]);
  });

  it('json: true without a system prompt sends only the JSON instruction as system', async () => {
    const fetchImpl = fetchMock(200, { content: [{ type: 'text', text: '[]' }] });
    const llm = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl });
    await llm.complete({ messages: [{ role: 'user', content: 'x' }], json: true });
    expect(lastCall(fetchImpl).body.system).toBe(JSON_ONLY_INSTRUCTION);
  });

  it('concatenates multiple text blocks, skips non-text blocks, and tolerates missing usage', async () => {
    const fetchImpl = fetchMock(200, {
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'he' },
        { type: 'text', text: 'llo' },
      ],
    });
    const llm = new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm' });
    const res = await llm.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('第三方混合推理模型显式关闭 thinking，默认输出上限 8192；Claude 模型不发 thinking 字段', async () => {
    const fetchImpl = fetchMock(200, { content: [{ type: 'text', text: '{}' }] });
    await new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl }).complete({ messages: [{ role: 'user', content: 'x' }], json: true });
    const { body } = lastCall(fetchImpl);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(8192);

    const claudeFetch = fetchMock(200, { content: [{ type: 'text', text: '{}' }] });
    const claudeEnv = { ...env, modelAliases: { fable: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-sonnet-5-5', haiku: 'claude-sonnet-5-5' } };
    await new ShellLLM({ providerId: 'career-llm', resolveEnv: () => claudeEnv, fetchImpl: claudeFetch }).complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(lastCall(claudeFetch).body.thinking).toBeUndefined();
    expect(isClaudeModel('deepseek-flash')).toBe(false);
    expect(isClaudeModel('claude-opus-5-5')).toBe(true);
  });

  it('只返回 thinking、被 max_tokens 截断时给出明确错误，而不是空字符串', async () => {
    const fetchImpl = fetchMock(200, { content: [{ type: 'thinking', thinking: '……' }], stop_reason: 'max_tokens' });
    const llm = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/截断.*thinking/);
    const empty = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl: fetchMock(200, { content: [], stop_reason: 'end_turn' }) });
    await expect(empty.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/没有返回正文/);
  });

  it('surfaces upstream HTTP errors with status and DeepSeek error.message', async () => {
    const fetchImpl = fetchMock(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
    const llm = new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm' });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/模型返回 HTTP 401：bad key/);
  });

  it('surfaces non-JSON error bodies with the status only', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    const llm = new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm' });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/^模型返回 HTTP 502$/);
  });

  it('rejects a 2xx non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const llm = new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm' });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/非 JSON 响应/);
  });

  it('wraps network failures with a Chinese message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const llm = new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm' });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/模型请求失败：ECONNRESET/);
  });

  it('throws LlmUnavailableError when no provider resolves', async () => {
    const llm = new ShellLLM({ resolveEnv: () => undefined, fetchImpl: fetchMock(200, {}), providerId: 'career-llm' });
    await expect(llm.complete({ messages: [] })).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('falls back to career-llm when the configured provider is unavailable', async () => {
    const resolveEnv = vi.fn((id: string) => (id === 'career-llm' ? env : undefined));
    const llm = new ShellLLM({ providerId: 'deepseek', resolveEnv, fetchImpl: fetchMock(200, { content: [{ type: 'text', text: 'ok' }] }) });
    expect((await llm.complete({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('ok');
    expect(resolveEnv.mock.calls.map(c => c[0])).toEqual(['deepseek', 'career-llm']);
  });

  it('rejects OpenAI-protocol providers (no translation bridge)', async () => {
    const llm = new ShellLLM({ resolveEnv: () => ({ ...env, apiProtocol: 'openai' as const }), fetchImpl: fetchMock(200, {}), providerId: 'x' });
    await expect(llm.complete({ messages: [] })).rejects.toThrow(/只支持 Anthropic Messages 协议/);
  });

  it('accepts an explicit anthropic protocol and picks auth headers by authType', async () => {
    const explicit = fetchMock(200, { content: [{ type: 'text', text: 'ok' }] });
    await new ShellLLM({ resolveEnv: () => ({ ...env, apiProtocol: 'anthropic' as const }), fetchImpl: explicit, providerId: 'x' })
      .complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(lastCall(explicit).headers.Authorization).toBe('Bearer sk-test');

    const apiKey = fetchMock(200, { content: [{ type: 'text', text: 'ok' }] });
    await new ShellLLM({ resolveEnv: () => ({ ...env, authType: 'api_key' as const }), fetchImpl: apiKey, providerId: 'x' })
      .complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(lastCall(apiKey).headers['x-api-key']).toBe('sk-test');
    expect(lastCall(apiKey).headers.Authorization).toBeUndefined();

    const both = fetchMock(200, { content: [{ type: 'text', text: 'ok' }] });
    await new ShellLLM({ resolveEnv: () => ({ ...env, authType: 'both' as const }), fetchImpl: both, providerId: 'x' })
      .complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(lastCall(both).headers['x-api-key']).toBe('sk-test');
    expect(lastCall(both).headers.Authorization).toBe('Bearer sk-test');
  });

  it('honours an explicit model override over provider aliases', async () => {
    const fetchImpl = fetchMock(200, { content: [{ type: 'text', text: 'ok' }] });
    await new ShellLLM({ resolveEnv: () => env, fetchImpl, providerId: 'career-llm', model: 'deepseek-reasoner' })
      .complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(lastCall(fetchImpl).body.model).toBe('deepseek-reasoner');
  });
});
