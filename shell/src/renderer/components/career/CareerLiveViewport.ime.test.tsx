import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./careerApi', () => ({ careerApi: { liveInput: vi.fn(async () => ({})) } }));

import { careerApi } from './careerApi';
import { CareerLiveViewport } from './CareerLiveViewport';

const frame = { type: 'frame' as const, data: 'AAAA', width: 1280, height: 800, ts: 1 };
const sentTypes = () => vi.mocked(careerApi.liveInput).mock.calls.map(c => c[0]);

describe('接管时在画面里打中文（2026-11-05 现场窗交互）', () => {
  beforeEach(() => { vi.mocked(careerApi.liveInput).mockClear(); });

  it('输入法拼字时不发拼音字母，上屏后发汉字', async () => {
    render(<CareerLiveViewport frame={frame} interactive />);
    const ime = screen.getByTestId('live-ime') as HTMLTextAreaElement;
    fireEvent.compositionStart(ime);
    fireEvent.keyDown(ime, { key: 'Process' });
    ime.value = 'zhou';
    fireEvent.input(ime);
    expect(careerApi.liveInput).not.toHaveBeenCalled();
    ime.value = '周';
    fireEvent.compositionEnd(ime, { data: '周' });
    await waitFor(() => expect(sentTypes()).toEqual([{ type: 'type', text: '周' }]));
    expect(ime.value).toBe('');
  });

  it('普通字符走输入框的 input 事件，回车等功能键照旧按键发', async () => {
    render(<CareerLiveViewport frame={frame} interactive />);
    const ime = screen.getByTestId('live-ime') as HTMLTextAreaElement;
    fireEvent.keyDown(ime, { key: 'a' });
    ime.value = 'a';
    fireEvent.input(ime);
    fireEvent.keyDown(ime, { key: 'Enter' });
    await waitFor(() => expect(sentTypes()).toEqual([{ type: 'type', text: 'a' }, { type: 'press', key: 'Enter' }]));
  });
});
