import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaticKeyProvider, Vault, type Repos } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute, type CareerRouteDeps } from './career';

// `/api/career/vault/*`：UI 与私密库之间唯一的明文通道；导出简历时占位符在渲染前解开。

const tempDirs: string[] = [];

async function call(deps: CareerRouteDeps, method: string, path: string, body?: unknown) {
  const request = new Request(`http://local${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error(`route returned null for ${method} ${path}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('私密信息库路由', () => {
  let repos: Repos;
  let vault: Vault;
  let deps: CareerRouteDeps & { events: Array<{ event: string; data: unknown }> };

  beforeEach(() => {
    repos = createMemoryRepos();
    vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 1)));
    const dir = mkdtempSync(join(tmpdir(), 'career-vault-route-'));
    tempDirs.push(dir);
    const events: Array<{ event: string; data: unknown }> = [];
    deps = { repos, vault, events, broadcast: (event, data) => { events.push({ event, data }); }, sessionId: () => 'sess-1', exportsDir: dir, llm: null };
  });
  afterEach(() => {
    repos.db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('写入 → 列表只有预览 → reveal 才有明文并记日志 → 空值删除', async () => {
    const put = await call(deps, 'PUT', '/api/career/vault/items', { scope: 'profile', field: 'phone', value: '13800138000' });
    expect(put.status).toBe(200);
    const item = put.json.item as { id: string; preview: string; sensitive: boolean };
    expect(item.preview).toBe('138****8000');
    expect(item.sensitive).toBe(true);
    expect(deps.events.some(e => e.event === 'career:data-changed' && (e.data as { tables: string[] }).tables.includes('vault'))).toBe(true);

    const list = await call(deps, 'GET', '/api/career/vault');
    expect(JSON.stringify(list.json)).not.toContain('13800138000');
    expect((list.json.status as { profile: { filled: unknown[] } }).profile.filled).toHaveLength(1);
    expect(Array.isArray(list.json.profileFields)).toBe(true);

    const reveal = await call(deps, 'POST', `/api/career/vault/items/${item.id}/reveal`, {});
    expect(reveal.json.value).toBe('13800138000');
    const log = await call(deps, 'GET', '/api/career/vault/access-log');
    expect((log.json.log as Array<{ actor: string }>)[0].actor).toBe('ui');

    const del = await call(deps, 'PUT', '/api/career/vault/items', { scope: 'profile', field: 'phone', value: '' });
    expect(del.json.deleted).toBe(true);
    expect((await call(deps, 'GET', '/api/career/vault')).json.items).toEqual([]);
  });

  it('站点作用域按域名归一化；策略开关；按站点删除', async () => {
    await call(deps, 'PUT', '/api/career/vault/items', { scope: 'site', ref_id: 'https://www.Zhaopin.com/login', field: 'username', value: 'me@x.com', label: '智联' });
    await call(deps, 'PUT', '/api/career/vault/items', { scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: 'pw-123456' });
    const list = await call(deps, 'GET', '/api/career/vault');
    const sites = (list.json.status as { sites: Array<{ host: string; hasUsername: boolean; hasPassword: boolean; autofill: boolean }> }).sites;
    expect(sites).toEqual([{ host: 'zhaopin.com', label: '智联', hasUsername: true, hasPassword: true, autofill: false }]);
    const items = list.json.items as Array<{ id: string; field: string }>;
    const u = items.find(i => i.field === 'username')!;
    const pol = await call(deps, 'POST', `/api/career/vault/items/${u.id}/policy`, { policy: { autofill: true } });
    expect((pol.json.item as { policy: { autofill: boolean } }).policy.autofill).toBe(true);
    expect(vault.credential('https://campus.zhaopin.com/x', { actor: 'test' })).toMatchObject({ username: 'me@x.com', password: 'pw-123456', autofill: true });
    const del = await call(deps, 'DELETE', '/api/career/vault/sites/zhaopin.com');
    expect(del.json.deleted).toBe(2);
  });

  it('经历作用域要求经历存在；坏参数 400', async () => {
    const bad = await call(deps, 'PUT', '/api/career/vault/items', { scope: 'experience', ref_id: 'exp_nope', field: 'org', value: 'X' });
    expect(bad.status).toBe(404);
    const e = repos.createExperience({ title: '某头部电商实习', redacted: 1 });
    const okRes = await call(deps, 'PUT', '/api/career/vault/items', { scope: 'experience', ref_id: e.id, field: 'org', value: '真实公司名', label: '真实公司' });
    expect(okRes.status).toBe(200);
    const status = (await call(deps, 'GET', '/api/career/vault')).json.status as { experiences: Array<{ experience_id: string; fields: Array<{ placeholder: string }> }> };
    expect(status.experiences[0]).toMatchObject({ experience_id: e.id });
    expect(status.experiences[0].fields[0].placeholder).toBe(`{{vault:exp.${e.id}.org}}`);
    expect((await call(deps, 'PUT', '/api/career/vault/items', { scope: 'nope', field: 'x', value: 'y' })).status).toBe(400);
    expect((await call(deps, 'PUT', '/api/career/vault/items', { scope: 'profile', field: 'x', value: 1 })).status).toBe(400);
  });

  it('导出简历时占位符解成明文，落库 JSON 不变', async () => {
    await call(deps, 'PUT', '/api/career/vault/items', { scope: 'profile', field: 'name', value: '张三' });
    await call(deps, 'PUT', '/api/career/vault/items', { scope: 'profile', field: 'phone', value: '13800138000' });
    const master = (await call(deps, 'POST', '/api/career/resumes/master', { name: '通用版', schema_json: { basics: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}' } } })).json.master as { id: string };
    const rendered: unknown[] = [];
    deps.resumeModule = async () => ({
      parseResume: (x: unknown) => x,
      renderPdf: async (resume: unknown) => { rendered.push(resume); return Buffer.from('pdf'); },
      renderDocx: async () => Buffer.from('docx'),
      renderPng: async () => Buffer.from('png'),
    }) as never;
    const res = await call(deps, 'POST', `/api/career/resumes/${master.id}/export`, { format: 'pdf' });
    expect(res.status).toBe(200);
    expect(rendered[0]).toMatchObject({ basics: { name: '张三', phone: '13800138000' } });
    const row = repos.db.get<{ schema_json: string }>('SELECT schema_json FROM resume_master WHERE id=?', [master.id])!;
    expect(row.schema_json).toContain('{{vault:profile.phone}}');
    expect(row.schema_json).not.toContain('13800138000');
    expect(vault.accessLog().some(l => l.actor === 'resume_export')).toBe(true);
  });
});
