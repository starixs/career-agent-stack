/**
 * 邮件投递前端的纯逻辑：跨边界校验（形状不对的丢掉、只记动作 id）、按钮字、能发出的封数。
 */
import { describe, expect, it, vi } from 'vitest';

import { actionLabels, mailFailedLabels, mailLabels } from '../delivery/askText';
import { parseAsks } from '../delivery/deliveryApi';
import { needsMailbox, sendableIds } from './mailActions';
import { parseDrafts } from './mailApplyApi';
import { mergeDrafts } from './useMailDrafts';
import { BLOCKED, bouncedAsk, failedMailAsk, MULTI, mailAsk, SINGLE } from './testFixtures';

describe('邮件预览的跨边界校验', () => {
  it('形状不对的那封丢掉，日志只带动作 id、不带邮件内容', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...SINGLE, action_id: 'm_bad', blockers: ['什么东西'] };
    expect(parseDrafts([SINGLE, broken]).map(d => d.action_id)).toEqual(['m_mt']);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('m_bad');
    expect(logged).not.toContain(SINGLE.to);
    expect(logged).not.toContain('您好');
    warn.mockRestore();
  });

  it('AskView.mail 形状不对：整件丢掉；对的留着', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = mailAsk([SINGLE]);
    const bad = { ...mailAsk(MULTI), id: 'bad', mail: { purpose: 'spam', action_ids: ['x'] } };
    expect(parseAsks([good, bad]).map(a => a.id)).toEqual([good.id]);
    warn.mockRestore();
  });

  it('改完一封：按 id 换掉那一封，顺序不变，列表外的不加进来', () => {
    const fresh = { ...MULTI[1], subject: '改过的标题' };
    const merged = mergeDrafts(MULTI, [fresh, BLOCKED]);
    expect(merged.map(d => d.action_id)).toEqual(['m_jd', 'm_mt', 'm_dj']);
    expect(merged[1].subject).toBe('改过的标题');
  });
});

describe('按钮字与能发出的封数', () => {
  it('投递一封「发出 · 不投这家」，几封「发出 n 封 · 先收起」；跟进「不跟了」，回信「我自己回」', () => {
    expect(mailLabels('apply', 1, 1)).toEqual({ go: '发出', later: '不投这家' });
    expect(mailLabels('apply', 2, 3)).toEqual({ go: '发出 2 封', later: '先收起' });
    expect(mailLabels('followup', 1, 1)).toEqual({ go: '发出', later: '不跟了' });
    expect(mailLabels('followup', 3, 3)).toEqual({ go: '发出 3 封', later: '先收起' });
    expect(mailLabels('reply', 1, 1)).toEqual({ go: '发出', later: '我自己回' });
  });

  it('退信重发「改好了，重发 · 不投这家」；邮件失败没有「我自己来」', () => {
    expect(actionLabels(bouncedAsk())).toEqual({ go: '改好了，重发', later: '不投这家' });
    expect(mailFailedLabels({ stage: 'draft', reauth: false })).toEqual({ go: '再写一次', later: '晚点' });
    expect(mailFailedLabels({ stage: 'send', reauth: false })).toEqual({ go: '再发一次', later: '晚点' });
    expect(actionLabels(failedMailAsk({ stage: 'send', reauth: true }))).toEqual({ go: '重新连邮箱', later: '晚点' });
  });

  it('AskView.mail_failed 形状不对：整件丢掉', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = failedMailAsk({ stage: 'send', reauth: true });
    const bad = { ...good, id: 'bad_fail', mail_failed: { stage: 'send' } };
    expect(parseAsks([good, bad]).map(a => a.id)).toEqual([good.id]);
    warn.mockRestore();
  });

  it('只算勾了且不差东西的；没连邮箱时先连邮箱', () => {
    const list = [MULTI[0], { ...MULTI[1], blockers: ['availability' as const] }, MULTI[2]];
    expect(sendableIds(list, new Set(['m_jd', 'm_mt']))).toEqual(['m_jd']);
    expect(needsMailbox(list)).toBe(false);
    expect(needsMailbox([BLOCKED])).toBe(true);
  });
});
