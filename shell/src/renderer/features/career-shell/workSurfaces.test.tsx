import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/career/careerApi', () => ({
  careerApi: {
    mockInterviews: vi.fn(async () => [{
      id: 'mok_1', job_id: null, resume_tailored_id: null, mode: 'probe', company_type: '大厂', round: '一面',
      turns_json: JSON.stringify([{ transcript: '问：讲讲你的毕业设计\n答：做了校园二手交易小程序' }]), report_json: null,
      created_at: '2026-10-09T01:00:00.000Z', updated_at: '2026-10-09T01:00:00.000Z',
    }]),
    examPractices: vi.fn(async () => []),
  },
}));
vi.mock('@/components/career/useGlobalLive', () => ({ useLiveStream: () => ({ status: 'open', detail: null }), globalBaseUrl: async () => '' }));
vi.mock('@/pages/CareerResume', () => ({ default: () => <div data-testid="resume-editor" /> }));

import type { ExamPractice } from '@/components/career/types';
import type { ToolUseSimple } from '@/types/chat';

import { MessageSurfaceCards } from './MessageSurfaceCards';
import { ExamSurfaceView, MockInterviewSurfacePanel, refIdForTool, surfaceForTool, WorkSurfaceCard } from './workSurfaces';
import { expandWorkSurface, resetWorkSurfaces, useWorkSurfaces } from './workSurfaceStore';

function tool(name: string, over: Partial<ToolUseSimple> = {}): ToolUseSimple {
  return { id: `tu_${name}`, name, input: {}, ...over } as ToolUseSimple;
}

describe('tool → work surface', () => {
  it('maps career tools (with or without the MCP prefix) to their surface', () => {
    expect(surfaceForTool('mcp__career__apply_run')).toBe('browser');
    expect(surfaceForTool('resume_tailor')).toBe('resume');
    expect(surfaceForTool('mcp__career__interview_probe')).toBe('mock-interview');
    expect(surfaceForTool('mcp__career__exam_practice')).toBe('exam');
    expect(surfaceForTool('mcp__career__today_queue')).toBeNull();
    expect(surfaceForTool(undefined)).toBeNull();
  });

  it('reads the object id from the tool result or input', () => {
    expect(refIdForTool('resume', tool('resume_tailor', { result: JSON.stringify({ tailored_id: 'rt_1' }) }))).toBe('rt_1');
    expect(refIdForTool('resume', tool('resume_save', { parsedInput: { resume_id: 'rm_2' } }))).toBe('rm_2');
    expect(refIdForTool('mock-interview', tool('interview_probe', { result: JSON.stringify({ mock_interview_id: 'mok_1' }) }))).toBe('mok_1');
    expect(refIdForTool('exam', tool('exam_practice', { result: JSON.stringify({ exam_id: 'exm_1' }) }))).toBe('exm_1');
  });
});

describe('collapsed cards', () => {
  beforeEach(() => resetWorkSurfaces());

  it('hangs one card under each work-surface tool call and ignores other tools', () => {
    render(
      <MessageSurfaceCards tools={[
        tool('mcp__career__today_queue'),
        tool('mcp__career__apply_run', { isLoading: true }),
        tool('mcp__career__exam_practice', { result: JSON.stringify({ exam_id: 'exm_1', status: 'answering', questions: 5, answered: 2 }) }),
      ]} />,
    );
    expect(screen.getByTestId('career-browser-card')).toHaveTextContent('浏览器');
    expect(screen.getByTestId('career-surface-card-exam')).toHaveTextContent('轮到你作答 · 已答 2 / 5');
    expect(screen.queryByTestId('career-surface-card-resume')).not.toBeInTheDocument();
  });

  it('a finished browser call shows 已完成 without the live view', () => {
    render(<MessageSurfaceCards tools={[tool('mcp__career__apply_run', { result: '{}' })]} />);
    expect(screen.getByTestId('career-browser-card')).toHaveTextContent('已完成 · 查看');
  });

  it('a waiting mock interview shows the question and opens its panel with it', () => {
    function Probe() { const { expanded, refId, context } = useWorkSurfaces(); return <div data-testid="probe">{`${expanded}|${refId}|${context}`}</div>; }
    render(
      <>
        <WorkSurfaceCard surface="mock-interview" tool={tool('interview_probe', { result: JSON.stringify({ mock_interview_id: 'mok_1', result: { question: '你在项目里砍掉了什么需求？' } }) })} />
        <Probe />
      </>,
    );
    const card = screen.getByTestId('career-surface-card-mock-interview');
    expect(card).toHaveTextContent('轮到你回答');
    expect(card).toHaveTextContent('你在项目里砍掉了什么需求？');
    fireEvent.click(screen.getByRole('button', { name: '打开模拟面试' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('mock-interview|mok_1|你在项目里砍掉了什么需求？');
    expect(screen.getByText('已在右侧打开 →')).toBeInTheDocument();
  });
});

describe('expanded panels', () => {
  beforeEach(() => resetWorkSurfaces());

  it('mock interview panel shows the handoff while a question waits for the user', async () => {
    act(() => expandWorkSurface('mock-interview', { refId: 'mok_1', context: '讲讲你的毕业设计' }));
    render(<MockInterviewSurfacePanel />);
    expect(screen.getByText('轮到你回答', { selector: 'div' })).toBeInTheDocument();
    expect(await screen.findByText(/做了校园二手交易小程序/)).toBeInTheDocument();
  });

  it('exam view lists questions with answers, verdicts and the summary', () => {
    const exam: ExamPractice = {
      id: 'exm_1', title: '星河科技 行测', company_name: '星河科技', job_id: null, kind: '行测',
      questions_json: JSON.stringify([{ q: '2, 4, 8, ?' }, { q: '甲比乙大 3 岁……', options: ['A. 5', 'B. 7'] }]),
      answers_json: JSON.stringify([{ index: 0, answer: '16' }, { index: 1, answer: 'A' }]),
      review_json: JSON.stringify([{ index: 0, verdict: '对' }, { index: 1, verdict: '错', comment: '漏了条件' }]),
      summary: '数量关系再练练', status: 'reviewed', created_at: '', updated_at: '',
    };
    render(<ExamSurfaceView exam={exam} loading={false} />);
    expect(screen.getByText('已批改 · 对 1 / 2')).toBeInTheDocument();
    expect(screen.getByText('你的作答：16')).toBeInTheDocument();
    expect(screen.getByText('漏了条件')).toBeInTheDocument();
    expect(screen.getByText('数量关系再练练')).toBeInTheDocument();
    expect(screen.queryByText('轮到你作答')).not.toBeInTheDocument();
  });
});
