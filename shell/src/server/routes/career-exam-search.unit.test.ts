import { FakeLLM } from '@career/core';
import { describe, expect, it } from 'vitest';

import { flushBillingWrites } from '../career/billing-service';
import { ShotTray } from '../career/exam-search/tray';
import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute } from './career';
import { handleExamSearchRoute, type ExamSearchRouteDeps } from './career-exam-search';

const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });
const get = (path: string) => new Request(`http://localhost${path}`);

async function call(request: Request, deps: Parameters<typeof handleCareerRoute>[2]) {
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error('路由没有接住');
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function callLive(request: Request, deps: ExamSearchRouteDeps) {
  const response = await handleExamSearchRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error('路由没有接住');
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('/api/career/exam-search', () => {
  it('粘贴文字 → 识别 → 作答 → 出现在这场的记录里', async () => {
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
    // 卖点埋点：答出一道记一道，写进这次用的库
    await flushBillingWrites();
    expect(repos.db.all('SELECT event, quantity FROM billing_event')).toEqual([{ event: 'exam_answered', quantity: 1 }]);
    const sessionId = (recognized.body.session as { id: string }).id;
    const sessions = await call(get('/api/career/exam-search/sessions'), deps);
    expect(sessions.body.sessions).toEqual([expect.objectContaining({ id: sessionId, search_count: 1, question_count: 1 })]);
    const session = await call(get(`/api/career/exam-search/sessions/${sessionId}`), deps);
    expect(session.body.searches).toEqual([expect.objectContaining({ id, status: 'answered' })]);
    expect((await call(new Request(`http://localhost/api/career/exam-search/sessions/${sessionId}`, { method: 'DELETE' }), deps)).status).toBe(200);
    expect((await call(get(`/api/career/exam-search/sessions/${sessionId}`), deps)).status).toBe(404);
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

  it('开考后点宠物截图挂上，一口气发出去：几张图一次认题，托盘清空', async () => {
    const repos = createMemoryRepos();
    const llm = new FakeLLM([JSON.stringify({ material: '表格', questions: [{ stem: '跨两张图的题', options: ['A. 1', 'B. 2'] }] })]);
    const shot = (data: string) => ({ image: { mediaType: 'image/jpeg' as const, data }, thumb: `thumb-${data}` });
    const shots = [shot('AAA'), null, shot('BBB')];
    const deps = { repos, llm, broadcast: () => {}, tray: new ShotTray(), capture: () => Promise.resolve(shots.shift() ?? null) };
    const base = '/api/career/exam-search/live';

    expect((await callLive(post(`${base}/capture`, {}), deps)).status).toBe(409);
    const started = await callLive(post(base, { company_name: '网易', role_title: '交互设计师' }), deps);
    expect(started.body.session).toMatchObject({ company_name: '网易', live_at: expect.any(String) });
    expect((await callLive(post(`${base}/capture`, {}), deps)).body).toMatchObject({ captured: true, count: 1 });
    expect((await callLive(post(`${base}/capture`, {}), deps)).body).toMatchObject({ captured: false, count: 1 });
    expect((await callLive(post(`${base}/capture`, {}), deps)).body).toMatchObject({ captured: true, count: 2 });
    expect((await callLive(get(base), deps)).body.shots).toEqual([
      { id: expect.any(String), thumb: 'thumb-AAA', captured_at: expect.any(String) },
      { id: expect.any(String), thumb: 'thumb-BBB', captured_at: expect.any(String) },
    ]);

    const sent = await callLive(post(`${base}/send`, {}), deps);
    expect(sent.body.search).toMatchObject({ input_kind: 'image', material: '表格', session_id: (started.body.session as { id: string }).id });
    expect(llm.calls[0].messages[0].images?.map(i => i.data)).toEqual(['AAA', 'BBB']);
    expect((await callLive(get(base), deps)).body.shots).toEqual([]);

    expect((await callLive(new Request(`http://localhost${base}`, { method: 'DELETE' }), deps)).status).toBe(200);
    expect((await callLive(get(base), deps)).body.session).toBeNull();
  });

  it('发送失败时截图放回托盘，不丢', async () => {
    const llm = new FakeLLM(['不是 JSON']);
    const tray = new ShotTray();
    const deps = { repos: createMemoryRepos(), llm, broadcast: () => {}, tray, capture: () => Promise.resolve({ image: { mediaType: 'image/jpeg' as const, data: 'AAA' }, thumb: 't' }) };
    await callLive(post('/api/career/exam-search/live', {}), deps);
    await callLive(post('/api/career/exam-search/live/capture', {}), deps);
    expect((await callLive(post('/api/career/exam-search/live/send', {}), deps)).status).toBe(500);
    expect((await callLive(get('/api/career/exam-search/live'), deps)).body.shots).toHaveLength(1);
  });
});
