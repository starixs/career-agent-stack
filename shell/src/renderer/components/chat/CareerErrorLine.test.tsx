import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { CareerErrorLine, careerTerminalReasonDetail } from './CareerErrorLine';
import { dropZoneCopy } from './careerChatCopy';

describe('career chat copy', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });
  afterEach(() => vi.restoreAllMocks());

  it('drop overlay hands the resume to 小芽 and never mentions keystone_files', () => {
    const copy = dropZoneCopy(i18n.getFixedT('zh-CN', 'chat'));
    expect(copy).toEqual({ message: '松手，把简历交给小芽' });
    expect(JSON.stringify(dropZoneCopy(i18n.getFixedT('zh-CN', 'chat'), false))).toContain('keystone_files');
  });

  it('error line shows one human sentence and keeps the raw error only in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onRetry = vi.fn();
    render(<CareerErrorLine detail="API Error: 529 overloaded_error" onRetry={onRetry} onDismiss={vi.fn()} />);

    const line = screen.getByTestId('career-error-line');
    expect(line).toHaveTextContent('这一步没做成。');
    expect(line).not.toHaveTextContent(/API|529|SDK/);
    expect(warn).toHaveBeenCalledWith('[chat] career-error-line shown', 'API Error: 529 overloaded_error');
    fireEvent.click(screen.getByRole('button', { name: /我再试一次/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('terminal reasons: user stops and normal endings stay silent, failures get the line', () => {
    expect(careerTerminalReasonDetail(null)).toBeNull();
    expect(careerTerminalReasonDetail('completed')).toBeNull();
    expect(careerTerminalReasonDetail('aborted_streaming')).toBeNull();
    expect(careerTerminalReasonDetail('background_requested')).toBeNull();
    expect(careerTerminalReasonDetail('api_error')).toContain('terminal_reason=api_error');
  });
});
