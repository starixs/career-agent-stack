/**
 * 回信 / 跟进不编造（不变量 8）：正文里事实底稿没有的数字换成「【待补：…】」，预览里 blockers 带 unresolved，他补上才能发。
 */
import { describe, expect, it } from 'vitest';

import { createMemoryRepos } from '../test-db';
import { guardNumbers } from './follow-drafter';
import { resolveMail } from './resolve';

describe('回信不编造', () => {
  const facts = '每周可实习：4 天；可连续实习：6 个月；最早到岗：随时；毕业时间：2027-06';

  it('事实里有的数字留着，没有的换成待补', () => {
    expect(guardNumbers('我每周可以实习4天，2027届。', facts)).toBe('我每周可以实习4天，2027届。');
    expect(guardNumbers('我可以连续实习8个月，12月3日到岗。', facts)).toBe('我可以连续实习【待补：核对「8」】个月，【待补：核对「12」】月【待补：核对「3」】日到岗。');
  });

  it('正文带待补的那封：blockers 带 unresolved；补上就没有', () => {
    const repos = createMemoryRepos();
    const account = repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    const base = { account_id: account.id, to: 'hr@jia.com', subject: 'Re: 关于实习', purpose: 'reply' };
    const gap = repos.enqueueAction('send_mail', { ...base, body: '我最早【待补：最早到岗日期】到岗。' });
    expect(resolveMail({ repos, vault: null }, gap).blockers).toEqual(['unresolved']);
    const done = repos.enqueueAction('send_mail', { ...base, body: '我最早下周一到岗。' });
    expect(resolveMail({ repos, vault: null }, done).blockers).toEqual([]);
  });
});
