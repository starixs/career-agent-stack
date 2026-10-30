import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import { TabContext, type TabContextValue } from '@/context/TabContext';

import { CareerChatCards, collectToolUseIds } from './CareerChatCards';
import { BatchProgressCard, CareerFlowCards, NeedsUserCard } from './CareerFlowCards';
import { ApplyGapsCard } from './CareerReviewCard';
import type { CareerCard } from './types';

const card = (kind: CareerCard['kind'], data: Record<string, unknown>, title = '卡片'): CareerCard => ({ id: `${kind}:1`, kind, title, data, createdAt: '2026-10-03T00:00:00Z' });

function renderCards(cards: CareerCard[], dismiss = vi.fn(), messages: unknown[] = []) {
  const value = { tabId: 't', agentDir: '/tmp', careerTakeover: null, careerProgress: null, careerCards: cards, setCareerCardState: dismiss, messages } as unknown as TabContextValue;
  render(<TabContext.Provider value={value}><CareerChatCards /></TabContext.Provider>);
  return dismiss;
}

/** 缺项卡归等你条、不在对话里渲染（规范 §5.1）；卡片组件本身仍在，直接渲染来测。 */
function renderCard(Comp: typeof NeedsUserCard, c: CareerCard, dismiss = vi.fn()) {
  render(<Comp card={c} onDone={() => dismiss(c.id, 'completed')} onDismiss={() => dismiss(c.id, 'dismissed')} />);
  return dismiss;
}

function captureSuggest() {
  const seen: string[] = [];
  const refs: Array<Record<string, string> | undefined> = [];
  const off = onEvent<{ text: string; context?: { refs?: Record<string, string> } }>('career:chat-suggest', p => { seen.push(p.text); refs.push(p.context?.refs); });
  return { seen, refs, off };
}

describe('对话内流程卡片', () => {
  beforeEach(() => {
    // 对话底部的起步卡会读资料完成度：默认返回空（不出起步卡）
    vi.mocked(apiGetJson).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(apiPutJson).mockReset().mockResolvedValue({ ok: true, item: {} });
  });

  it('补齐基本信息：写私密库（不进对话），完成后告诉助理继续并移除卡片', async () => {
    const { seen, off } = captureSuggest();
    const dismiss = renderCards([card('vault_missing', { fields: [{ field: 'name', label: '真实姓名', sensitive: true }, { field: 'phone', label: '手机号', sensitive: true }] }, '补齐网申基本信息')]);
    expect(screen.getByTestId('career-card-vault_missing')).toHaveTextContent('缺 2 项');
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('vault_missing:1', 'completed'));
    expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'profile', field: 'phone', value: '13800138000' });
    expect(seen).toEqual(['基本信息已在卡片里补齐（手机号），请继续']);
    expect(seen.join('')).not.toContain('13800138000');
    off();
  });

  it('网申缺项：资料字段进私密库、其余进答案库，然后请助理从当前页继续', async () => {
    const { seen, refs, off } = captureSuggest();
    renderCard(NeedsUserCard, card('needs_user', { action_id: 'act1', items: [{ label: '身份证号', vault_field: 'idNumber', sensitive: true }, { label: '期望薪资', note: '月薪' }] }));
    fireEvent.change(screen.getByLabelText('身份证号'), { target: { value: '110101200001011234' } });
    fireEvent.change(screen.getByLabelText('期望薪资'), { target: { value: '面议' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并继续填表' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'profile', field: 'idNumber', value: '110101200001011234' });
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/answer-bank', { question_key: '期望薪资', question_text: '期望薪资', answer: '面议', confirmed: true });
    // 动作 id 只放在隐藏上下文里，不出现在用户看得见的话里
    expect(seen[0]).not.toContain('act1');
    expect(refs[0]).toEqual({ action_id: 'act1' });
    expect(seen[0]).not.toContain('110101');
    off();
  });

  it('还差几项（合并后的唯一缺项卡）：能填的项带输入框，填了就保存并继续检查；上传类只列不填', async () => {
    const { seen, refs, off } = captureSuggest();
    renderCard(ApplyGapsCard, card('apply_gaps', { action_id: 'act1', required_filled: 18, required_total: 20, items: [
      { label: '证件号码', reason: '高影响问题', status: 'needs_user', required: true, input: { vault_field: 'idNumber', sensitive: true } },
      { label: '作品集', reason: '不确定该上传什么文件', status: 'needs_user', required: true, input: null },
    ] }, '「美团」还差 2 项要你补'));
    const box = screen.getByTestId('career-card-apply_gaps');
    expect(box).toHaveTextContent('作品集');
    expect(screen.queryByLabelText('作品集')).toBeNull();
    expect(screen.getByRole('button', { name: '补好了，继续检查' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('证件号码'), { target: { value: '110101200001011234' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项并继续检查' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'profile', field: 'idNumber', value: '110101200001011234' });
    expect(refs[0]).toEqual({ action_id: 'act1' });
    expect(seen[0]).not.toContain('110101');
    off();
  });

  it('开放题草稿：可改、可不采用，确认的写进答案库', async () => {
    renderCards([card('drafts', { action_id: 'act1', items: [{ label: '为什么选择我们', value: '草稿A' }, { label: '职业规划', value: '草稿B' }] })]);
    fireEvent.change(screen.getByLabelText('回答：为什么选择我们'), { target: { value: '改过的A' } });
    fireEvent.click(screen.getByLabelText('采用：职业规划'));
    fireEvent.click(screen.getByRole('button', { name: '确认 1 条并继续' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/answer-bank', { question_key: '为什么选择我们', question_text: '为什么选择我们', answer: '改过的A', confirmed: true, high_impact: true });
  });

  it('还差几项：逐项列出字段与原因，「补好了」请助理从当前页继续检查（id 在隐藏上下文）', async () => {
    const { seen, refs, off } = captureSuggest();
    const dismiss = renderCard(ApplyGapsCard, card('apply_gaps', { action_id: 'act9', required_filled: 10, required_total: 12, items: [{ label: '毕业时间', reason: '必填项还是空的', status: 'empty' }, { label: '简历附件', reason: '页面没有出现上传成功提示', status: 'upload_unconfirmed' }] }, '「美团 后端」还差 2 项要你补：毕业时间、简历附件'));
    const el = screen.getByTestId('career-card-apply_gaps');
    expect(el).toHaveTextContent('必填 10/12');
    expect(el).toHaveTextContent('毕业时间');
    expect(el).toHaveTextContent('必填项还是空的');
    fireEvent.click(screen.getByRole('button', { name: '补好了，继续检查' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(dismiss).toHaveBeenCalledWith('apply_gaps:1', 'completed');
    expect(seen[0]).not.toMatch(/act9|apply_/);
    expect(refs[0]).toEqual({ action_id: 'act9' });
    off();
  });

  it('经历说法：只确认勾选的', async () => {
    renderCards([card('claims_confirm', { experience_id: 'e1', experience_title: '字节实习', claims: [{ id: 'c1', text: '主导推荐召回重构', result_metric: 'CTR +3%' }, { id: 'c2', text: '带 3 人小组', attribution: 'team' }] })]);
    fireEvent.click(screen.getByLabelText('带 3 人小组'));
    fireEvent.click(screen.getByRole('button', { name: '确认所选 1 条' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/claims/c1/confirm', {}));
    expect(apiPostJson).not.toHaveBeenCalledWith('/api/career/claims/c2/confirm', {});
  });

  it('面试复盘回流：新说法可确认，答不上来的事实列出来、点「去补这几处」交给助理', async () => {
    const { seen, off } = captureSuggest();
    renderCards([card('claims_confirm', { experience_id: 'e1', experience_title: '美团实习', source: 'interview_retro', interview_id: 'itv1', claims: [{ id: 'c9', text: '召回负样本按曝光未点击采样' }], gaps: ['线上 A/B 收益说不清'] })]);
    expect(screen.getByTestId('career-card-claims_confirm')).toHaveTextContent('这场面试里没答上来、还要补的事实');
    expect(screen.getByTestId('career-card-claims_confirm')).toHaveTextContent('下次定制时才会用上');
    fireEvent.click(screen.getByRole('button', { name: '去补这几处' }));
    off();
    expect(seen).toEqual(['帮我把「美团实习」补上：线上 A/B 收益说不清']);
  });

  it('只有要补的事实、没有新说法时，不出确认按钮', () => {
    renderCards([card('claims_confirm', { experience_id: 'e1', experience_title: '美团实习', source: 'interview_retro', claims: [], gaps: ['线上收益'] })]);
    expect(screen.queryByRole('button', { name: /确认所选/ })).toBeNull();
    expect(screen.getByRole('button', { name: '去补这几处' })).toBeInTheDocument();
  });

  it('面试准备卡：时间、上次卡点、高风险深挖点、题，点「开始模拟」交给助理', () => {
    const { seen, off } = captureSuggest();
    renderCards([card('interview_prep', {
      company: '百度', title: '算法', job_id: 'j1', round: 'second', at: '2026-11-05T06:00:00.000Z',
      carried: [{ company: '百度', round: 'first', same_application: true, points: ['线上 A/B 收益'] }],
      predictions: [{ statement: '召回 AUC +1.8%', risk: 'high', chain: ['口径？', '线上？'] }],
      questions: [{ id: 'q1', content: '负样本怎么采？' }],
    }, '准备 百度 算法')]);
    const el = screen.getByTestId('career-card-interview_prep');
    expect(el).toHaveTextContent('上一轮：线上 A/B 收益');
    expect(el).toHaveTextContent('高风险 · 召回 AUC +1.8%');
    expect(el).toHaveTextContent('口径？ → 线上？');
    expect(el).toHaveTextContent('负样本怎么采？');
    fireEvent.click(screen.getByRole('button', { name: '开始模拟' }));
    off();
    expect(seen[0]).toBe('开始模拟 百度 二面（job_id=j1，round=second），先从高风险的深挖点问起');
  });

  it('批量投递进行中：对话里不再单独出进度卡（数字在等你条「投出 x / y」）', () => {
    renderCards([]);
    act(() => emitEvent('career:batch', { status: 'running', updatedAt: '', done: 2, failed: 0, handoffs: 1, queued: 3, todayCount: 2, message: '正在填写：B 公司' }));
    expect(screen.queryByTestId('career-card-batch')).toBeNull();
  });

  it('批量进度卡（通知中心仍在用）：可暂停', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, batch: { status: 'paused', updatedAt: '', done: 2, failed: 0, handoffs: 0, queued: 3, todayCount: 2 } });
    render(<BatchProgressCard batch={{ status: 'running', updatedAt: '', done: 2, failed: 0, handoffs: 1, queued: 3, todayCount: 2, message: '正在填写：B 公司' }} />);
    expect(screen.getByTestId('career-card-batch')).toHaveTextContent('正在填写：B 公司');
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/batch/command', { cmd: 'pause' }));
    expect(await screen.findByRole('button', { name: '继续' })).toBeInTheDocument();
  });

  it('改了共用的简历：对话里一张更正卡，换成新版的一堆、已经在投或投出改不了的一堆', () => {
    render(<CareerFlowCards cards={[card('fix', { swapped: [{ company_id: null, name: '美团', logo: 'mt' }], locked: [{ company_id: null, name: '京东' }, { company_id: null, name: '拼多多' }] }, '改了共用的简历')]} onStateChange={vi.fn()} />);
    const el = screen.getByTestId('fix-card');
    expect(el).toHaveTextContent('1 家换成新版');
    expect(el).toHaveTextContent('2 家已经在投或投出，改不了');
  });

  it('稍后再说：只是从对话里移除', () => {
    const dismiss = renderCards([card('vault_missing', { fields: [{ field: 'email', label: '邮箱' }] })]);
    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }));
    expect(dismiss).toHaveBeenCalledWith('vault_missing:1', 'dismissed');
  });

  it('保存登录账号：写私密库站点作用域并开代填，然后打开现场', async () => {
    const drawer: unknown[] = [];
    const off = onEvent('career:live-drawer', p => { drawer.push(p); });
    const dismiss = renderCards([card('site_login', { host: 'campus.example.com', action_id: 'act1' }, '保存 campus.example.com 的登录账号')]);
    expect(screen.getByRole('button', { name: '保存并去登录' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'me@x.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Secret#1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并去登录' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('site_login:1', 'completed'));
    expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'site', ref_id: 'campus.example.com', field: 'username', value: 'me@x.com', policy: { autofill: true } });
    expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'site', ref_id: 'campus.example.com', field: 'password', value: 'Secret#1', policy: { autofill: true } });
    expect(drawer).toHaveLength(1);
    off();
  });

  it('绑定邮箱卡片：从连接中心连好后请助理归档，消息里不带地址和授权码', async () => {
    const connector = { id: 'qq', name: 'QQ 邮箱', auth_type: 'credential_form', capabilities: ['receive'], open_url: 'https://wx.mail.qq.com/', open_label: '打开 QQ 邮箱', help_url: null,
      guide: [{ title: '打开 QQ 邮箱网页版', text: '' }], verify_note: '', fields: [{ key: 'email', type: 'email', label: '邮箱地址', placeholder: '' }, { key: 'authCode', type: 'secret', label: '授权码', placeholder: '', length: 16 }] };
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, connectors: [connector], accounts: [] });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { ok: true, smtp_ok: true, account: { id: 'm1', provider: 'qq', address: 'me@qq.com' } } });
    const { seen, off } = captureSuggest();
    renderCards([card('mail_bind', {}, '绑定求职邮箱')]);
    fireEvent.click(await screen.findByRole('button', { name: /QQ 邮箱/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始连接' }));
    fireEvent.click(screen.getByRole('button', { name: '我已获取授权码，下一步' }));
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'me@qq.com' } });
    fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'abcdefghijklmnop' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并连接' }));
    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0]).not.toMatch(/me@qq.com|abcdefghijklmnop/);
    expect(await screen.findByText(/已连接 me@qq.com/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    off();
  });

  it('底部只放无锚点 / 锚点不在消息里的待处理卡片；已处理的不在底部堆叠', () => {
    const anchored = { ...card('drafts', { items: [{ label: 'Q', value: 'A' }] }, '锚定卡'), id: 'a', toolUseId: 'toolu_1' };
    const orphan = { ...card('vault_missing', { fields: [{ field: 'email', label: '邮箱' }] }, '孤儿卡'), id: 'b', toolUseId: null };
    const done = { ...card('vault_missing', { fields: [] }, '已完成卡'), id: 'c', state: 'completed' as const };
    renderCards([anchored, orphan, done], vi.fn(), [{ content: [{ type: 'tool_use', tool: { id: 'toolu_1' } }] }]);
    expect(screen.getByTestId('career-card-vault_missing')).toHaveTextContent('孤儿卡');
    expect(screen.queryByTestId('career-card-drafts')).not.toBeInTheDocument();
    expect(screen.queryByText(/已完成卡/)).not.toBeInTheDocument();
  });

  it('已处理的卡片折叠成一行；跳过的可以重新打开', () => {
    const onState = vi.fn();
    render(<CareerFlowCards cards={[
      { ...card('claims_confirm', { claims: [] }, '确认说法'), id: 'x', state: 'completed' },
      { ...card('vault_missing', { fields: [] }, '补齐资料'), id: 'y', state: 'dismissed' },
    ]} onStateChange={onState} />);
    expect(screen.getByTestId('career-card-collapsed-claims_confirm')).toHaveTextContent('已完成：确认说法');
    expect(screen.getByTestId('career-card-collapsed-vault_missing')).toHaveTextContent('已跳过：补齐资料');
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(onState).toHaveBeenCalledWith('y', 'pending');
  });

  it('collectToolUseIds 只收集顶层工具调用', () => {
    expect([...collectToolUseIds([{ content: 'text' }, { content: [{ type: 'text' }, { type: 'tool_use', tool: { id: 't1' } }, { type: 'server_tool_use', tool: { id: 't2' } }] }])]).toEqual(['t1', 't2']);
  });
});
