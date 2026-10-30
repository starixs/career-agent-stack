/**
 * 更正卡背后的换版（规范 §5.7，2026-10-30 你定）：改了共用的简历，待投清单里没点开始的换成新版，
 * 点了开始、在填、待提交、已投出的如实列为改不了；没改内容就什么都不发生。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '@career/core';

import { loadCore } from './core-module';
import { refreshQueuedPackets } from './correction';
import { freezePacket, type PacketDeps } from './packets';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-correction-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, await loadCore());
  const exportPdf = async (id: string) => { const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${store.getResume(id)!.row.schema_json}`); return p; };
  const deps: PacketDeps = { repos, store, exportPdf, exportsDir: dir };
  const master = store.createResumeMaster({ name: '通用版', schema_json: { projects: [{ name: '数据中台' }] } });
  /** 一家申请：冻结当前简历、排一份填表动作；status 决定它走到哪了。 */
  const apply = async (company: string, status: 'pending_review' | 'approved' | 'executing' | 'done') => {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '后端', company_name: company });
    const app = repos.createApplication(job.id);
    const { packet } = await freezePacket(deps, { applicationId: app.id, jobId: job.id, resumeId: master.id });
    const action = repos.enqueueAction('fill_form', { job_id: job.id, packet_id: packet.id, application_id: app.id }, app.id);
    if (status !== 'pending_review') { repos.reviewActions([action.id], 'approved'); if (status !== 'approved') repos.setActionStatus(action.id, status); }
    if (status === 'done') repos.jumpTo(app.id, 'applied', '已投递');
    return { app, action, packet };
  };
  return { repos, store, deps, master, apply };
}

describe('改了共用的简历以后', () => {
  it('没点开始的换成新版（仍等你点开始），点了开始、在填、已投出的列为改不了', async () => {
    const s = await setup();
    const waiting = await s.apply('美团', 'pending_review');
    await s.apply('京东', 'approved');
    await s.apply('华为', 'executing');
    await s.apply('拼多多', 'done');
    s.store.saveResume(s.master.id, { projects: [{ name: '数据中台（改正）' }] });

    const fix = await refreshQueuedPackets(s.deps, s.master.id);
    expect(fix?.swapped_marks.map(m => m.name)).toEqual(['美团']);
    expect(fix?.locked_marks.map(m => m.name).sort()).toEqual(['京东', '拼多多', '华为'].sort());
    const action = s.repos.getAction(waiting.action.id)!;
    expect(action.status).toBe('pending_review');
    expect(action.packet_id).not.toBe(waiting.packet.id);
    expect(s.repos.getPacket(action.packet_id!)!.resume_sha256).toBe(sha256(s.store.getResume(s.master.id)!.row.schema_json));
  });

  it('再跑一次：已经是新版的不再算；内容没改就不出更正卡', async () => {
    const s = await setup();
    await s.apply('美团', 'pending_review');
    expect(await refreshQueuedPackets(s.deps, s.master.id)).toBeNull();
    s.store.saveResume(s.master.id, { projects: [{ name: '改了' }] });
    expect(await refreshQueuedPackets(s.deps, s.master.id)).not.toBeNull();
    expect(await refreshQueuedPackets(s.deps, s.master.id)).toBeNull();
  });
});
