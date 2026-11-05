import { FakeLLM } from '@career/core';
import { describe, expect, it } from 'vitest';

import { loadCore } from '../core-module';
import { createMemoryRepos } from '../test-db';
import { chunkText, parseBankItems } from './importer';
import { buildAnswerPrompt, parseRecognition } from './llm-steps';
import { isSameQuestion, normalizeStem, numbersIn, roleFamily, sameCompany, stemSimilarity, tierOf } from './match';
import { ExamSearchService, upcomingExamContexts } from './service';

async function makeService(llm = new FakeLLM()) {
  const repos = createMemoryRepos();
  const core = await loadCore();
  return { service: new ExamSearchService(repos.db, core, llm), llm, repos };
}

const NETEASE_BANK = {
  name: '网易 2024 交互设计笔试', origin: 'user' as const, company_name: '网易', role_title: '交互设计师', year: 2024,
};

describe('题干相似度与分级', () => {
  it('换了题号、标点和空格的固定题仍算同一道', () => {
    expect(normalizeStem('3. 以下哪项 不属于 尼尔森十大可用性原则？')).toBe('以下哪项不属于尼尔森十大可用性原则');
    expect(stemSimilarity('以下哪项不属于尼尔森十大可用性原则？', '（12）以下哪项不属于尼尔森 十大可用性原则')).toBeGreaterThan(0.95);
    expect(stemSimilarity('以下哪项不属于尼尔森十大可用性原则', '甲乙两人同时出发，相向而行')).toBeLessThan(0.2);
  });

  it('改了数字就不是同一道题（答案会变），题号不算数字', () => {
    const a = '某商品先提价 20%，再降价 20%，现价与原价相比';
    const b = '某商品先提价 10%，再降价 10%，现价与原价相比';
    expect(stemSimilarity(a, b)).toBeGreaterThan(0.72);
    expect(isSameQuestion(stemSimilarity(a, b), a, b)).toBe(false);
    expect(numbersIn('（12）甲比乙大 3 岁')).toEqual(['3']);
    expect(isSameQuestion(0.9, '3. 甲比乙大 3 岁', '甲比乙大3岁')).toBe(true);
  });

  it('岗位按关键词归族，公司名忽略后缀', () => {
    expect(roleFamily('UI 视觉设计师')).toBe('设计');
    expect(roleFamily('运维开发工程师')).toBe('运维');
    expect(roleFamily('新媒体运营')).toBe('新媒体');
    expect(roleFamily('后端开发')).toBe('开发');
    expect(sameCompany('网易（杭州）网络有限公司', '网易')).toBe(true);
    expect(sameCompany('网易', '字节跳动')).toBe(false);
  });

  it('同公司同岗位 > 同岗位别家 > 同公司别的岗位 > 通用', () => {
    const ctx = { companyName: '网易', roleTitle: '交互设计' };
    expect(tierOf({ company_name: '网易', role_family: '设计' }, ctx)).toBe('same-role-company');
    expect(tierOf({ company_name: '字节跳动', role_family: '设计' }, ctx)).toBe('same-role');
    expect(tierOf({ company_name: '网易', role_family: '开发' }, ctx)).toBe('same-company');
    expect(tierOf({ company_name: null, role_family: null }, ctx)).toBe('general');
  });
});

describe('题库检索', () => {
  it('同一道题在别家同岗位和本公司同岗位都有时，本公司的排前面', async () => {
    const { service } = await makeService();
    const stem = '以下哪项不属于尼尔森十大可用性原则';
    service.bank.createBank({ ...NETEASE_BANK, name: '字节设计', company_name: '字节跳动', year: 2023 }, [{ stem, options: ['A. 系统状态可见', 'B. 防错', 'C. 美观至上'], answer: 'C' }]);
    service.bank.createBank(NETEASE_BANK, [{ stem, options: ['A. 系统状态可见', 'B. 防错', 'C. 美观至上'], answer: 'C', explanation: '美观不是十大原则之一' }]);
    const matches = service.bank.search(`${stem} A. 系统状态可见 B. 防错 C. 美观至上`, { companyName: '网易', roleTitle: '交互设计' });
    expect(matches.map(m => m.company_name)).toEqual(['网易', '字节跳动']);
    expect(matches[0].tier).toBe('same-role-company');
  });

  it('删除题库连同索引一起删', async () => {
    const { service } = await makeService();
    const bank = service.bank.createBank(NETEASE_BANK, [{ stem: '用户旅程地图主要用来做什么', answer: '梳理体验触点' }]);
    expect(service.bank.search('用户旅程地图主要用来做什么', { companyName: null, roleTitle: null })).toHaveLength(1);
    expect(service.bank.deleteBank(bank.id)).toBe(true);
    expect(service.bank.search('用户旅程地图主要用来做什么', { companyName: null, roleTitle: null })).toHaveLength(0);
  });
});

describe('搜题流程', () => {
  it('原题直接用题库答案，其余题带参考题问模型', async () => {
    const llm = new FakeLLM([
      JSON.stringify({ company_hint: '网易', role_hint: null, questions: [
        { stem: '以下哪项不属于尼尔森十大可用性原则', options: ['A. 系统状态可见', 'B. 防错', 'C. 美观至上'], qtype: 'single' },
        { stem: '你更愿意独立完成任务还是与团队协作', options: ['A. 独立', 'B. 协作'], qtype: 'personality' },
      ] }),
      JSON.stringify({ answers: [{ index: 1, answer: 'B', explanation: '交互设计要和产品、研发频繁配合', confidence: 'medium' }] }),
    ]);
    const { service } = await makeService(llm);
    service.bank.createBank(NETEASE_BANK, [{ stem: '以下哪项不属于尼尔森十大可用性原则', options: ['A. 系统状态可见', 'B. 防错', 'C. 美观至上'], answer: 'C', explanation: '美观不是十大原则之一' }]);

    const { search: recognized } = await service.recognize({ text: '1. 以下哪项…', roleTitle: '交互设计师' });
    expect(recognized.company_name).toBe('网易');
    expect(recognized.status).toBe('recognized');
    expect(recognized.answers).toEqual([expect.objectContaining({ index: 0, answer: 'C', source: 'bank' })]);

    const answered = await service.answer(recognized.id);
    expect(answered.status).toBe('answered');
    expect(answered.answers.map(a => [a.index, a.answer, a.source])).toEqual([[0, 'C', 'bank'], [1, 'B', 'model']]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages[0].content).toContain('<题 index="1"');
    expect(llm.calls[1].messages[0].content).not.toContain('<题 index="0"');
    expect(service.searchesOf(recognized.session_id).map(s => s.id)).toEqual([recognized.id]);
  });

  it('模型漏答的题重问一次', async () => {
    const llm = new FakeLLM([
      JSON.stringify({ questions: [{ stem: '题一', options: [] }, { stem: '题二', options: [] }] }),
      JSON.stringify({ answers: [{ index: 0, answer: 'A', confidence: 'high' }] }),
      JSON.stringify({ answers: [{ index: 1, answer: 'B', confidence: 'medium' }] }),
    ]);
    const { service } = await makeService(llm);
    const { search: recognized } = await service.recognize({ text: '题一 题二' });
    const answered = await service.answer(recognized.id);
    expect(answered.answers.map(a => a.answer)).toEqual(['A', 'B']);
    expect(llm.calls[2].messages[0].content).toContain('<题 index="1"');
    expect(llm.calls[2].messages[0].content).not.toContain('<题 index="0"');
  });

  it('共用材料存进记录（不存截图），作答时带给模型', async () => {
    const material = '| 年份 | 营收 |\n| --- | --- |\n| 2023 | 100 |\n| 2024 | 120 |';
    const llm = new FakeLLM([
      JSON.stringify({ material, questions: [{ stem: '2024 年营收同比增长多少', options: ['A. 10%', 'B. 20%'], qtype: 'single' }] }),
      JSON.stringify({ answers: [{ index: 0, answer: 'B', confidence: 'high' }] }),
    ]);
    const { service } = await makeService(llm);
    const { search } = await service.recognize({ image: { mediaType: 'image/png', data: 'AAAA' } });
    expect(search).toMatchObject({ input_kind: 'image', input_text: null, material });
    await service.answer(search.id);
    expect(llm.calls[1].messages[0].content).toContain(`<材料>\n${material}\n</材料>`);
  });

  it('作答失败时记录标成 failed 并带上原因', async () => {
    const llm = new FakeLLM([JSON.stringify({ questions: [{ stem: '数列 2, 4, 8, ? 下一项是', options: [], qtype: 'fill' }] }), '不是 JSON']);
    const { service } = await makeService(llm);
    const { search: recognized } = await service.recognize({ text: '数列 2, 4, 8, ?' });
    await expect(service.answer(recognized.id)).rejects.toThrow();
    expect(service.get(recognized.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('JSON') });
  });

  it('作答提示词带上参考题的来源与答案', () => {
    const prompt = buildAnswerPrompt([{
      index: 0, stem: '题干', options: [], qtype: 'single',
      matches: [{ item_id: 'x', stem: '参考题干', options: [], answer: 'A', explanation: '因为', company_name: '网易', role_title: '交互设计师', year: 2024, bank_name: 'b', origin: 'user', tier: 'same-role-company', similarity: 0.9, same: false }],
    }], { companyName: '网易', roleTitle: '交互设计' });
    expect(prompt).toContain('同公司同岗位往年题，网易 · 交互设计师 · 2024');
    expect(prompt).toContain('答案：A');
  });

  it('识别结果丢掉没有题干的项、未知题型置空', () => {
    expect(parseRecognition({ questions: [{ stem: '' }, { stem: '题', qtype: 'essay', options: ['A. 1', 2] }] }).questions)
      .toEqual([{ index: 0, stem: '题', options: ['A. 1'], qtype: null }]);
    expect(() => parseRecognition({})).toThrow('questions');
  });
});

describe('按场记录', () => {
  it('同一场的几次粘贴归在一起、按先后排；没带场就开新的一场', async () => {
    const llm = new FakeLLM([
      JSON.stringify({ company_hint: '网易', questions: [{ stem: '题一', options: [] }] }),
      JSON.stringify({ questions: [{ stem: '题二', options: [] }, { stem: '题三', options: [] }] }),
      JSON.stringify({ questions: [{ stem: '别场的题', options: [] }] }),
    ]);
    const { service } = await makeService(llm);
    const first = await service.recognize({ text: '题一', roleTitle: '交互设计师' });
    const second = await service.recognize({ sessionId: first.session.id, text: '题二 题三' });
    const other = await service.recognize({ text: '别场的题' });

    expect(second.session.id).toBe(first.session.id);
    expect(second.search).toMatchObject({ company_name: '网易', role_title: '交互设计师' });
    expect(other.session.id).not.toBe(first.session.id);
    expect(service.searchesOf(first.session.id).map(s => s.id)).toEqual([first.search.id, second.search.id]);
    const summary = service.sessions.list().find(s => s.id === first.session.id);
    expect(summary).toMatchObject({ company_name: '网易', role_title: '交互设计师', search_count: 2, question_count: 3, first_stem: '题一' });
  });

  it('带了不存在的场直接报错，不调模型；删一场连同它的记录一起删', async () => {
    const llm = new FakeLLM([JSON.stringify({ questions: [{ stem: '题', options: [] }] })]);
    const { service } = await makeService(llm);
    await expect(service.recognize({ sessionId: 'exm_nope', text: '题' })).rejects.toThrow('不存在');
    expect(llm.calls).toHaveLength(0);
    const { session } = await service.recognize({ text: '题' });
    expect(service.sessions.remove(session.id)).toBe(true);
    expect(service.searchesOf(session.id)).toEqual([]);
    expect(service.sessions.list()).toEqual([]);
  });

  it('旧表没有场：补列后旧记录各自成一场', async () => {
    const repos = createMemoryRepos();
    repos.db.raw.exec(`CREATE TABLE exam_search (id TEXT PRIMARY KEY, company_name TEXT, role_title TEXT, input_kind TEXT NOT NULL, input_text TEXT,
      questions_json TEXT NOT NULL DEFAULT '[]', answers_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'recognized', error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const t = '2026-10-30T12:00:00.000Z';
    repos.db.insert('exam_search', { id: 'exs_old', company_name: '网易', input_kind: 'text', questions_json: '[{"index":0,"stem":"老题","options":[]}]', created_at: t, updated_at: t });
    const service = new ExamSearchService(repos.db, await loadCore(), new FakeLLM());
    expect(service.sessions.list()).toEqual([expect.objectContaining({ id: 'exm_exs_old', company_name: '网易', search_count: 1, first_stem: '老题' })]);
    expect(service.searchesOf('exm_exs_old').map(s => s.id)).toEqual(['exs_old']);
  });
});

describe('这场笔试的候选', () => {
  it('取最近的笔试、测评期限，带上公司和岗位', async () => {
    const { repos } = await makeService();
    const now = new Date('2026-10-30T12:00:00Z');
    const t = now.toISOString();
    repos.db.insert('job', { id: 'job1', source_platform: 'manual', company_name: '网易', title: '交互设计师', created_at: t, updated_at: t });
    repos.db.insert('deadline', { id: 'd1', kind: 'written_test', title: '网易笔试', due_at: '2026-10-30T11:00:00Z', job_id: 'job1', created_at: t, updated_at: t });
    repos.db.insert('deadline', { id: 'd2', kind: 'interview', title: '面试', due_at: '2026-10-30T13:00:00Z', created_at: t, updated_at: t });
    repos.db.insert('deadline', { id: 'd3', kind: 'assessment', title: '很久以前', due_at: '2026-10-01T00:00:00Z', created_at: t, updated_at: t });
    expect(upcomingExamContexts(repos.db, now)).toEqual([
      expect.objectContaining({ deadline_id: 'd1', company_name: '网易', role_title: '交互设计师' }),
    ]);
  });
});

describe('题库导入', () => {
  it('JSON 与模型输出共用校验：没答案保持 null，年份不合法丢掉', () => {
    expect(parseBankItems({ items: [{ stem: '题', answer: null, year: '2024' }, { stem: '题2', answer: 'A', year: 'abc' }, { nope: 1 }] }))
      .toEqual([
        expect.objectContaining({ stem: '题', answer: null, year: 2024 }),
        expect.objectContaining({ stem: '题2', answer: 'A', year: null }),
      ]);
  });

  it('按空行切段，单段不超过上限的两倍', () => {
    const para = '题'.repeat(40);
    const chunks = chunkText(Array.from({ length: 10 }, () => para).join('\n\n'), 100);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(c => c.length <= 200)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(para.repeat(10));
  });
});
