/**
 * 面试录音：用户自己录的一段面试（或面经口述），上传后挂在那场面试上，等语音识别转成文字再复盘。
 *
 * 语音识别还没接：上传只落盘、记一条「等待转写」。接上以后由 transcribe 把文字交给 interview_retro。
 * 录音是用户材料：文件只在本机数据目录，元数据记在 kv（不加表，避免和并行开发的迁移撞版本号），日志不打内容。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { Repos } from '@career/core';

export const RECORDINGS_KEY = 'career.interview_recordings';
/** 单个录音上限：一小时 64kbps 的 m4a 约 29MB，留到 50MB；走 JSON base64，再大就该改成数据面直传。 */
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.webm', '.flac', '.amr', '.mp4']);

export type RecordingStatus = 'awaiting_asr' | 'transcribed' | 'failed';
export interface InterviewRecording {
  id: string; interview_id: string; name: string; mime: string | null; size: number; path: string;
  status: RecordingStatus; uploaded_at: string; transcript_chars?: number; error?: string;
}

type RecordingMap = Record<string, InterviewRecording[]>;

function readAll(repos: Repos): RecordingMap {
  const raw = repos.kvGet<unknown>(RECORDINGS_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as RecordingMap : {};
}

export function listRecordings(repos: Repos, interviewId: string): InterviewRecording[] {
  return readAll(repos)[interviewId] ?? [];
}

export function isAudioFile(name: string, mime?: string | null): boolean {
  return (mime ?? '').startsWith('audio/') || AUDIO_EXTENSIONS.has(extname(name).toLowerCase());
}

/** 把一段录音存到本机并挂到面试上；返回这条录音（状态：等待转写）。 */
export async function saveRecording(
  repos: Repos, dir: string,
  input: { interview_id: string; name: string; mime?: string | null; data_base64: string },
  now: () => string = () => new Date().toISOString(),
): Promise<InterviewRecording> {
  if (!isAudioFile(input.name, input.mime)) throw new Error(`不是音频文件：${input.name}`);
  const bytes = Buffer.from(input.data_base64, 'base64');
  if (!bytes.length) throw new Error(`录音是空的：${input.name}`);
  if (bytes.length > MAX_RECORDING_BYTES) throw new Error(`录音超过 ${MAX_RECORDING_BYTES / 1024 / 1024}MB：${input.name}`);
  const id = `rec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}${extname(input.name).toLowerCase() || '.audio'}`);
  await writeFile(path, bytes);
  const rec: InterviewRecording = { id, interview_id: input.interview_id, name: input.name, mime: input.mime ?? null, size: bytes.length, path, status: 'awaiting_asr', uploaded_at: now() };
  const all = readAll(repos);
  all[input.interview_id] = [...(all[input.interview_id] ?? []), rec];
  repos.kvSet(RECORDINGS_KEY, all);
  console.info(`[career] recording saved interview=${input.interview_id} id=${id} bytes=${bytes.length}`);
  return rec;
}

/** 语音识别接口：接上后返回转写文字。现在没有实现，返回 null 表示「还不能转写」，录音保持等待状态。 */
export type Transcriber = (rec: InterviewRecording) => Promise<string | null>;
export const noTranscriber: Transcriber = async () => null;
