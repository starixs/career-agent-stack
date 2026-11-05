/**
 * 他存过、能当邮件附件的文件（作品集、成绩单、证书…；第三轮 R1）：存一次，以后每封都能点一下附上（立场「能做一次就不再做」）。
 *  - 文件落在 `<数据目录>/mail-files/<sha256>.<ext>`；清单存 kv `mail:files`（不做数据库迁移）。
 *  - 校验：扩展名在 MAIL_FILE_EXTENSIONS、大小 ≤ MAIL_FILE_MAX_BYTES、文件名去掉路径分隔符；同一内容（sha 相同）再存不重复。
 *  - 不进模型；日志只记 id 和大小。
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repos } from '@career/core';
import { z } from 'zod';

import { MAIL_FILE_EXTENSIONS, MAIL_FILE_MAX_BYTES, type MailFileOption } from '../../../shared/careerMailApply';

export const MAIL_FILES_KEY = 'mail:files';

const MailFileSchema = z.object({
  id: z.string(), label: z.string(), filename: z.string(), path: z.string(), sha256: z.string(), size: z.number(), added_at: z.string(),
});
export type MailFile = z.infer<typeof MailFileSchema>;

/** 存不了的文件：路由回 4xx 带这句给人看的话。 */
export class MailFileError extends Error {}

/** 清单（坏的条目丢掉并记一笔，不让一条坏数据挡住全部）。 */
export function listMailFiles(repos: Repos): MailFile[] {
  const raw = repos.kvGet<unknown>(MAIL_FILES_KEY);
  if (!Array.isArray(raw)) return [];
  const out: MailFile[] = [];
  for (const item of raw) {
    const parsed = MailFileSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[career] mail-files bad entry dropped: ${parsed.error.issues.map(i => i.path.join('.')).join(',')}`);
  }
  return out;
}

export const getMailFile = (repos: Repos, id: string): MailFile | undefined => listMailFiles(repos).find(f => f.id === id);
export const fileOption = (f: MailFile): MailFileOption => ({ id: f.id, label: f.label });

/** 文件名只留最后一段、去掉文件系统不认的字符。 */
export function cleanFilename(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  // 控制字符（码点 < 32）按码点去，不写进正则
  return [...last].filter(ch => ch.charCodeAt(0) >= 32 && !':*?"<>|'.includes(ch)).join('').trim();
}

const extOf = (name: string): string => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();
const isAllowedExt = (ext: string): boolean => (MAIL_FILE_EXTENSIONS as readonly string[]).includes(ext);

/** 校验并解出文件内容；不合格抛 MailFileError（给人看的一句）。 */
function decodeUpload(input: { name: string; base64: string }): { filename: string; ext: string; bytes: Buffer } {
  const filename = cleanFilename(input.name);
  const ext = extOf(filename);
  if (!filename || !isAllowedExt(ext)) throw new MailFileError('这种文件发不了，换成 PDF、Word、PPT、图片或压缩包');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length) throw new MailFileError('这个文件是空的');
  if (bytes.length > MAIL_FILE_MAX_BYTES) throw new MailFileError('文件超过 10MB，换成链接更合适');
  return { filename, ext, bytes };
}

/** 存一个文件（同一内容只存一份）；返回清单里的那一项。 */
export function saveMailFile(repos: Repos, dir: string, input: { name: string; base64: string; label?: string }): MailFile {
  const { filename, ext, bytes } = decodeUpload(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = listMailFiles(repos);
  const same = files.find(f => f.sha256 === sha256);
  if (same) return same;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256}.${ext}`);
  if (!existsSync(path)) writeFileSync(path, bytes);
  const file: MailFile = {
    id: `mf_${sha256.slice(0, 16)}`, label: input.label?.trim() || filename.replace(/\.[^.]+$/, ''), filename, path, sha256, size: bytes.length, added_at: new Date().toISOString(),
  };
  repos.kvSet(MAIL_FILES_KEY, [...files, file]);
  console.log(`[career] mail-files saved id=${file.id} size=${file.size}`);
  return file;
}
