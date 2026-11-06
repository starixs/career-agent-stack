/**
 * 邮件投递工作台的路由（第四轮）：贴进来一段岗位（成功 / 没写投递邮箱 / 重复贴）、board、setup。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isMailBoardRow, isMailBoardView, isMailSetupView } from '../../shared/careerMailApply';
import { loadCore } from '../career/core-module';
import { companyFromEmail, pasteMailJob } from '../career/mail-apply/paste';
import { mailFixture, type MailFixture } from '../career/mail-apply/test-fixture';
import { handleCareerRoute } from './career';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

const core = await loadCore();

describe('邮件投递工作台路由', () => {
  let dir: string;
  let f: MailFixture;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleCareerRoute(path, new Request(`http://local${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }),
      { repos: f.repos, vault: f.vault, llm: null, broadcast: () => undefined, exportsDir: dir, studioExport: false });
    return { status: res!.status, json: (await res!.json()) as Record<string, unknown> };
  };

  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'career-mail-routes-')); f = await mailFixture(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('贴进来：明写了投递邮箱就建岗位、落在「可以投」；模型不可用时名字用兜底（公司 = 邮箱域名那段）', async () => {
    const res = await call('POST', '/api/career/mail-apply/jobs', { text: '【甲科技】产品实习生\n岗位职责：竞品分析。\n简历投递至 hr@jiakeji.com，邮件标题：姓名-学校' });
    expect(res.status).toBe(200);
    const row = res.json.row;
    expect(isMailBoardRow(row) && row).toMatchObject({ station: 'ready', application_id: null, role: '实习岗位', company: { name: 'jiakeji' } });
    const job = f.repos.listJobs()[0];
    expect(job).toMatchObject({ apply_email: 'hr@jiakeji.com', source_platform: 'manual' });
    expect(f.llm.calls).toHaveLength(0);
    // 还没有简历：再取 board，那一行还在「可以投」
    const board = (await call('GET', '/api/career/mail-apply/board')).json.board;
    expect(isMailBoardView(board) && board.rows.map(r => [r.job_id, r.station])).toEqual([[job.id, 'ready']]);
    expect(isMailBoardView(board) && board.setup.has_resume).toBe(false);
    expect(companyFromEmail('hr@campus.yi.com.cn')).toBe('yi');
    expect(companyFromEmail('boss@qq.com')).toBe('未知公司');
  });

  it('模型可用时走现有 JD 解析补上公司与岗位名', async () => {
    f.llm.push(JSON.stringify({ company: '甲科技', title: '产品运营实习生', location: ['北京'], must_have: [], nice_to_have: [], keywords: [] }));
    const { job, created } = await pasteMailJob({ repos: f.repos, core, llm: f.llm, broadcast: () => undefined, sessionId: () => 'global' }, { text: '产品运营实习生\n简历投递至 hr@jiakeji.com' });
    expect(created).toBe(true);
    expect(job).toMatchObject({ company_name: '甲科技', title: '产品运营实习生', apply_email: 'hr@jiakeji.com' });
  });

  it('没有明写投递邮箱：422「这段里没找到投递邮箱」，不建岗位、不调模型', async () => {
    const res = await call('POST', '/api/career/mail-apply/jobs', { text: '产品实习生，有问题可联系 hr@x.com' });
    expect(res).toMatchObject({ status: 422, json: { ok: false, error: '这段里没找到投递邮箱' } });
    expect(f.repos.listJobs()).toEqual([]);
  });

  it('同一段再贴一次不重复建', async () => {
    const text = '产品实习生\n请将简历发送至 campus@bing.com';
    const a = await call('POST', '/api/career/mail-apply/jobs', { text });
    const b = await call('POST', '/api/career/mail-apply/jobs', { text: `  ${text}\n` });
    expect(isMailBoardRow(a.json.row) && isMailBoardRow(b.json.row) && b.json.row.job_id).toBe(isMailBoardRow(a.json.row) ? a.json.row.job_id : '');
    expect(f.repos.listJobs()).toHaveLength(1);
  });

  it('board 与 setup', async () => {
    const board = await call('GET', '/api/career/mail-apply/board');
    expect(isMailBoardView(board.json.board)).toBe(true);
    const setup = await call('POST', '/api/career/mail-apply/setup', { direct_send: true });
    expect(isMailSetupView(setup.json.setup) && setup.json.setup.direct_send).toBe('delegated');
    expect(await call('POST', '/api/career/mail-apply/setup', { portfolio_url: 'nope' })).toMatchObject({ status: 400, json: { error: '这不像一个网址' } });
  });
});
