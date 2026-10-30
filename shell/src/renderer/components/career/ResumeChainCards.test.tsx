import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiPostJson, apiPutJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';

import { RESUME_DRAWER_EVENT } from './CareerResumeDrawer';
import { ResumeIntakeCard, TailorDiffCard } from './ResumeChainCards';
import type { CareerCard } from './types';

const card = (kind: CareerCard['kind'], data: Record<string, unknown>, title = '卡片'): CareerCard => ({ id: `${kind}:1`, kind, title, data, createdAt: '2026-10-30T00:00:00Z' });

const INTAKE = card('resume_intake', {
  intake_id: 'rin_1',
  profile: [{ field: 'name', label: '真实姓名', preview: '张**' }, { field: 'phone', label: '手机号', preview: '138****5678' }],
  missing: [{ field: 'graduation', label: '毕业时间', hint: '如 2026-06', sensitive: false }],
  education: [{ school: '北京大学', degree: '硕士', major: '计算机', start: '2024.09', end: '2027.06' }],
  experiences: [{ id: 'exp_1', title: '美团 · 数据分析实习生', start: '2025-06', end: '2025-09', claims: [{ id: 'c1', text: '搭建日报看板' }, { id: 'c2', text: '参与用户分层模型' }] }],
}, '从你的简历里读到这些');

describe('交简历 → 定制 · 对话里的两张卡', () => {
  beforeEach(() => {
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true, master_id: 'rsm_1' });
    vi.mocked(apiPutJson).mockReset().mockResolvedValue({ ok: true, item: {} });
  });

  it('读到的简历：预填好、说法默认全勾，去掉一条后「只用所选」生成主简历，卡片原地换成下一步，不往对话里发话', async () => {
    const drawer: unknown[] = [];
    const offDrawer = onEvent(RESUME_DRAWER_EVENT, p => { drawer.push(p); });
    const suggested: string[] = [];
    const offSuggest = onEvent<{ text: string }>('career:chat-suggest', p => { suggested.push(p.text); });
    const onDone = vi.fn();
    render(<ResumeIntakeCard card={INTAKE} onDone={onDone} onDismiss={vi.fn()} />);

    expect(screen.getByText('138****5678')).toBeInTheDocument();
    expect(screen.getByText('北京大学 · 硕士 · 计算机 · 2024.09 – 2027.06')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '搭建日报看板' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.pointerDown(screen.getByRole('checkbox', { name: '参与用户分层模型' }));
    fireEvent.change(screen.getByLabelText('毕业时间'), { target: { value: '2027-06' } });
    fireEvent.click(screen.getByRole('button', { name: '只用所选 1 条' }));

    await waitFor(() => expect(screen.getByTestId('career-card-resume_intake-done')).toBeInTheDocument());
    expect(apiPutJson).toHaveBeenCalledWith(expect.stringContaining('/vault/items'), expect.objectContaining({ scope: 'profile', field: 'graduation', value: '2027-06' }));
    expect(apiPostJson).toHaveBeenCalledWith(expect.stringContaining('/resume-intake/rin_1/confirm'), { claim_ids: ['c1'], profile_choice: {} });
    expect(drawer).toEqual([expect.objectContaining({ open: true, resumeId: 'rsm_1' })]);
    expect(suggested).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '去岗位库挑一个' })).toBeInTheDocument();
    offDrawer(); offSuggest();
  });

  it('生成后：口述建的旧经历留着、给一键清掉，点了才删', async () => {
    vi.mocked(apiPostJson).mockResolvedValueOnce({ ok: true, master_id: 'rsm_1', oral: 2 }).mockResolvedValueOnce({ ok: true, cleared: 2 });
    render(<ResumeIntakeCard card={INTAKE} onDone={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '全部通过，生成主简历' }));
    await waitFor(() => expect(screen.getByTestId('intake-oral')).toHaveTextContent('还有 2 段之前口述的经历'));
    fireEvent.click(screen.getByRole('button', { name: '清掉这些' }));
    await waitFor(() => expect(screen.queryByTestId('intake-oral')).toBeNull());
    expect(apiPostJson).toHaveBeenLastCalledWith(expect.stringContaining('/resume-intake/rin_1/clear-oral'), {});
  });

  it('读到的简历：不挑的话表头「全部通过」一下就生成', async () => {
    render(<ResumeIntakeCard card={INTAKE} onDone={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /只用所选/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部通过，生成主简历' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(expect.stringContaining('/resume-intake/rin_1/confirm'), { claim_ids: ['c1', 'c2'], profile_choice: {} }));
  });

  it('简历和资料对不上：并排一张表，整列一键「保留资料里的」，个别行再改回简历', async () => {
    const c = card('resume_intake', { ...INTAKE.data, conflicts: [
      { field: 'name', label: '真实姓名', resume_preview: '闫**', vault_preview: '林**' },
      { field: 'school', label: '毕业院校', resume_preview: '河南大学', vault_preview: '华东某大学' },
    ] }, '从你的简历里读到这些');
    render(<ResumeIntakeCard card={c} onDone={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('intake-conflicts')).toHaveTextContent('有 2 项不一样');
    expect(screen.getByLabelText('真实姓名：用简历上的')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '全部保留资料里的' }));
    fireEvent.click(screen.getByLabelText('毕业院校：用简历上的'));
    fireEvent.click(screen.getByRole('button', { name: '全部通过，生成主简历' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(expect.stringContaining('/confirm'), { claim_ids: ['c1', 'c2'], profile_choice: { name: 'vault', school: 'resume' } }));
  });

  it('改了什么：逐处原文划掉、新文在下，岗位要但经历里没有的单列，打开整份', () => {
    const drawer: unknown[] = [];
    const off = onEvent(RESUME_DRAWER_EVENT, p => { drawer.push(p); });
    render(<TailorDiffCard card={card('tailor_diff', {
      tailored_id: 'rst_1', total: 1, needs: ['JD 要 Tableau，经历里没提到'],
      changes: [{ op: 'replace', place: '实习 / 工作 · 美团 · 第 2 条', before: '负责 AB 实验分析', after: '主导 12 个策略的 AB 实验分析', reason: '贴近职责第 2 条', jd: ['AB 实验'] }],
      blocked: [{ place: '实习 / 工作 · 美团', after: '用 Kafka 搭建看板', why: '出现了没有依据的内容：Kafka' }],
    }, '为「京东 · 数据分析师」定制好了')} onDone={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('改了 1 处')).toBeInTheDocument();
    expect(screen.getByText('负责 AB 实验分析')).toHaveClass('line-through');
    expect(screen.getByText('主导 12 个策略的 AB 实验分析')).toBeInTheDocument();
    expect(screen.getByText('JD 要 Tableau，经历里没提到')).toBeInTheDocument();
    expect(screen.getByText(/对上 JD：AB 实验/)).toBeInTheDocument();
    expect(screen.getByTestId('tailor-blocked')).toHaveTextContent('拦下了 1 处没依据的改动');
    fireEvent.click(screen.getByRole('button', { name: '打开整份' }));
    expect(drawer).toEqual([expect.objectContaining({ resumeId: 'rst_1' })]);
    off();
  });
});
