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

import { BATCH_PICK_CARD_KIND, hasOpenProposal, proposeAfterSubmit, proposeBatch, startFromCard } from './batch-propose';
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
  const job = (company: string, title: string, url: string | null = `https://jobs.${company}.test/${title}`) =>
    repos.upsertJob({ source_platform: 'campus', source_job_id: `${company}-${title}`, title, company_name: company, url });

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
    const p = proposeBatch(repos, store, 3);
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
});
