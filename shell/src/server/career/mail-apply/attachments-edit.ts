/**
 * 预览里改附件与作品集那一行（第三轮 R1；edit.ts 调）：
 *  - 附上一个存过的文件（总大小超过 MAIL_TOTAL_MAX_BYTES 拒绝并说原因）；拿掉一个附件（简历也能拿）；
 *  - 带 / 不带作品集那一行：正文里按这一整行精确增删（他手改过这行就找不到、不动）；
 *  - 填 / 改作品集链接：校验 http(s) → 存进基本资料（以后每封都用）→ 带进这封（换掉旧链接那一行）。
 * 简历附件的替换在 edit.ts 的 swapResume（要重新导 PDF、冻结材料包）。
 */
import { existsSync, statSync } from 'fs';

import { MAIL_TOTAL_MAX_BYTES } from '../../../shared/careerMailApply';
import { addLine, isWebUrl, portfolioLine, readMailProfile, removeLine } from './compose';
import { getMailFile } from './files';
import { attachmentsOf, fileAttachmentId, type SendMailPayload } from './payload';
import type { MailResolveDeps } from './resolve';

/** 改附件 / 作品集时不合格：路由回 409 带这句。 */
export class MailAttachmentError extends Error {}

/** 一个文件在盘上的大小；不在了算 0（发送时另有「附件文件不见了」那一关）。 */
export const sizeOnDisk = (path: string): number => (existsSync(path) ? statSync(path).size : 0);

/** 这封所有附件加起来多大。 */
export const totalSize = (p: Pick<SendMailPayload, 'attachments'>): number => attachmentsOf(p).reduce((n, a) => n + sizeOnDisk(a.path), 0);

/** 附上一个存过的文件；已经附上的不重复。 */
export function addFile(deps: MailResolveDeps, payload: SendMailPayload, fileId: string): SendMailPayload {
  const file = getMailFile(deps.repos, fileId);
  if (!file) throw new MailAttachmentError('这个文件已经不在了，重新加一次');
  const current = attachmentsOf(payload);
  if (current.some(a => a.kind === 'file' && a.file_id === fileId)) return payload;
  if (totalSize(payload) + file.size > MAIL_TOTAL_MAX_BYTES) throw new MailAttachmentError('附件加起来超过 20MB 了，换成链接更合适');
  return { ...payload, attachments: [...current, { id: fileAttachmentId(file.id), kind: 'file', file_id: file.id, path: file.path, filename: file.filename, sha256: file.sha256 }] };
}

/** 拿掉一个附件（简历也能拿）；没有这个 id 原样返回。 */
export function removeAttachment(payload: SendMailPayload, attachmentId: string): SendMailPayload {
  const current = attachmentsOf(payload);
  return current.some(a => a.id === attachmentId) ? { ...payload, attachments: current.filter(a => a.id !== attachmentId) } : payload;
}

/** 带 / 不带作品集那一行。要带但资料里还没有链接 → 说清楚（预览里会让他贴）。 */
export function togglePortfolio(deps: MailResolveDeps, payload: SendMailPayload, include: boolean): SendMailPayload {
  const url = readMailProfile(deps.vault).profile.portfolio;
  const line = payload.portfolio_line ?? (url ? portfolioLine(url) : undefined);
  if (!include) return line ? { ...payload, body: removeLine(payload.body, line) } : payload;
  if (!url) throw new MailAttachmentError('还没有作品集链接，先贴一个');
  const next = portfolioLine(url);
  const body = addLine(line && line !== next ? removeLine(payload.body, line) : payload.body, next, payload.arrival_line);
  return { ...payload, body, portfolio_line: next };
}

/** 填 / 改作品集链接：存进资料并带进这封。 */
export function setPortfolioUrl(deps: MailResolveDeps, payload: SendMailPayload, url: string): SendMailPayload {
  const clean = url.trim();
  if (!isWebUrl(clean)) throw new MailAttachmentError('这不像一个网址');
  if (!deps.vault) throw new MailAttachmentError('私密库没打开，链接存不了');
  deps.vault.set({ scope: 'profile', field: 'portfolio', value: clean, sensitive: false });
  console.log('[career] mail-apply portfolio url saved');
  return togglePortfolio(deps, payload, true);
}
