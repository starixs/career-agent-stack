import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ usable: true }));
vi.mock('@/api/recording', () => ({
  speechModelPackStatus: vi.fn(async () => ({ usable: rec.usable })),
  recordingStart: vi.fn(async () => ({ snapshot: { recordId: 'r1', revision: 1 } })),
  recordingStop: vi.fn(async () => ({ recordId: 'r1', revision: 2 })),
  recordSpeechProjection: vi.fn(async () => ({ transcript: { state: 'recording_final', segments: [
    { segmentId: 'b', track: 'microphone', startSample: 20, endSample: 30, text: '投这几家' },
    { segmentId: 'a', track: 'microphone', startSample: 0, endSample: 10, text: '帮我' },
  ] }, diarization: null })),
}));
vi.mock('@/api/taskCenter', () => ({ recordDelete: vi.fn(async () => undefined) }));
import { recordDelete } from '@/api/taskCenter';
import { recordingStart } from '@/api/recording';

import { VoiceInputButton } from './VoiceInputButton';

describe('VoiceInputButton（2026-11-05 对话框只留语音输入）', () => {
  it('点一下开始、再点一下停：只录麦克风，按时间拼出文字交给输入框，临时录音删掉', async () => {
    const onText = vi.fn();
    render(<VoiceInputButton onText={onText} />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    const stop = await screen.findByRole('button', { name: '说完了' });
    expect(recordingStart).toHaveBeenCalledWith({ microphone: true, system: false });
    fireEvent.click(stop);
    await waitFor(() => expect(onText).toHaveBeenCalledWith('帮我投这几家'));
    await waitFor(() => expect(recordDelete).toHaveBeenCalledWith('r1'));
  });

  it('语音模型没装：直说去设置里装，不开麦克风', async () => {
    rec.usable = false;
    vi.mocked(recordingStart).mockClear();
    render(<VoiceInputButton onText={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('语音模型还没装好');
    expect(recordingStart).not.toHaveBeenCalled();
  });
});
