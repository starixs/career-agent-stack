/**
 * 预览里附件行的几样（第三轮 R1）：存过、还没附上的文件；作品集链接带没带；岗位描述要、这封还没带上的。
 * 「要」只对投递邮件算（跟进只附原来那份简历，回信由他自己加）。
 */
import type { Job } from '@career/core';

import type { MailDraftView, MailWanted } from '../../../shared/careerMailApply';
import { hasLine, isPortfolioFile, isTranscriptFile, portfolioLine, readMailProfile, wantsOf } from './compose';
import { fileOption, listMailFiles, type MailFile } from './files';
import type { MailResolveDeps, ResolvedMail } from './resolve';

type Extras = Pick<MailDraftView, 'file_options' | 'portfolio' | 'wanted'>;

/** 这封附上了哪些存过的文件。 */
const attachedFiles = (mail: Pick<ResolvedMail, 'attachments'>, files: readonly MailFile[]): MailFile[] =>
  files.filter(f => mail.attachments.some(a => a.kind === 'file' && a.file_id === f.id));

/** 岗位描述要、这封既没那一行也没对应附件的。 */
function wantedOf(mail: ResolvedMail, job: Job | undefined, attached: readonly MailFile[], portfolioIncluded: boolean): MailWanted[] {
  if ((mail.payload.purpose ?? 'apply') !== 'apply' || !job) return [];
  const wants = wantsOf(job.jd_raw);
  const out: MailWanted[] = [];
  if (wants.portfolio && !portfolioIncluded && !attached.some(isPortfolioFile)) out.push('portfolio');
  if (wants.transcript && !attached.some(isTranscriptFile)) out.push('transcript');
  return out;
}

export function extrasOf(deps: MailResolveDeps, mail: ResolvedMail, job: Job | undefined): Extras {
  const files = listMailFiles(deps.repos);
  const attached = attachedFiles(mail, files);
  const url = readMailProfile(deps.vault).profile.portfolio ?? null;
  const included = !!url && hasLine(mail.body, portfolioLine(url));
  return {
    file_options: files.filter(f => !attached.includes(f)).map(fileOption),
    portfolio: { url, included },
    wanted: wantedOf(mail, job, attached, included),
  };
}
