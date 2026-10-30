/**
 * 缺信息填一次（career/ask-fill.ts）：整批放行；还有只能在页面上看的项时不放行，接管留着。
 */
import { describe, expect, it } from 'vitest';
import { StaticKeyProvider, Vault, type Repos } from '@career/core';

import { AskFillError, fillAsk } from './ask-fill';
import { BATCH_COMMAND_KEY } from './batch-runner';
import { createMemoryRepos } from './test-db';

const NOW = '2026-10-28T01:00:00.000Z';
const vaultOf = (repos: Repos) => new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7)));

function stuck(repos: Repos, company: string, gaps: Array<{ label: string; key?: string; status?: string }>) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '后端', company_name: company });
  const app = repos.createApplication(job.id);
  const a = repos.enqueueAction('fill_form', {}, app.id, true);
  const h = repos.openHandoff('missing_info', { actionId: a.id });
  repos.setActionStatus(a.id, 'needs_user', {
    needsUser: gaps.map(g => ({ label: g.label, key: g.key })),
    gate: { gaps: gaps.map(g => ({ label: g.label, status: g.status ?? 'needs_user', required: true })) },
  });
  return { action: a, handoff: h };
}

describe('缺信息填一次', () => {
  it('资料字段进私密库、其余进答案库；整批接管关掉，交给后台接着填', () => {
    const repos = createMemoryRepos();
    const vault = vaultOf(repos);
    const rows = ['甲', '乙', '丙'].map(c => stuck(repos, c, [{ label: '证件号码', key: 'idNumber' }, { label: '期望薪资' }]));
    const out = fillAsk(repos, vault, rows[0].handoff.id, { 证件号码: '110101200001011234', 期望薪资: '面议' }, NOW);
    expect(out.resumed.sort()).toEqual(rows.map(r => r.action.id).sort());
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(repos.kvGet<{ cmd: string }>(BATCH_COMMAND_KEY)?.cmd).toBe('run');
    expect(vault.list('profile').map(i => i.field)).toContain('idNumber');
    expect(repos.findAnswer('期望薪资')?.answer).toBe('面议');
  });

  it('还有要去页面上看的项（附件没回显）：值先存下，但不放行，接管留着', () => {
    const repos = createMemoryRepos();
    const { handoff } = stuck(repos, '甲', [{ label: '证件号码', key: 'idNumber' }, { label: '简历附件', status: 'upload_unconfirmed' }]);
    const out = fillAsk(repos, vaultOf(repos), handoff.id, { 证件号码: '110101200001011234' }, NOW);
    expect(out).toMatchObject({ resumed: [], still_waiting: 1 });
    expect(repos.openHandoffs()).toHaveLength(1);
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeFalsy();
  });

  it('这件事已经不在了（别处处理过）：明确报错，不悄悄存', () => {
    const repos = createMemoryRepos();
    expect(() => fillAsk(repos, vaultOf(repos), 'hnd_gone', { 证件号码: 'x' }, NOW)).toThrow(AskFillError);
  });
});
