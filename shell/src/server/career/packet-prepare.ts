/**
 * 开跑前冻结材料包（G6「启动就回」）：「投这 N 家」只建投递、排 fill_form（毫秒级），定制与导 PDF 挪到后台运行器里，
 * 每份在认领之后、开始填之前做一次：
 *   有真 JD 没定制 → 按岗位定制（≤ TAILOR_TIMEOUT_MS，没成退回主简历并记下原因）→ 导 PDF → 建材料包（answers_json.resume_plan）。
 * 材料包挂在申请上、记在 kv `apply:packet:<actionId>`：不写进 fill_form 的 payload——改 payload 会让批准失效（repos.updateActionPayload）。
 * 同一动作第二次（重启续跑、失败后再试一次）直接用记下的那份，不再定制、不再导。
 * fill 上传与之后 submit 的审批核对的都是这一份（运行器把 packetId 传给 resumeFileFor 与 persistDriveOutcome）。
 */
import type { ActionQueueItem } from '@career/core';

import { preparePacketPdf, PacketResumePlanSchema, packetResumePlan, resumeStepMessage, type PacketDeps, type PacketResumePlan } from './packets';
import { defaultTailorRunner, tailorJobs, type TailorRunner } from './tailor-for-job';

export type PreparePacketDeps = PacketDeps & {
  /** 按岗位定制一份（测试注入）；缺省用壳里的共享模型跑 tailorForJob。 */
  tailor?: TailorRunner;
  /** 一份定制最多等多久（测试注入）；缺省 TAILOR_TIMEOUT_MS。 */
  tailorTimeoutMs?: number;
};
/** packetId：这一份用的材料包；failed：备不出来（给他看的一句）；null：老动作（没有 resume_plan），按 resume_id 现导。 */
export type PreparedPacket = { packetId: string; plan?: PacketResumePlan } | { failed: string } | null;
type Emit = (ev: Record<string, unknown>) => void;

export const packetKvKey = (actionId: string) => `apply:packet:${actionId}`;
export const TAILORING_MESSAGE = '正在按岗位定制简历…';

/** 这个动作已经有的材料包：payload 里带的（老动作 / 更正卡换过版的）优先，其次开跑前冻结记下的。 */
export function frozenPacketId(repos: PacketDeps['repos'], actionId: string, payload: Record<string, unknown>): string | undefined {
  const own = typeof payload.packet_id === 'string' ? payload.packet_id : undefined;
  const id = own ?? repos.kvGet<string>(packetKvKey(actionId)) ?? undefined;
  return id && repos.getPacket(id) ? id : undefined;
}

const emitStep = (onEvent: Emit, plan: PacketResumePlan | undefined) => {
  const message = resumeStepMessage(plan);
  if (message) onEvent({ type: 'progress', phase: 'drive', kind: 'resume', message });
};

/** 有真 JD 没定制的先定制一份；没成退回原来那份主简历并记下原因。 */
async function tailorIfPlanned(deps: PreparePacketDeps, jobId: string, resumeId: string, plan: PacketResumePlan, onEvent: Emit): Promise<{ resumeId: string; plan: PacketResumePlan }> {
  if (plan.kind !== 'will_tailor') return { resumeId, plan };
  onEvent({ type: 'progress', phase: 'drive', kind: 'resume', message: TAILORING_MESSAGE });
  const runner = deps.tailor ?? defaultTailorRunner(deps.repos, deps.store);
  const r = (await tailorJobs(runner, [{ jobId, masterId: resumeId }], { timeoutMs: deps.tailorTimeoutMs, concurrency: 1 })).get(jobId);
  if (r?.ok) return { resumeId: r.tailored_id, plan: { kind: 'tailored', changes: r.changes } };
  return { resumeId, plan: { kind: 'master', changes: null, reason: r?.reason ?? 'tailor_failed' } };
}

/** 运行器认领之后、开始填之前调：备好（或找回）这一份的材料包，并在进展里说这份用的是哪版简历。从不抛错。 */
export async function preparePacketForAction(deps: PreparePacketDeps, action: Pick<ActionQueueItem, 'id' | 'application_id'>, payload: Record<string, unknown>, onEvent: Emit): Promise<PreparedPacket> {
  const existing = frozenPacketId(deps.repos, action.id, payload);
  if (existing) { emitStep(onEvent, packetResumePlan(deps.repos, existing)); return { packetId: existing }; }
  const planned = PacketResumePlanSchema.safeParse(payload.resume_plan);
  const jobId = typeof payload.job_id === 'string' ? payload.job_id : null;
  const resumeId = typeof payload.resume_id === 'string' ? payload.resume_id : null;
  if (!planned.success || !jobId || !resumeId || !action.application_id) return null;
  try {
    const chosen = await tailorIfPlanned(deps, jobId, resumeId, planned.data, onEvent);
    const pdf = await preparePacketPdf(deps, chosen.resumeId);
    if ('failed' in pdf) return { failed: pdf.failed };
    const packet = pdf.commit({ applicationId: action.application_id, jobId, answers: { resume_plan: chosen.plan } });
    deps.repos.kvSet(packetKvKey(action.id), packet.id);
    // 列上记一笔（不进 payload、不动批准）：更正卡、导出表格按 action_queue.packet_id 找这一份
    deps.repos.db.update('action_queue', action.id, { packet_id: packet.id });
    if (chosen.plan.kind === 'tailored') deps.repos.db.update('application', action.application_id, { resume_tailored_id: chosen.resumeId });
    console.log(`[career] packet ready action=${action.id} packet=${packet.id} kind=${chosen.plan.kind}${chosen.plan.reason ? ` reason=${chosen.plan.reason}` : ''}`);
    emitStep(onEvent, chosen.plan);
    return { packetId: packet.id, plan: chosen.plan };
  } catch (error) {
    console.warn(`[career] packet FAILED action=${action.id} job=${jobId} detail=${error instanceof Error ? error.message : String(error)}`);
    return { failed: '这份简历没备好' };
  }
}
