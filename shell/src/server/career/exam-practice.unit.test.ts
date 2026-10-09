import { describe, expect, it } from 'vitest';

import { loadCore } from './core-module';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

async function makeStore(): Promise<CareerStore> {
  return new CareerStore(createMemoryRepos(), await loadCore());
}

describe('笔试练习存档', () => {
  it('出题新建，作答与点评按题号合并，finish 后标记已复盘', async () => {
    const store = await makeStore();
    const created = store.saveExamPractice({
      title: '星河科技 产品经理 行测', kind: '行测',
      questions: [{ q: '数列 2, 4, 8, ? ', reference: '16' }, { q: '甲比乙大 3 岁……', reference: '7' }],
    });
    expect(created.status).toBe('answering');
    expect(JSON.parse(created.questions_json)).toHaveLength(2);

    store.saveExamPractice({ id: created.id, answers: [{ index: 0, answer: '16' }] });
    store.saveExamPractice({ id: created.id, answers: [{ index: 1, answer: '6' }, { index: 0, answer: '16（确认）' }] });
    const answered = store.getExamPractice(created.id)!;
    expect(JSON.parse(answered.answers_json)).toEqual([{ index: 0, answer: '16（确认）' }, { index: 1, answer: '6' }]);

    const reviewed = store.saveExamPractice({
      id: created.id, finish: true, summary: '数量关系要再练',
      review: [{ index: 0, verdict: '对' }, { index: 1, verdict: '错', comment: '设未知数时漏了条件' }],
    });
    expect(reviewed.status).toBe('reviewed');
    expect(JSON.parse(reviewed.review_json)[1]).toMatchObject({ verdict: '错' });
    expect(store.listExamPractices().map(e => e.id)).toEqual([created.id]);
  });

  it('新建必须给标题；续写不存在的练习会报错', async () => {
    const store = await makeStore();
    expect(() => store.saveExamPractice({ questions: [] })).toThrow('title');
    expect(() => store.saveExamPractice({ id: 'exm_missing', answers: [] })).toThrow('不存在');
  });
});
