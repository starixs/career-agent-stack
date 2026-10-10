import { afterEach, describe, expect, it } from 'vitest';

import { setOutputMaskerForTest } from '../career/output-mask';
import { broadcast, createSseClient } from '../sse';

// 界面出口打码：推给渲染层的事件里，私密信息明文不出现；流式片段把一个值拆开也照样打上。

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('SSE output mask', () => {
  afterEach(() => setOutputMaskerForTest(null));

  it('流式片段与普通事件都打码，值被拆在两段里也不漏', async () => {
    setOutputMaskerForTest(['13812345678', '张三']);
    const { client, response } = createSseClient(() => { /* noop */ });
    const reader = response.body!.getReader();
    await new Promise<void>(r => setImmediate(r));

    broadcast('chat:message-chunk', '我是张');
    await new Promise(r => setTimeout(r, 60)); // 让第一段按定时刷出（会扣下"张"）
    broadcast('chat:message-chunk', '三，电话 138');
    await new Promise(r => setTimeout(r, 60));
    broadcast('chat:message-chunk', '12345678。');
    broadcast('chat:tool-result-complete', { toolUseId: 't1', content: '简历里的电话：13812345678' });

    client.close();
    const raw = await drain(reader);
    expect(raw).not.toContain('13812345678');
    expect(raw).not.toContain('张三');
    expect(raw).not.toMatch(/12345678/);
    const text = [...raw.matchAll(/^event: chat:message-chunk\ndata: (.*)$/gm)].map(m => m[1]).join(''); // 字符串数据原样写进 data 行
    expect(text).toBe('我是张*，电话 138****5678。');
    expect(raw).toContain('138****5678');
  });
});
