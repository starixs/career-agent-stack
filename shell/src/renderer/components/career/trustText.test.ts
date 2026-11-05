/**
 * 盖章提议的字（R2）：邮件投递那一类读作「以后直接发」，网申系统照旧「以后直接投」。
 */
import { describe, expect, it } from 'vitest';

import { MAIL_TRUST_KEY, MAIL_TRUST_LABEL } from '../../../shared/careerMailApply';
import { delegateButton, delegateDone, delegateQuestion } from './trustText';

describe('盖章提议的字', () => {
  const mail = { key: MAIL_TRUST_KEY, label: MAIL_TRUST_LABEL, successes: 2 };
  const beisen = { key: 'system:beisen', label: '北森', successes: 3 };

  it('邮件投递：以后直接发', () => {
    expect(delegateQuestion(mail)).toBe('邮件投递 · 以后直接发？');
    expect(delegateDone(mail)).toBe('好，邮件投递以后直接发');
    expect(delegateButton(mail)).toBe('以后直接发');
  });

  it('网申系统：字不变', () => {
    expect(delegateQuestion(beisen)).toBe('北森这类你看过 3 份了，以后直接投？');
    expect(delegateDone(beisen)).toBe('好，北森这类以后直接投');
    expect(delegateButton(beisen)).toBe('以后同类直接投');
  });
});
