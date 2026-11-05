/**
 * 求职壳的对话文案用学生的话（beta-polish ③⑤）：拖文件提示不提 keystone_files，报错只说一句人话、
 * 细节进日志（见 CareerErrorLine）。keystone 通用文案保留在 false 分支。
 */
import type { TFunction } from 'i18next';

export const CAREER_PLAIN_COPY = true;

export interface DropZoneCopy {
  message: string;
  subtitle?: string;
}

/** 拖文件进对话时的遮罩文案。 */
export function dropZoneCopy(t: TFunction<'chat'>, career: boolean = CAREER_PLAIN_COPY): DropZoneCopy {
  if (career) return { message: t('shell.career.dropZone') };
  return { message: t('shell.dropZone.message'), subtitle: t('shell.dropZone.subtitle') };
}
