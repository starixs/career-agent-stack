/**
 * 盖章提议的字（信任账本）：网申是「某类网申系统以后直接投」，邮件投递那一类读作「以后直接发」。
 * 勾选表顶上和右栏「学会了」共用这一份，不各写一遍。
 */
import { MAIL_TRUST_KEY, MAIL_TRUST_LABEL } from '../../../shared/careerMailApply';

interface TrustLike { key: string; label: string; successes: number }

const isMail = (e: Pick<TrustLike, 'key'>) => e.key === MAIL_TRUST_KEY;

/** 勾选表上问一次：「北森这类你看过 3 份了，以后直接投？」/「邮件投递 · 以后直接发？」 */
export const delegateQuestion = (e: TrustLike): string =>
  (isMail(e) ? `${MAIL_TRUST_LABEL} · 以后直接发？` : `${e.label}这类你看过 ${e.successes} 份了，以后直接投？`);

/** 点了「好」之后那一句。 */
export const delegateDone = (e: TrustLike): string =>
  (isMail(e) ? `好，${MAIL_TRUST_LABEL}以后直接发` : `好，${e.label}这类以后直接投`);

/** 右栏「学会了」上的盖章按钮。 */
export const delegateButton = (e: Pick<TrustLike, 'key'>): string => (isMail(e) ? '以后直接发' : '以后同类直接投');
