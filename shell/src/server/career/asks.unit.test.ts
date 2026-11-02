/**
 * 要你的事（AskView）的派生、合并与排序：规范 CAREER_INTELLIGENT_UI.md §5.2、§8。
 * 合并只在「一个动作能同时解决」时发生；不另造 id，合并的条目能追溯到每个源 id。
 */
import { describe, expect, it } from 'vitest';
import { buildAsks, companyMarkOf, type Repos } from '@career/core';

import { createMemoryRepos } from './test-db';

const NOW = '2026-10-28T01:00:00.000Z';

function app(repos: Repos, company: string, extra: { deadline?: string } = {}) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: '后端开发', company_name: company, ...(extra.deadline ? { deadline: extra.deadline } : {}) });
  return repos.createApplication(job.id);
}

/** 填到提交前缺了几项：填表动作停在 needs_user，带门槛缺项，开 missing_info 接管。 */
function stuckOnFields(repos: Repos, appId: string, labels: string[]) {
  const a = repos.enqueueAction('fill_form', { job: appId }, appId, true);
  // 和 drive-outcome 同序：先开接管（它会把动作置为 needs_user），再写入带缺项的结果
  const h = repos.openHandoff('missing_info', { actionId: a.id, message: `还差 ${labels.length} 项要你补` });
  repos.setActionStatus(a.id, 'needs_user', {
    needsUser: labels.map(l => ({ label: l, key: l === '证件号码' ? 'idNumber' : undefined })),
    gate: { gaps: labels.map(l => ({ label: l, status: 'needs_user', required: true })) },
  });
  return h;
}

function stuckOnLogin(repos: Repos, appId: string, reason: 'login' | 'captcha' = 'login') {
  const a = repos.enqueueAction('fill_form', { job: appId }, appId, true);
  repos.setActionStatus(a.id, 'needs_user');
  return repos.openHandoff(reason, { actionId: a.id, message: '要登录' });
}

describe('AskView：一个动作能解决的才合并', () => {
  it('20 家都缺证件号码：合成一件，沿用第一个接管的 id，列出全部 20 个源', () => {
    const repos = createMemoryRepos();
    const handoffs = Array.from({ length: 20 }, (_, i) => stuckOnFields(repos, app(repos, `公司${i}`).id, ['证件号码']));
    const asks = buildAsks(repos, NOW);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: 'info', id: handoffs[0].id, title: '证件号码' });
    expect(asks[0].sources.map(s => s.id)).toEqual(handoffs.map(h => h.id));
    expect(asks[0].application_ids).toHaveLength(20);
    expect(asks[0].fields).toEqual([{ label: '证件号码', vault_field: 'idNumber', sensitive: true, fillable: true }]);
  });

  it('开放题小芽写好了一版：「等你」里的这一格带着草稿，他看一眼确认就行（2026-11-02 实例 A）', () => {
    const repos = createMemoryRepos();
    const a = repos.enqueueAction('fill_form', { job: 'x' }, app(repos, '青禾').id, true);
    repos.openHandoff('missing_info', { actionId: a.id, message: '还差 1 项' });
    repos.setActionStatus(a.id, 'needs_user', {
      needsUser: [{ label: '你为什么选择我们？' }],
      drafts: [{ label: '你为什么选择我们？', value: '我在社团做过三次宣传活动……' }],
      gate: { gaps: [{ label: '你为什么选择我们？', status: 'needs_user', required: true }] },
    });
    const [ask] = buildAsks(repos, NOW);
    expect(ask.fields).toEqual([{ label: '你为什么选择我们？', vault_field: null, sensitive: false, fillable: true, draft: '我在社团做过三次宣传活动……' }]);
  });

  it('缺的字段不一样就不合并：填了证件号码解决不了缺生源地的那家', () => {
    const repos = createMemoryRepos();
    stuckOnFields(repos, app(repos, '甲').id, ['证件号码']);
    stuckOnFields(repos, app(repos, '乙').id, ['证件号码', '生源地']);
    expect(buildAsks(repos, NOW).map(a => a.title).sort()).toEqual(['证件号码', '证件号码等 2 项']);
  });

  it('两个网站要登录、一个要过验证码：一次去浏览器，合成一件', () => {
    const repos = createMemoryRepos();
    stuckOnLogin(repos, app(repos, '摩尔线程').id);
    stuckOnLogin(repos, app(repos, '智元').id);
    stuckOnLogin(repos, app(repos, '大疆').id, 'captcha');
    const [login] = buildAsks(repos, NOW);
    expect(login).toMatchObject({ kind: 'login', title: '3 个网站等你过一下' });
    expect(login.sources).toHaveLength(3);
  });

  it('两场笔试是两件事：不按类型合并', () => {
    const repos = createMemoryRepos();
    for (const c of ['讯飞', '九方云']) repos.createDeadline({ kind: 'written_test', title: `${c} · 笔试`, due_at: '2026-10-29T12:00:00.000Z', application_id: app(repos, c).id });
    expect(buildAsks(repos, NOW).filter(a => a.kind === 'deadline')).toHaveLength(2);
  });

  it('还没开始填的几份（批准后材料变了退回待审）：一句「开始」全部放行，合成一件', () => {
    const repos = createMemoryRepos();
    const ids = ['美团', '京东', '华为'].map(c => repos.enqueueAction('fill_form', {}, app(repos, c).id).id);
    const [start] = buildAsks(repos, NOW);
    expect(start).toMatchObject({ kind: 'start', id: ids[0], title: '3 家等你说开始' });
    expect(start.sources.map(s => s.id)).toEqual(ids);
  });

  it('海投填好、检查全过的提交：合成一件「N 家填好了」一键投出；标星的目标岗位和有项要看的仍一家一件', () => {
    const repos = createMemoryRepos();
    const submit = (company: string, gaps = 0) => {
      const a = app(repos, company);
      const rows = [{ label: '姓名', status: 'ok' }, ...Array.from({ length: gaps }, () => ({ label: '作品集', status: 'upload_unconfirmed' }))];
      return { app: a, action: repos.enqueueAction('submit', { review: { rows, requiredFilled: 12, requiredTotal: 12 } }, a.id) };
    };
    const clean = ['DeepSeek', '中兴', '大疆'].map(c => submit(c));
    const target = submit('美团');
    submit('荣耀', 1);
    const asks = buildAsks(repos, NOW, { isTarget: id => id === target.app.id });
    const all = asks.find(a => a.title === '3 家填好了')!;
    expect(all).toMatchObject({ kind: 'review', id: clean[0].action.id });
    expect(all.sources.map(x => x.id)).toEqual(clean.map(c => c.action.id));
    expect(asks.filter(a => a.kind === 'review').map(a => a.title).sort()).toEqual(['3 家填好了', '美团 · 投前过目', '荣耀 · 投前过目']);
  });

  it('网申卡在测评、同一份申请又记了测评截止：是同一件事，并进截止那件', () => {
    const repos = createMemoryRepos();
    const a = app(repos, '九方云');
    const d = repos.createDeadline({ kind: 'assessment', title: '九方云 · 在线测评', due_at: '2026-10-28T15:59:00.000Z', application_id: a.id });
    const act = repos.enqueueAction('fill_form', {}, a.id, true);
    const h = repos.openHandoff('assessment', { actionId: act.id });
    const asks = buildAsks(repos, NOW);
    expect(asks).toHaveLength(1);
    expect(asks[0].id).toBe(d.id);
    expect(asks[0].sources).toEqual([{ type: 'deadline', id: d.id }, { type: 'handoff', id: h.id }]);
  });
});

describe('AskView：按外部期限排序', () => {
  it('有期限的按先后；没期限的排在后面、挡住的申请多的在前；过了时间问「考了吗」的放最后', () => {
    const repos = createMemoryRepos();
    repos.createDeadline({ kind: 'written_test', title: '美团 · 笔试', due_at: '2026-10-27T11:00:00.000Z', application_id: app(repos, '美团').id });
    stuckOnLogin(repos, app(repos, '智元').id);
    for (const c of ['甲', '乙', '丙']) stuckOnFields(repos, app(repos, c).id, ['证件号码']);
    repos.createDeadline({ kind: 'written_test', title: '讯飞 · 笔试', due_at: '2026-10-30T12:00:00.000Z', application_id: app(repos, '讯飞').id });
    repos.createDeadline({ kind: 'assessment', title: '九方云 · 在线测评', due_at: '2026-10-28T15:59:00.000Z', application_id: app(repos, '九方云').id });
    expect(buildAsks(repos, NOW).map(a => a.kind + ':' + a.title)).toEqual([
      'deadline:九方云 · 在线测评', 'deadline:讯飞 · 笔试', 'info:证件号码', 'login:智元 · 要登录', 'attendance:美团 · 笔试：考了吗？',
    ]);
  });

  it('没有自己期限的事，挡住的网申有截止日：用最早那个当外部期限', () => {
    const repos = createMemoryRepos();
    stuckOnFields(repos, app(repos, '甲', { deadline: '2026-10-31T15:59:00.000Z' }).id, ['证件号码']);
    stuckOnFields(repos, app(repos, '乙', { deadline: '2026-10-29T15:59:00.000Z' }).id, ['证件号码']);
    expect(buildAsks(repos, NOW)[0].due_at).toBe('2026-10-29T15:59:00.000Z');
  });

  it('处理掉一个源（关掉接管、完成截止），下次派生它就不在了：几处是同一个对象', () => {
    const repos = createMemoryRepos();
    const h = stuckOnLogin(repos, app(repos, '智元').id);
    const d = repos.createDeadline({ kind: 'assessment', title: '九方云 · 在线测评', due_at: '2026-10-28T15:59:00.000Z', application_id: app(repos, '九方云').id });
    repos.closeHandoff(h.id);
    repos.setDeadlineStatus(d.id, 'done');
    expect(buildAsks(repos, NOW)).toEqual([]);
  });

  it('测评邮件带来的截止：标出来自哪封信', () => {
    const repos = createMemoryRepos();
    const a = app(repos, '九方云');
    const d = repos.createDeadline({ kind: 'assessment', title: '九方云 · 在线测评', due_at: '2026-10-28T15:59:00.000Z', application_id: a.id, source: 'mail' });
    const mail = repos.createInboxItem({ source: 'mail', raw_text: '九方云在线测评邀请' });
    repos.resolveInboxItem(mail.id, { kind: 'assessment', linked_type: 'application', linked_id: a.id });
    expect(buildAsks(repos, NOW).find(x => x.id === d.id)?.source?.inbox_item_id).toBe(mail.id);
  });
});

describe('CompanyMark', () => {
  it('打包了官方标志的写标志，美团铺品牌色；找不到的写名字', () => {
    expect(companyMarkOf('美团')).toMatchObject({ logo: 'mt', fill: '#ffd100' });
    expect(companyMarkOf('北京字节跳动科技有限公司')).toMatchObject({ logo: 'zj' });
    expect(companyMarkOf('讯飞')).toMatchObject({ logo: 'xf' });
    const small = companyMarkOf('九方云');
    expect(small.logo).toBeUndefined();
    expect(small.name).toBe('九方云');
    expect(companyMarkOf(null).name).toBe('未知公司');
  });
});
