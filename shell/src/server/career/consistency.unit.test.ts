import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

import { BatchRunner } from './batch-runner';
import { loadCore } from './core-module';
import { setMailCredentialsPath, setMailPassword } from './mail/credentials';
import { executeApprovedSendMails, executeSendMailAction } from './mail/send';
import { fileSha256, freezePacket, packetResumeFile, pickResumeForJob, readableResumeFileName } from './packets';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

// 阶段 0 回归：审批绑定内容、材料包冻结简历、重复发送、批量与对话争用浏览器。

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-consistency-')); setMailCredentialsPath(join(dir, 'creds.json')); });
afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const repos = createMemoryRepos();
  const core = await loadCore();
  const store = new CareerStore(repos, core);
  const events: Array<{ event: string; data: unknown }> = [];
  let exportN = 0;
  /** 假导出：每次按当前内容写一个 PDF（内容 = schema_json），模拟"简历改了导出就变"。 */
  const exportPdf = async (id: string) => {
    const found = store.getResume(id)!;
    const path = join(dir, `${id}.pdf`); // 与真实导出一样：同一路径反复覆盖
    writeFileSync(path, `%PDF ${found.row.schema_json} #${++exportN}`);
    return path;
  };
  return { repos, core, store, events, exportPdf, deps: { repos, core, llm: null, broadcast: (event: string, data: unknown) => events.push({ event, data }), sessionId: () => 'global' } };
}

describe('投递材料包', () => {
  it('入队时冻结：之后简历再改、再导出覆盖原文件，执行时拿到的仍是批准时那一份', async () => {
    const s = await setup();
    const master = s.store.createResumeMaster({ name: '通用版', schema_json: { basics: { name: '张三' } } });
    const job = s.repos.upsertJob({ source_platform: 'campus', source_job_id: '1', title: '后端', company_name: '甲' });
    const app = s.repos.createApplication(job.id);
    const { packet, warning } = await freezePacket({ repos: s.repos, store: s.store, exportPdf: s.exportPdf, exportsDir: dir }, { applicationId: app.id, jobId: job.id, resumeId: master.id });
    expect(warning).toBeUndefined();
    expect(packet.resume_pdf_path).toBe(join(dir, 'packets', `${packet.resume_pdf_sha256}.pdf`));
    const frozen = fileSha256(packet.resume_pdf_path!);
    // 批准后改简历并重新导出（覆盖 exports/<id>.pdf）
    s.store.saveResume(master.id, { basics: { name: '张三（改）' } });
    await s.exportPdf(master.id);
    const file = await packetResumeFile(s.repos, { packet_id: packet.id });
    // 上传用可读文件名的副本（内容仍是冻结的那一份，名字取冻结时简历上的姓名）
    expect(file.path).toBe(join(dir, 'packets', 'upload', packet.id, '张三-后端-甲.pdf'));
    expect(fileSha256(file.path!)).toBe(frozen);
  });

  it('上传文件名：姓名占位符在本机解开；解不开用简历名；去掉非法字符；岗位名缺失不写"未命名岗位"', async () => {
    const s = await setup();
    const master = s.store.createResumeMaster({ name: '通用版', schema_json: { basics: { name: '{{vault:profile.name}}' } } });
    const job = s.repos.upsertJob({ source_platform: 'campus', source_job_id: '2', title: '算法/推荐: 实习*', company_name: '乙 公司' });
    const { packet } = await freezePacket({ repos: s.repos, store: s.store, exportPdf: s.exportPdf, exportsDir: dir }, { jobId: job.id, resumeId: master.id });
    const resolved = await packetResumeFile(s.repos, { packet_id: packet.id }, undefined, { resolveText: t => t.replace('{{vault:profile.name}}', '李四') });
    expect(resolved.path!.endsWith('/李四-算法推荐 实习-乙 公司.pdf')).toBe(true);
    expect(fileSha256(resolved.path!)).toBe(packet.resume_pdf_sha256);
    const unresolved = await packetResumeFile(s.repos, { packet_id: packet.id });
    expect(unresolved.path!.endsWith('/通用版-算法推荐 实习-乙 公司.pdf')).toBe(true);
    expect(readableResumeFileName({ resumeName: '通用版', jobTitle: '未命名岗位', company: null })).toBe('通用版.pdf');
    expect(readableResumeFileName({})).toBe('简历.pdf');
    expect(readableResumeFileName({ person: '../王五', jobTitle: '后端\n开发', company: 'a:b' })).toBe('王五-后端 开发-ab.pdf');
  });

  it('材料包文件被篡改：拒绝上传', async () => {
    const s = await setup();
    const master = s.store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    const { packet } = await freezePacket({ repos: s.repos, store: s.store, exportPdf: s.exportPdf, exportsDir: dir }, { resumeId: master.id });
    writeFileSync(packet.resume_pdf_path!, 'tampered');
    const file = await packetResumeFile(s.repos, { packet_id: packet.id });
    expect(file.path).toBeUndefined();
    expect(file.error).toMatch(/不一致/);
  });

  it('没有材料包的旧动作走现导兜底；选简历：定制 > 唯一主简历 > 多份时不猜', async () => {
    const s = await setup();
    expect(await packetResumeFile(s.repos, { resume_id: 'r1' }, async id => `legacy-${String(id)}`)).toEqual({ path: 'legacy-r1' });
    const job = s.repos.upsertJob({ source_platform: 'campus', source_job_id: '2', title: '前端' });
    const m1 = s.store.createResumeMaster({ name: 'A' });
    expect(pickResumeForJob(s.store, job.id)).toMatchObject({ id: m1.id, kind: 'master' });
    const t = s.store.createTailored({ master_id: m1.id, job_id: job.id, schema_json: {} });
    expect(pickResumeForJob(s.store, job.id)).toMatchObject({ id: t.id, kind: 'tailored' });
    s.store.createResumeMaster({ name: 'B' });
    expect(pickResumeForJob(s.store, 'other-job')).toBeUndefined();
  });
});

describe('邮件不会被重复发送', () => {
  async function mailSetup() {
    const s = await setup();
    const account = s.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    const sent: unknown[] = [];
    const transport = async (_a: unknown, _p: string, m: unknown) => { sent.push(m); return { messageId: `<m${sent.length}@x>` }; };
    return { ...s, account, sent, transport };
  }

  it('已发送的邮件再次批准不会生效，也不会再发', async () => {
    const s = await mailSetup();
    const action = s.repos.enqueueAction('send_mail', { account_id: s.account.id, to: 'hr@b.com', subject: '应聘', body: '正文' });
    s.repos.reviewActions([action.id], 'approved');
    await executeApprovedSendMails({ ...s.deps, transport: s.transport }, [action.id]);
    expect(s.sent).toHaveLength(1);
    // 再批一次（旧版路由会把 done 重新置为 approved 并立即再发）
    expect(s.repos.reviewActions([action.id], 'approved')).toBe(0);
    await executeApprovedSendMails({ ...s.deps, transport: s.transport }, [action.id]);
    expect(s.sent).toHaveLength(1);
    expect(s.repos.getAction(action.id)!.status).toBe('done');
  });

  it('两处同时执行同一封：只有一处能发出去', async () => {
    const s = await mailSetup();
    const action = s.repos.enqueueAction('send_mail', { account_id: s.account.id, to: 'hr@b.com', subject: '应聘', body: '正文' });
    s.repos.reviewActions([action.id], 'approved');
    const snapshot = s.repos.getAction(action.id)!;
    await executeSendMailAction({ ...s.deps, transport: s.transport }, snapshot);
    await expect(executeSendMailAction({ ...s.deps, transport: s.transport }, snapshot)).rejects.toThrow(/不会重复发送/);
    expect(s.sent).toHaveLength(1);
  });

  it('附件在批准后被换掉：不发送，动作记失败', async () => {
    const s = await mailSetup();
    const master = s.store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    const { packet } = await freezePacket({ repos: s.repos, store: s.store, exportPdf: s.exportPdf, exportsDir: dir }, { resumeId: master.id });
    const action = s.repos.enqueueAction('send_mail', { account_id: s.account.id, to: 'hr@b.com', subject: '应聘', body: '正文', packet_id: packet.id, attachments: [{ path: packet.resume_pdf_path!, filename: '简历.pdf', sha256: packet.resume_pdf_sha256! }] });
    s.repos.reviewActions([action.id], 'approved');
    writeFileSync(packet.resume_pdf_path!, 'another resume');
    await expect(executeSendMailAction({ ...s.deps, transport: s.transport }, s.repos.getAction(action.id)!)).rejects.toThrow(/不一致/);
    expect(s.sent).toHaveLength(0);
    expect(s.repos.getAction(action.id)!.status).toBe('failed');
  });
});

describe('批量与对话争用', () => {
  function seedOne(repos: Repos) {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'b1', title: '岗位', company_name: '公司', url: 'https://x.com/apply/1' });
    const app = repos.createApplication(job.id);
    repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    return action;
  }

  it('对话已认领的动作，批量跳过不执行', async () => {
    const repos = createMemoryRepos();
    const action = seedOne(repos);
    expect(repos.claimAction(action.id).ok).toBe(true); // 对话 apply_run 先拿走
    const drive = vi.fn(async () => []);
    const runner = new BatchRunner({ repos, drive, control: () => 'agent', broadcast: () => {} });
    const out = await runner.runOne(action, 'start');
    expect(out.kind).toBe('failed');
    expect(drive).not.toHaveBeenCalled();
    expect(repos.getAction(action.id)!.status).toBe('executing');
  });

  it('浏览器被占用（BROWSER_BUSY）：放回队列、不记失败、不占当天名额', async () => {
    const repos = createMemoryRepos();
    const action = seedOne(repos);
    const runner = new BatchRunner({ repos, drive: async (_req, onEvent) => { const ev = { type: 'error', status: 409, code: 'BROWSER_BUSY', error: 'busy' }; onEvent(ev); return [ev]; }, control: () => 'agent', broadcast: () => {} });
    await runner.runOne(action, 'start');
    const after = repos.getAction(action.id)!;
    expect(after.status).toBe('approved');
    expect(after.approved_hash).toBeTruthy();
    expect(runner.todayCount()).toBe(0);
    expect(repos.getApplication(action.application_id!)!.stage).not.toBe('blocked');
  });
});
