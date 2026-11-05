/**
 * 批量勾选表（face-beta-polish 2026-11-05）：所有入口汇到同一张表。
 * 只列现在就能投的；默认勾一小批且一家公司只勾一个岗；第一份投出后自动出一张，已经有一张在等他就不再出；
 * 没有能投的不出空表；点「投这 N 家」后卡收成"已开始投 N 家"。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Repos } from '@career/core';

import { BATCH_PICK_CARD_KIND, hasOpenProposal, postProposal, proposeAfterSubmit, proposeBatch, startDoneLine, startFromCard } from './batch-propose';
import { readUnpicked, UNPICKED_GROUP_ID } from './batch-propose-groups';
import { setJobPrefs } from './job-board';
import { systemOfSync, TRUST_LEDGER_KEY } from './trust-ledger';
import type { ChatCardPush } from './chat-card-push';
import { loadCore } from './core-module';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

const core = await loadCore();
const SESSION = 'sess-1';

describe('批量勾选表', () => {
  let dir: string;
  let repos: Repos;
  let store: CareerStore;
  const posted: ChatCardPush[] = [];
  /** 和产品的贴卡器一样落库到这个会话（不推前端）。 */
  const post = (c: ChatCardPush) => { posted.push(c); repos.upsertChatCard({ ...c, session_id: SESSION, tool_use_id: null }); };
  const job = (company: string, title: string, url: string | null = `https://jobs.${company}.test/${title}`, extra: Record<string, unknown> = {}) =>
    repos.upsertJob({ source_platform: 'campus', source_job_id: `${company}-${title}`, title, company_name: company, url, ...extra });
  /** 投出过 n 份（每份一家不同公司，已投过的不进表）。 */
  const sent = (n: number) => { for (let i = 0; i < n; i += 1) repos.jumpTo(repos.createApplication(job(`已投${i}`, '岗').id).id, 'applied', '投过'); };
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'career-propose-'));
    repos = createMemoryRepos();
    store = new CareerStore(repos, core);
    posted.length = 0;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('只列能投的；默认勾一小批，一家公司只勾一个岗', () => {
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    job('招商银行', '管培生'); job('招商银行', '财务分析'); job('平安', '财务分析'); job('美的', '运营助理');
    job('无链接公司', '运营', null);
    repos.jumpTo(repos.createApplication(job('拼多多', '运营').id).id, 'applied', '投过');
    const p = proposeBatch(repos, store, { limit: 3 });
    expect(p.rows.map(r => r.company).sort()).toEqual(['平安', '招商银行', '招商银行', '美的']);
    const picked = p.rows.filter(r => r.picked).map(r => r.company);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(p.resume?.name).toBe('财务版');
  });

  it('第一份投出后自动出一张；已经有一张在等他就不再出', () => {
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    job('平安', '财务分析'); job('美的', '运营助理');
    expect(proposeAfterSubmit(repos, store, post, SESSION)).toBe(true);
    expect(posted[0].kind).toBe(BATCH_PICK_CARD_KIND);
    expect(posted[0].title).toBe('先投这 2 家？');
    expect(hasOpenProposal(repos, SESSION)).toBe(true);
    expect(proposeAfterSubmit(repos, store, post, SESSION)).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('还没有简历：如实说先要一份简历，不说成没有能投的岗位', async () => {
    job('平安', '财务分析');
    const p = proposeBatch(repos, store);
    expect(p.blocked).toBe('no_resume');
    const { proposalTitle } = await import('./batch-propose');
    expect(proposalTitle(p)).toBe('投之前先要一份简历');
  });

  it('没有能投的岗位时不自动出空表', () => {
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    job('无链接公司', '运营', null);
    expect(proposeAfterSubmit(repos, store, post, SESSION)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('点「投这 N 家」：开始投，卡收成"已开始投 N 家"', async () => {
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    const a = job('平安', '财务分析');
    const b = job('美的', '运营助理');
    proposeAfterSubmit(repos, store, post, SESSION);
    const deps = { repos, store, exportsDir: dir, exportPdf: async (id: string) => { const f = join(dir, `${id}.pdf`); writeFileSync(f, `%PDF ${id}`); return f; } };
    const res = await startFromCard(deps, posted[0].id, [a.id, b.id], null);
    expect(res.started).toHaveLength(2);
    const card = repos.getChatCard(posted[0].id)!;
    expect(card.state).toBe('completed');
    expect(JSON.parse(card.data_json).done_line).toBe('已开始投 2 家');
    expect(hasOpenProposal(repos, SESSION)).toBe(false);
  });

  describe('今天这批（plan-r2 §C）', () => {
    beforeEach(() => { store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } }); });

    it('投出不到 5 份默认勾 5；5 份以上默认勾满方向内', () => {
      for (let i = 0; i < 30; i += 1) job(`公司${i}`, '财务分析');
      job('公司0', '管培生');
      expect(proposeBatch(repos, store).rows.filter(r => r.picked)).toHaveLength(5);
      sent(5);
      const p = proposeBatch(repos, store);
      expect(p.rows).toHaveLength(31);
      const picked = p.rows.filter(r => r.picked);
      expect(picked).toHaveLength(30);
      expect(new Set(picked.map(r => r.company)).size).toBe(30);
      expect(proposeBatch(repos, store, { pick: 'all' }).rows.filter(r => r.picked)).toHaveLength(30);
    });

    it('有截止的够多就按截止分组，否则按方向词', () => {
      setJobPrefs(repos, { keywords: ['财务', '运营'] });
      job('A', '财务分析', undefined, { deadline: days(1) }); job('B', '财务助理', undefined, { deadline: days(5) });
      job('C', '运营助理', undefined, { deadline: days(20) }); job('D', '运营专员');
      const p = proposeBatch(repos, store);
      expect(p.group_by).toBe('deadline');
      expect(p.groups.map(g => g.title)).toEqual(['3 天内截止', '这周截止', '之后截止', '截止没写']);
      expect(p.rows.find(r => r.company === 'A')?.deadline).toBe(days(1));
      repos.db.run('UPDATE job SET deadline = NULL');
      const q = proposeBatch(repos, store);
      expect(q.group_by).toBe('direction');
      expect(q.groups.map(g => g.title)).toEqual(['财务', '运营']);
      expect(q.rows.map(r => r.group)).toEqual(['kw:财务', 'kw:财务', 'kw:运营', 'kw:运营']);
    });

    it('上次没勾的进最后一组、不勾；勾上投出后移除', async () => {
      const a = job('平安', '财务分析'); const b = job('美的', '运营助理'); job('招商银行', '管培生');
      const posted0 = postProposal(repos, store, post, {}, SESSION);
      const deps = { repos, store, exportsDir: dir, exportPdf: async (id: string) => { const f = join(dir, `${id}.pdf`); writeFileSync(f, `%PDF ${id}`); return f; } };
      await startFromCard(deps, posted0.card_id, [a.id], null);
      const p = proposeBatch(repos, store);
      const last = p.groups[p.groups.length - 1];
      expect(last).toMatchObject({ id: UNPICKED_GROUP_ID, title: '上次没投的 2 家', collapsed: true });
      expect(p.rows.filter(r => r.group === UNPICKED_GROUP_ID).every(r => !r.picked)).toBe(true);
      expect(p.rows.map(r => r.group).slice(-2)).toEqual([UNPICKED_GROUP_ID, UNPICKED_GROUP_ID]);
      const again = postProposal(repos, store, post, {}, SESSION);
      await startFromCard(deps, again.card_id, [b.id], null);
      expect(proposeBatch(repos, store).groups.at(-1)?.title).toBe('上次没投的 1 家');
    });

    it('首批只勾 5、其余 295 不算上次没投的', async () => {
      for (let i = 0; i < 300; i += 1) job(`公司${i}`, '财务分析');
      const first = postProposal(repos, store, post, {}, SESSION);
      const rows = proposeBatch(repos, store).rows;
      const defaults = rows.filter(r => r.picked).map(r => r.job_id);
      expect(defaults).toHaveLength(5);
      const deps = { repos, store, exportsDir: dir, exportPdf: async (id: string) => { const f = join(dir, `${id}.pdf`); writeFileSync(f, `%PDF ${id}`); return f; } };
      await startFromCard(deps, first.card_id, defaults.slice(0, 3), null);
      expect(Object.keys(readUnpicked(repos))).toHaveLength(defaults.length - 3);
      const next = proposeBatch(repos, store);
      expect(next.rows.filter(r => r.picked).length).toBeGreaterThan(0);
      expect(next.rows.filter(r => r.group === UNPICKED_GROUP_ID)).toHaveLength(2);
    });

    it('换一批：收起刚才那张，新表不列它默认勾的；排完不剩就如实说', () => {
      for (let i = 0; i < 8; i += 1) job(`公司${i}`, '财务分析');
      const a = postProposal(repos, store, post, {}, SESSION);
      const firstPicked = proposeBatch(repos, store).rows.filter(r => r.picked).map(r => r.job_id);
      const b = postProposal(repos, store, post, {}, SESSION);
      expect(repos.getChatCard(a.card_id)?.state).toBe('dismissed');
      const second = JSON.parse(repos.getChatCard(b.card_id)!.data_json) as { rows: Array<{ job_id: string }> };
      expect(second.rows.map(r => r.job_id).some(id => firstPicked.includes(id))).toBe(false);
      expect(second.rows).toHaveLength(3);
    });

    it('换一批但能投的都在刚才那张里：旧表留着，新卡如实说', () => {
      for (let i = 0; i < 3; i += 1) job(`公司${i}`, '财务分析');
      const a = postProposal(repos, store, post, {}, SESSION);
      const b = postProposal(repos, store, post, {}, SESSION);
      expect(repos.getChatCard(a.card_id)?.state).toBe('pending');
      expect(posted.at(-1)?.title).toBe('这个方向能投的都在刚才那批里了');
      expect(b.picked).toBe(0);
    });

    it('收起那一行带前两条没开始的原因', () => {
      expect(startDoneLine(4, [{ reason: '简历里缺手机号' }])).toBe('已开始投 4 家 · 1 家没开始：简历里缺手机号');
      expect(startDoneLine(2, [{ reason: '已投过' }, { reason: '已投过' }, { reason: '没有网申链接' }, { reason: '简历 PDF 没导出来' }]))
        .toBe('已开始投 2 家 · 4 家没开始：已投过；没有网申链接，另有 1 家');
      expect(startDoneLine(0, [])).toBe('这批一家都没能开始');
    });

    it('届别不符的不进表', () => {
      setJobPrefs(repos, { cohort: '2027' });
      job('A', '财务分析', undefined, { cohort: '2026届' }); job('B', '财务分析', undefined, { cohort: '2027届' }); job('C', '财务分析');
      expect(proposeBatch(repos, store).rows.map(r => r.company).sort()).toEqual(['B', 'C']);
    });

    it('新网站排在会了的后面', () => {
      job('新1', '财务'); const known = job('会了', '财务');
      const sys = systemOfSync(known.url!);
      repos.kvSet(TRUST_LEDGER_KEY, { [sys.key]: { key: sys.key, kind: 'system', label: sys.label, state: 'delegated', successes: 3, updated_at: '2026-11-01T00:00:00Z' } });
      const p = proposeBatch(repos, store);
      expect(p.rows.map(r => r.company)).toEqual(['会了', '新1']);
      expect(p.rows[0]).toMatchObject({ known: true, delegated: true });
      expect(p.rows[1]).toMatchObject({ known: false, delegated: false });
    });

    it('每行带简历签', () => {
      const a = job('A', '财务分析', undefined, { jd_raw: '负责财务分析。'.repeat(40) });
      job('B', '财务分析');
      const master = store.listResumeMasters()[0];
      const p = proposeBatch(repos, store);
      expect(p.rows.find(r => r.job_id === a.id)?.resume_plan).toMatchObject({ kind: 'will_tailor', resume_id: master.id, name: '财务版' });
      expect(p.rows.find(r => r.company === 'B')?.resume_plan?.kind).toBe('no_jd');
    });

    it('常设授权：当面做通两份的系统才问', () => {
      repos.kvSet(TRUST_LEDGER_KEY, {
        'system:beisen': { key: 'system:beisen', kind: 'system', label: '北森', state: 'shown', successes: 2, updated_at: '2026-11-01T00:00:00Z' },
        'system:moka': { key: 'system:moka', kind: 'system', label: 'Moka', state: 'shown', successes: 1, updated_at: '2026-11-01T00:00:00Z' },
      });
      job('A', '财务');
      expect(proposeBatch(repos, store).propose_delegate).toEqual([{ key: 'system:beisen', label: '北森', successes: 2 }]);
    });
  });
});
