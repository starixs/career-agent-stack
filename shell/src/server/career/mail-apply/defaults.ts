/**
 * 写投递邮件时附件与作品集的默认（第三轮 R1；纯规则，不调模型）：
 *  - 岗位描述要作品集、资料里有链接 → 正文默认带「作品集：…」那一行；
 *  - 存过的文件里名字像作品集（要作品集时）/ 成绩单（要成绩单时）的 → 默认附上；附上后总大小不超过 MAIL_TOTAL_MAX_BYTES；
 *  - 要但没有的不在这里处理：预览的 wanted 会提示他加（extras.ts）。
 */
import { MAIL_TOTAL_MAX_BYTES } from '../../../shared/careerMailApply';
import { isPortfolioFile, isTranscriptFile, portfolioLine, wantsOf } from './compose';
import type { MailFile } from './files';

export interface MailDefaults {
  /** 正文里要带的作品集那一行；不带为 undefined。 */
  portfolioLine?: string;
  /** 默认附上的存过的文件。 */
  files: MailFile[];
}

export function mailDefaults(input: { jd: string | null | undefined; portfolioUrl: string | undefined; files: readonly MailFile[]; usedBytes: number }): MailDefaults {
  const wants = wantsOf(input.jd);
  const picks = input.files.filter(f => (wants.portfolio && isPortfolioFile(f)) || (wants.transcript && isTranscriptFile(f)));
  const files: MailFile[] = [];
  let used = input.usedBytes;
  for (const f of picks) {
    if (used + f.size > MAIL_TOTAL_MAX_BYTES) continue;
    files.push(f);
    used += f.size;
  }
  return { ...(wants.portfolio && input.portfolioUrl ? { portfolioLine: portfolioLine(input.portfolioUrl) } : {}), files };
}
