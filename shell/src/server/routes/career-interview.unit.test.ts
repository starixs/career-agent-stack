/**
 * 面试接口：电话约的面试自己记一场；上传自己录的面试录音（等语音识别）；把岗位标成目标。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute, type CareerRouteDeps } from './career';

interface Reply { status: number; json: Record<string, unknown> }

describe('面试接口', () => {
  let repos: Repos;
  let dir: string;
  let deps: CareerRouteDeps;

  beforeEach(() => {
    repos = createMemoryRepos();
    dir = mkdtempSync(join(tmpdir(), 'career-interview-'));
    deps = { repos, broadcast: () => undefined, sessionId: () => 'sess-1', exportsDir: dir, recordingsDir: join(dir, 'rec'), llm: null };
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function call(method: string, path: string, body?: unknown): Promise<Reply> {
    const request = new Request(`http://local${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
    if (!response) throw new Error(`没有路由：${method} ${path}`);
    const json: Record<string, unknown> = await response.json();
    return { status: response.status, json };
  }

  it('HR 电话约的面试：记一场就有申请、面试和时间点；同一场再记只改时间', async () => {
    const first = await call('POST', '/api/career/interviews/book', { company_name: '小红书', title: '推荐算法', round: '一面', when: '2026-11-04T15:00:00+08:00', location: '腾讯会议 123' });
    expect(first.status).toBe(200);
    const appId = String(first.json.application_id);
    expect(repos.getApplication(appId)?.stage).toBe('interview');
    await call('POST', '/api/career/interviews/book', { company_name: '小红书', round: '一面', when: '2026-11-04T16:00:00+08:00' });
    const ds = repos.listDeadlines({ application_id: appId }).filter(d => d.kind === 'interview');
    expect(ds.map(d => [d.due_at, d.note])).toEqual([[new Date('2026-11-04T16:00:00+08:00').toISOString(), '腾讯会议 123']]);
  });

  it('没填公司说清楚缺什么；没填时间先记上（时间待定），不挡住', async () => {
    expect((await call('POST', '/api/career/interviews/book', {})).json.error).toMatch(/company_name/);
    expect((await call('POST', '/api/career/interviews/book', { company_name: '小红书' })).json.deadline_id).toEqual(expect.any(String));
  });

  it('上传录音：存到本机、挂在那场面试上、等待转写；接口不回本机路径', async () => {
    const booked = await call('POST', '/api/career/interviews/book', { company_name: '小红书', round: '一面', when: '2026-11-04T15:00:00+08:00' });
    const id = String(booked.json.interview_id);
    const up = await call('POST', `/api/career/interviews/${id}/recordings`, { name: '一面.m4a', mime: 'audio/mp4', data: Buffer.from('fake-audio').toString('base64') });
    expect(up.json.recording).toMatchObject({ name: '一面.m4a', status: 'awaiting_asr', size: 10 });
    expect(up.json.recording).not.toHaveProperty('path');
    const list = await call('GET', `/api/career/interviews/${id}/recordings`);
    expect(list.json.recordings).toHaveLength(1);
    const saved = join(dir, 'rec', `${String((up.json.recording as { id: string }).id)}.m4a`);
    expect(existsSync(saved) && readFileSync(saved, 'utf8')).toBe('fake-audio');
  });

  it('不是音频的文件不收', async () => {
    const booked = await call('POST', '/api/career/interviews/book', { company_name: '小红书', when: '2026-11-04T15:00:00+08:00' });
    const up = await call('POST', `/api/career/interviews/${String(booked.json.interview_id)}/recordings`, { name: '简历.pdf', data: 'AAAA' });
    expect(up.json.error).toMatch(/不是音频/);
  });

  it('目标岗位：用户标的算目标、取消就不算；进过面试的自动算，系统不替用户认定别的', async () => {
    const mine = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法', company_name: '美团', url: 'https://meituan.test/apply' });
    const other = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j2', title: '后端', company_name: '京东', url: 'https://jd.test/apply' });
    repos.createApplication(mine.id); repos.createApplication(other.id);
    await call('POST', '/api/career/interviews/book', { company_name: '小红书', when: '2026-11-04T15:00:00+08:00' });
    await call('POST', '/api/career/targets', { job_id: mine.id, target: true });
    const targets = async () => Object.fromEntries(((await call('GET', '/api/career/dossiers')).json.dossiers as Array<{ company_name: string; target: string | null }>).map(d => [d.company_name, d.target]));
    expect(await targets()).toEqual({ 美团: 'user', 京东: null, 小红书: 'interview' });
    await call('POST', '/api/career/targets', { job_id: mine.id, target: false });
    expect((await targets()).美团).toBeNull();
  });

  it('岗位库表里也带目标标记：海投阶段标的岗位还没建申请也算', async () => {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j3', title: '算法', company_name: '快手', url: 'https://kuaishou.test/apply' });
    await call('POST', '/api/career/targets', { job_id: job.id, target: true });
    const rows = (await call('GET', '/api/career/jobs/board')).json.rows as Array<{ job: { id: string }; target: string | null }>;
    expect(rows.find(r => r.job.id === job.id)?.target).toBe('user');
  });
});
