/**
 * 开跑前冻结材料包（G6）：will_tailor 先定制再冻结、定制超时退主简历、PDF 导不出来不建材料包、同一动作第二次不重做。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCore } from './core-module';
import { prepareJobs } from './job-board';
import { frozenPacketId, packetKvKey, preparePacketForAction, TAILORING_MESSAGE, type PreparePacketDeps } from './packet-prepare';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

const REAL_JD = '岗位职责：负责经营数据分析，搭建指标体系。任职要求：熟练 SQL，有 AB 实验经验。';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-packet-prepare-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function setup(over: Partial<PreparePacketDeps> = {}) {
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, await loadCore());
  let exports = 0;
  const exportPdf = async (id: string) => { exports++; const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${id}`); return p; };
  const deps: PreparePacketDeps = { repos, store, exportPdf, exportsDir: dir, ...over };
  const master = store.createResumeMaster({ name: '通用版', schema_json: { basics: { name: '小林' }, skills: ['SQL'] } });
  /** 走真入口排一份 fill_form（和「投这 N 家」一样），返回动作与 payload。 */
  const enqueue = async (jdRaw: string | null) => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '京东', url: `https://jd.com/${Math.random()}`, jd_raw: jdRaw });
    const [r] = await prepareJobs(deps, [job.id]);
    const action = repos.getAction(r.action_id!)!;
    return { job, action, payload: JSON.parse(action.payload_json) as Record<string, unknown> };
  };
  return { repos, store, deps, master, enqueue, exports: () => exports };
}

const collect = () => { const events: Array<Record<string, unknown>> = []; return { events, onEvent: (e: Record<string, unknown>) => { events.push(e); }, messages: () => events.map(e => e.message) }; };

describe('preparePacketForAction', () => {
  it('will_tailor 先定制再冻结', async () => {
    const { repos, store, master, enqueue } = await setup();
    const tailor = async ({ jobId, masterId }: { jobId: string; masterId: string }) => {
      const t = store.createTailored({ master_id: masterId, job_id: jobId, schema_json: master.schema_json });
      store.confirmTailored(t.id, { basics: { name: '小林' }, skills: ['SQL', 'AB 实验'] });
      return { tailored_id: t.id, changes: 2 };
    };
    const { action, payload } = await enqueue(REAL_JD);
    const sink = collect();
    const out = await preparePacketForAction({ repos, store, exportPdf: async id => { const p = join(dir, `${id}.pdf`); writeFileSync(p, 'x'); return p; }, exportsDir: dir, tailor }, action, payload, sink.onEvent);
    expect(out && 'packetId' in out).toBe(true);
    const packet = repos.getPacket((out as { packetId: string }).packetId)!;
    expect(packet.resume_kind).toBe('tailored');
    expect(packet.resume_pdf_sha256).toBeTruthy();
    expect(JSON.parse(packet.answers_json).resume_plan).toEqual({ kind: 'tailored', changes: 2 });
    expect(sink.messages()).toEqual([TAILORING_MESSAGE, '定制简历 ✓ 改 2 处']);
    // 批准不动：payload 没改、仍是 approved 之前的内容哈希；列上记了材料包
    expect(repos.getAction(action.id)!.payload_json).toBe(action.payload_json);
    expect(repos.getAction(action.id)!.packet_id).toBe(packet.id);
    expect(repos.getApplication(action.application_id!)!.resume_tailored_id).toBe(store.listResumeTailored()[0].id);
  });

  it('定制超时退主简历、材料包 reason=tailor_timeout', async () => {
    const { repos, deps, master, enqueue } = await setup({ tailor: () => new Promise<never>(() => undefined), tailorTimeoutMs: 20 });
    const { action, payload } = await enqueue(REAL_JD);
    const sink = collect();
    const out = await preparePacketForAction(deps, action, payload, sink.onEvent);
    const packet = repos.getPacket((out as { packetId: string }).packetId)!;
    expect(packet.resume_id).toBe(master.id);
    expect(packet.resume_kind).toBe('master');
    expect(JSON.parse(packet.answers_json).resume_plan).toEqual({ kind: 'master', changes: null, reason: 'tailor_timeout' });
    expect(sink.messages()).toEqual([TAILORING_MESSAGE, '用主简历（这次定制没成）']);
  });

  it('没 JD 的不定制，进展说用主简历', async () => {
    const { deps, enqueue } = await setup({ tailor: async () => { throw new Error('不该被调用'); } });
    const { action, payload } = await enqueue(null);
    const sink = collect();
    expect(await preparePacketForAction(deps, action, payload, sink.onEvent)).toMatchObject({ packetId: expect.any(String) });
    expect(sink.messages()).toEqual(['用主简历（没拿到岗位描述）']);
  });

  it('PDF 导不出来 → failed，不建材料包', async () => {
    const { repos, deps, enqueue } = await setup();
    const { action, payload } = await enqueue(null);
    const out = await preparePacketForAction({ ...deps, exportPdf: async () => { throw new Error('chrome 没起来'); } }, action, payload, () => undefined);
    expect(out).toEqual({ failed: '简历 PDF 没导出来' });
    expect(repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM application_packet')?.n).toBe(0);
    expect(repos.kvGet(packetKvKey(action.id))).toBeUndefined();
  });

  it('同一动作第二次不重做', async () => {
    let tailored = 0;
    const { deps, store, master, enqueue, exports } = await setup();
    const tailor = async ({ jobId, masterId }: { jobId: string; masterId: string }) => {
      tailored++;
      const t = store.createTailored({ master_id: masterId, job_id: jobId, schema_json: master.schema_json });
      store.confirmTailored(t.id, { skills: ['SQL', 'Hive'] });
      return { tailored_id: t.id, changes: 1 };
    };
    const { action, payload } = await enqueue(REAL_JD);
    const first = await preparePacketForAction({ ...deps, tailor }, action, payload, () => undefined);
    const sink = collect();
    const again = await preparePacketForAction({ ...deps, tailor }, action, payload, sink.onEvent);
    expect(again).toEqual({ packetId: (first as { packetId: string }).packetId });
    expect(tailored).toBe(1);
    expect(exports()).toBe(1);
    expect(sink.messages()).toEqual(['定制简历 ✓ 改 1 处']);
    expect(frozenPacketId(deps.repos, action.id, payload)).toBe((first as { packetId: string }).packetId);
  });

  it('老动作没有 resume_plan：不备，返回 null（按 resume_id 现导）', async () => {
    const { repos, deps } = await setup();
    const action = repos.enqueueAction('fill_form', { url: 'https://x.com/1', resume_id: 'r1' });
    expect(await preparePacketForAction(deps, action, { url: 'https://x.com/1', resume_id: 'r1' }, () => undefined)).toBeNull();
  });
});
