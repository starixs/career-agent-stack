import { FakeLLM } from '@career/core';
import { describe, expect, it } from 'vitest';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute } from './career';

const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });
const get = (path: string) => new Request(`http://localhost${path}`);

async function call(request: Request, deps: Parameters<typeof handleCareerRoute>[2]) {
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error('路由没有接住');
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('/api/career/exam-search', () => {
  it('粘贴文字 → 识别 → 作答 → 出现在历史里', async () => {
    const repos = createMemoryRepos();
    const llm = new FakeLLM([
      JSON.stringify({ questions: [{ stem: '数列 2, 4, 8, ? 下一项是', options: [], qtype: 'fill' }] }),
      JSON.stringify({ answers: [{ index: 0, answer: '16', explanation: '每项乘 2', confidence: 'high' }] }),
    ]);
    const deps = { repos, llm, broadcast: () => {} };
    const recognized = await call(post('/api/career/exam-search/recognize', { text: '数列 2, 4, 8, ?' }), deps);
    expect(recognized.status).toBe(200);
    const id = (recognized.body.search as { id: string }).id;
    const answered = await call(post(`/api/career/exam-search/${id}/answer`, {}), deps);
    expect(answered.body.search).toMatchObject({ status: 'answered', answers: [{ answer: '16', source: 'model' }] });
    const history = await call(get('/api/career/exam-search/history'), deps);
    expect((history.body.searches as unknown[]).length).toBe(1);
  });

  it('既没截图也没文字、截图格式不对都直接拒绝，不调模型', async () => {
    const llm = new FakeLLM();
    const deps = { repos: createMemoryRepos(), llm, broadcast: () => {} };
    expect((await call(post('/api/career/exam-search/recognize', {}), deps)).status).toBe(400);
    expect((await call(post('/api/career/exam-search/recognize', { image: { data: 'xx', mediaType: 'image/gif' } }), deps)).status).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });

  it('上传 JSON 题库在后台导入，完成后广播变更', async () => {
    const repos = createMemoryRepos();
    const events: string[] = [];
    const done = new Promise<void>(resolve => { events.push('waiting'); setTimeout(resolve, 50); });
    const deps = { repos, llm: new FakeLLM(), broadcast: (event: string) => { events.push(event); } };
    const data = Buffer.from(JSON.stringify({ items: [{ stem: '用户旅程地图主要用来做什么', answer: '梳理体验触点' }] })).toString('base64');
    const created = await call(post('/api/career/exam-search/banks', { file_name: '网易设计.json', data, company_name: '网易' }), deps);
    expect(created.body.bank).toMatchObject({ name: '网易设计', status: 'importing' });
    await done;
    const banks = await call(get('/api/career/exam-search/banks'), deps);
    expect(banks.body).toMatchObject({ item_count: 1, banks: [{ status: 'ready', item_count: 1, company_name: '网易' }] });
    expect(events).toContain('career:data-changed');
  });
});
