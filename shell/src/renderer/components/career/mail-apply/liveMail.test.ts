/**
 * 邮件申请在进展页与申请对象卡上的样子（P2.8）：哪些申请走邮件、走到哪一步、对象卡那条路多出的几节。
 */
import { describe, expect, it } from 'vitest';

import { applicationTrack } from '../delivery/applicationTrack';
import type { Application, Dossier, Job, MailMessage } from '../types';
import { isMailApplication, mailApplicationsOf, mailSteps, mailTrackNodes, pendingApplyMail } from './liveMail';
import { bouncedAsk, BOUNCED, mailAsk, REPLY, SINGLE, THREAD } from './testFixtures';

const app = (over: Partial<Application>): Application => ({
  id: 'a1', job_id: 'j1', resume_tailored_id: null, stage: 'pending', next_action: null, next_action_due: null, blocker_reason: null,
  retry_strategy: null, submission_evidence: null, answers_used_json: '[]', page_url: null,
  created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...over,
});

const mail = (over: Partial<MailMessage> & Pick<MailMessage, 'id' | 'direction'>): MailMessage => ({
  account_id: 'acc', uid: null, message_id: null, in_reply_to: null, from_addr: null, to_addr: null, subject: null, snippet: null,
  body_text: null, received_at: '2026-11-01T00:00:00.000Z', relevance: 'job', kind: null, inbox_item_id: null, application_id: 'a1',
  action_id: null, created_at: '2026-11-01T00:00:00.000Z', ...over,
});

describe('哪些申请走邮件', () => {
  it('岗位有投递邮箱，或投递凭据是邮件的', () => {
    expect(isMailApplication({ submission_evidence: null, apply_email: 'hr@x.cn' })).toBe(true);
    expect(isMailApplication({ submission_evidence: 'mail:mm_1' })).toBe(true);
    expect(isMailApplication({ submission_evidence: 'https://x.cn/done' })).toBe(false);
  });

  it('列表：只留邮件的、没关掉的，最近动过的在前', () => {
    const list = mailApplicationsOf([
      app({ id: 'web', submission_evidence: 'https://x' }),
      app({ id: 'old', apply_email: 'a@x.cn', updated_at: '2026-11-01T00:00:00.000Z' }),
      app({ id: 'new', apply_email: 'b@x.cn', updated_at: '2026-11-04T00:00:00.000Z' }),
      app({ id: 'skip', apply_email: 'c@x.cn', stage: 'skip' }),
    ]);
    expect(list.map(a => a.id)).toEqual(['new', 'old']);
  });
});

describe('走到哪一步：定制简历 → 写邮件 → 等你过目 → 已发出', () => {
  const state = (nodes: ReturnType<typeof mailSteps>) => nodes.map(n => (n.ask ? 'ask' : n.on ? 'on' : '-')).join(' ');

  it('还在写：定制过的那一节是墨色，其余灰', () => {
    expect(state(mailSteps(app({ resume_tailored_id: 'r1' }), { ...THREAD, items: [] }))).toBe('on - - -');
  });

  it('写好了等你：等你过目那节钢笔蓝，右侧给的是那封待发的', () => {
    const pending = { ...THREAD, items: [{ ...THREAD.items[3], purpose: 'apply' as const, action_id: 'm_new' }] };
    expect(state(mailSteps(app({}), pending))).toBe('on on ask -');
    expect(pendingApplyMail(pending)).toBe('m_new');
  });

  it('发出去了：四节都是墨色；回信待发不算投递邮件待发', () => {
    expect(state(mailSteps(app({ stage: 'applied' }), THREAD))).toBe('on on on on');
    expect(pendingApplyMail(THREAD)).toBeNull();
  });
});

describe('申请对象卡那条路', () => {
  const sent = mail({ id: 'o1', direction: 'out', message_id: '<o1@me>', received_at: '2026-10-29T02:00:00.000Z' });
  const auto = mail({ id: 'i0', direction: 'in', kind: 'application_received', received_at: '2026-10-29T02:01:00.000Z' });
  const follow = mail({ id: 'o2', direction: 'out', in_reply_to: '<o1@me>', received_at: '2026-11-05T02:00:00.000Z' });
  const reply = mail({ id: 'i1', direction: 'in', received_at: '2026-11-06T02:00:00.000Z' });

  it('跟进发出、对方回信各一节，自动回复不算回音', () => {
    expect(mailTrackNodes([sent, auto, follow, reply]).map(n => n.label)).toEqual(['跟进', '回信']);
  });

  const job: Job = {
    id: 'j1', source_platform: 'manual', source_job_id: null, url: null, company_id: null, company_name: '京东', title: '用户运营实习生',
    location: null, salary: null, jd_raw: null, jd_parsed_json: null, prefilter_json: null, score_json: null, deadline: null,
    deadline_verified_at: null, created_at: '', updated_at: '', apply_email: 'hr@x.cn',
  };
  const dossier = (over: Partial<Dossier['application']>, mails: MailMessage[]) => ({
    application: app(over), job, mails,
    history: [{ from_stage: 'pending', to_stage: 'applied', note: null, created_at: '2026-10-29T02:00:00.000Z' }], deadlines: [],
  });

  it('邮件申请第一节叫「邮件发出」，后面接跟进 / 回信，再等回音', () => {
    const nodes = applicationTrack(dossier({ stage: 'applied', submission_evidence: 'mail:o1' }, [sent, follow]), []);
    expect(nodes.map(n => n.label)).toEqual(['邮件发出', '跟进', '等回音']);
    expect(nodes[0].on).toBe(true);
  });

  it('回信写好了等你：多一节钢笔蓝「回信」，key 是那件事的来源（点了定位卡组）', () => {
    const nodes = applicationTrack(dossier({ stage: 'responded', submission_evidence: 'mail:o1' }, [sent, reply]), [mailAsk([REPLY], '京东 回信了')]);
    expect(nodes.map(n => `${n.label}${n.ask ? '*' : ''}`)).toEqual(['邮件发出', '回信', '回信*']);
    expect(nodes[2].key).toBe('m_re');
  });

  it('投递邮件还没发：第一节就是等你的那节；退回来的是「重发」', () => {
    const waiting = applicationTrack({ ...dossier({ stage: 'pending' }, []), history: [] }, [mailAsk([SINGLE])]);
    expect(waiting[0]).toMatchObject({ label: '邮件发出', ask: true, key: SINGLE.action_id });
    const bounced = applicationTrack({ ...dossier({ stage: 'pending' }, []), history: [] }, [bouncedAsk(BOUNCED)]);
    expect(bounced.map(n => `${n.label}${n.ask ? '*' : ''}`)).toEqual(['邮件发出', '重发*']);
  });
});
