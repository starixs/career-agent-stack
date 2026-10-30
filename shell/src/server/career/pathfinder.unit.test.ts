import { FakeLLM } from '@career/core';
import { describe, expect, it } from 'vitest';

import type { ActRequest, Observation, Receipt } from './browse';
import { describePage, findApplicationPage, type PathfinderGoal } from './pathfinder';
import { readSiteSop, rememberSiteSop, sopText } from './site-sop';
import { createMemoryRepos } from './test-db';

const goal: PathfinderGoal = { company: '联发科技', jobTitle: '软件类 / 通信类 / IC类', kinds: ['校招'], direction: ['后端开发'], cities: ['上海'], degree: '本科' };

function page(id: string, url: string, elements: Observation['elements'], text = ''): Observation {
  return { observation_id: id, url, title: id, scroll: { y: 0, max: 0, viewport: 800 }, elements, more_elements: 0, text, text_total: text.length, hints: [], tabs: [] };
}

/** 假网站：按点的元素跳页。 */
function site(pages: Record<string, Observation>, links: Record<string, string>, start: string) {
  let current = start;
  const acted: ActRequest[] = [];
  return {
    acted,
    observe: async () => pages[current],
    act: async (req: ActRequest): Promise<Receipt> => {
      acted.push(req);
      const next = req.ref !== undefined ? links[`${current}#${req.ref}`] : undefined;
      const before = pages[current].url;
      if (next) current = next;
      return { ok: true, action: req.action, observed_effect: next ? 'navigated' : 'no_change', url_before: before, url_after: pages[current].url, new_tabs: [], page: null as never, retryable: false, required_next: 'none', note: '' };
    },
  };
}

const says = (...replies: object[]) => new FakeLLM(replies.map(r => JSON.stringify(r)));

describe('自主找路（GA 式循环）', () => {
  it('首页 → 校园招聘 → 对口岗位 → 到了网申表就停；走通的步骤带回去', async () => {
    const pages = {
      home: page('o1', 'https://mediatek.zhiye.com/', [{ ref: 1, kind: 'link', text: '校园招聘' }, { ref: 2, kind: 'link', text: '社会招聘' }]),
      list: page('o2', 'https://mediatek.zhiye.com/campus/jobs', [{ ref: 1, kind: 'row', text: '数字IC工程师 北京' }, { ref: 2, kind: 'row', text: '软件开发工程师 上海 软件类' }]),
      form: page('o3', 'https://mediatek.zhiye.com/apply', [{ ref: 1, kind: 'input', text: '姓名' }, { ref: 2, kind: 'input', text: '手机' }]),
    };
    const s = site(pages, { 'home#1': 'list', 'list#2': 'form' }, 'home');
    const llm = says(
      { summary: '首页，先进校园招聘', action: { type: 'click', ref: 1 } },
      { summary: '选软件开发（上海）', key_info: '他学软件开发、本科', action: { type: 'click', ref: 2 } },
      { summary: '有姓名、手机格子', action: { type: 'done', state: 'form', note: '到了申请表' } },
    );
    const r = await findApplicationPage({ llm, observe: s.observe, act: s.act }, goal);
    expect(r).toMatchObject({ state: 'form', turns: 3 });
    expect(r.steps.map(x => x.target)).toEqual(['校园招聘', '软件开发工程师 上海 软件类']);
    // 第二回合的提示里带着工作记忆（上一步摘要），第三回合带着 key_info
    expect(llm.calls[1].messages[0].content).toContain('首页，先进校园招聘');
    expect(llm.calls[2].messages[0].content).toContain('他学软件开发、本科');
    // 只找校招：类型进了每一回合的提示（2026-10-31：天翼云那趟跑去了实习栏目）
    expect(llm.calls[0].messages[0].content).toContain('他要找：校招');
  });

  it('连续点不动：提示里出现「换一条路」；走满回合如实报 stuck，不抛错', async () => {
    const pages = { home: page('o1', 'https://x.com/', [{ ref: 1, kind: 'button', text: '更多' }]) };
    const s = site(pages, {}, 'home');
    const llm = says(...Array.from({ length: 5 }, () => ({ summary: '点更多', action: { type: 'click', ref: 1 } })));
    const r = await findApplicationPage({ llm, observe: s.observe, act: s.act, maxTurns: 5 }, goal);
    expect(r.state).toBe('stuck');
    expect(llm.calls[4].messages[0].content).toContain('换一条路');
    expect(r.steps).toEqual([]);
    expect(r.note).toBe('点更多'); // 说明用模型最后看到的，不是「走了 N 步」
    // 提醒了还原地打转：第 6 步就停，不走满
    const stubborn = says(...Array.from({ length: 14 }, () => ({ summary: '只有实习栏目，再点全部职位', action: { type: 'click', ref: 1 } })));
    const r2 = await findApplicationPage({ llm: stubborn, observe: s.observe, act: s.act, maxTurns: 14 }, goal);
    expect(r2).toMatchObject({ state: 'stuck', turns: 6, note: '只有实习栏目，再点全部职位' });
  });

  it('不合法的动作不执行；模型说没有对口岗位就带着说明停下', async () => {
    const pages = { home: page('o1', 'https://x.com/', [{ ref: 1, kind: 'link', text: '财务岗' }]) };
    const s = site(pages, {}, 'home');
    const llm = says({ summary: '乱来', action: { type: 'submit_form' } }, { summary: '只有财务', action: { type: 'done', state: 'no_position', note: '只有财务和销售岗' } });
    const r = await findApplicationPage({ llm, observe: s.observe, act: s.act }, goal);
    expect(s.acted).toEqual([]);
    expect(r).toMatchObject({ state: 'no_position', note: '只有财务和销售岗' });
  });

  it('给模型看的页面：编号元素 + 提交类标出来不能点', () => {
    const text = describePage(page('o1', 'https://x.com/apply', [{ ref: 3, kind: 'button', text: '提交申请', guarded: 'submit' }]));
    expect(text).toContain('[3] button 提交申请 （提交类，不能点）');
  });
});

describe('站点做法（走通的路径记下来，下次先照着走）', () => {
  it('按网站记，网址里的岗位号 / 租户号泛化；没走通不记', () => {
    const repos = createMemoryRepos();
    expect(rememberSiteSop(repos, 'zhiye.com', [], 'form')).toBeNull();
    rememberSiteSop(repos, 'zhiye.com', [{ action: 'click', target: '校园招聘', url: 'https://mediatek.zhiye.com/campus/jobs' }, { action: 'click', target: '立即投递', url: 'https://mediatek.zhiye.com/apply/1234567' }], 'login');
    const sop = readSiteSop(repos, 'zhiye.com');
    expect(sop?.steps[1].url).toBe('mediatek.zhiye.com/apply/<id>');
    expect(sopText(sop)).toContain('1. click「校园招聘」');
    expect(sopText(sop)).toContain('走到登录页');
  });
});

describe('找路结论给学生的话', () => {
  it('只按结论选写好的话，不带模型原话（2026-10-31 你定：模型的原因只进日志）', async () => {
    const { studentNote, NO_POSITION_NOTE, STUCK_NOTE } = await import('./pathfinder-host');
    expect(studentNote('no_position')).toBe(NO_POSITION_NOTE);
    expect(studentNote('stuck')).toBe(STUCK_NOTE);
    expect(`${NO_POSITION_NOTE}${STUCK_NOTE}`).not.toMatch(/步|模型|点击|滚动/);
  });
});
