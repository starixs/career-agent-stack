import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiPostJson: vi.fn(async () => ({ ok: true })) }));

import { apiPostJson } from '@/api/apiFetch';

import { SmsCodeBar } from './SmsCodeBar';

describe('登录之旅里的验证码一格（2026-11-03 他只管收验证码）', () => {
  it('已发码：说是哪一家，填收到的码点登录；这家没有短信登录就不出现', async () => {
    const { rerender } = render(<SmsCodeBar sms={null} />);
    expect(screen.queryByTestId('sms-code-bar')).not.toBeInTheDocument();
    rerender(<SmsCodeBar sms={{ status: 'no_sms', detail: '要扫码登录', site: '北森' }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^北森：要扫码登录$/);
    rerender(<SmsCodeBar sms={{ status: 'sent', site: '美团' }} />);
    expect(screen.getByText('美团：验证码已发到手机')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('短信验证码'), { target: { value: '12 34 56' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/sms-code', { code: '123456' }));
  });

  it('点获取验证码弹了拼图：告诉他先在画面上拖一下，码照样填这里', () => {
    render(<SmsCodeBar sms={{ status: 'captcha', detail: '向右拖动滑块填充拼图', site: '小米' }} />);
    expect(screen.getByText('小米：先在画面上拖拼图')).toBeInTheDocument();
  });

  it('走邮箱登录弹了拼图：只请他拖，码从邮箱自己取，不给填码的格子（2026-11-03 畅游）', () => {
    render(<SmsCodeBar sms={{ status: 'mail_captcha', site: '畅游' }} />);
    expect(screen.getByText('畅游：在画面上拖一下拼图')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('图看不清：点那张图，网站上换一张（2026-11-03 CAS-7）', async () => {
    render(<SmsCodeBar sms={{ status: 'image_code', image: 'data:image/png;base64,AAAA', site: '中国中车' }} />);
    fireEvent.click(screen.getByRole('button', { name: '换一张图形验证码' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/image-refresh', {}));
  });

  it('网站弹了图形码：图放在这一格，他照着打字回车，字交给替他确认的那一步（2026-11-03 中国中车）', async () => {
    render(<SmsCodeBar sms={{ status: 'image_code', image: 'data:image/png;base64,AAAA', site: '中国中车' }} />);
    expect(screen.getByText('中国中车：输入图上的字')).toBeInTheDocument();
    expect(screen.getByAltText('网站给的图形验证码')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    fireEvent.change(screen.getByLabelText('图上的字'), { target: { value: 'K7 m-P' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/sms-code', { code: 'K7mP' }));
  });

  it('反馈：填上后说「已填进 X、正在确认」，往下每一步说一步，打错了直说，登上了说「X 已登录」（2026-11-03「好像弄了白弄」）', () => {
    const { rerender } = render(<SmsCodeBar sms={{ status: 'checking', detail: 'image', site: '中国中车' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('已填进中国中车，正在确认登录…');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    rerender(<SmsCodeBar sms={{ status: 'image_code', detail: '上一张没对上，换了一张', site: '中国中车' }} />);
    expect(screen.getByText('中国中车：上一张没对上，换了一张')).toBeInTheDocument();
    rerender(<SmsCodeBar sms={{ status: 'registering', detail: '图上的字对了，验证码已经发到 a@163.com，正在取', site: '中国中车' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('中国中车：图上的字对了，验证码已经发到 a@163.com，正在取');
    rerender(<SmsCodeBar sms={{ status: 'checking', detail: 'sms', site: '美团' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('已填进美团，正在确认登录…');
    rerender(<SmsCodeBar sms={{ status: 'logged_in', site: '中国中车' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('中国中车已登录');
  });
});
