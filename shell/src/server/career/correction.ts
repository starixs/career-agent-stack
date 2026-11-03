/**
 * 改了一批申请共用的简历以后（规范 CAREER_INTELLIGENT_UI.md §5.7 更正卡，§8.4）：
 *  - 还没开始填的（排着队等后台轮到的 approved，或退回待审的 pending_review）：重新冻结材料包，换成新版。
 *    换版不作废你「开始投」的那次批准（2026-10-30 你定；没有待投清单以后，排队的那几份就是原来「没点开始」的那几份）。
 *  - 其余用了旧版的（在填、待提交、已投出）：改不了，如实列出来。
 * 只看材料包里冻结的简历内容和现在不一样的申请；同一份简历没改内容就什么都不发生。
 */
import { createHash } from 'crypto';

import { companyMarkOf, type ActionQueueItem, type ApplicationPacket, type ApprovalSource, type CompanyMark, type Repos } from '@career/core';

import { freezePacket, type PacketDeps } from './packets';

export interface CorrectionResult { resume_id: string; swapped: string[]; locked: string[]; swapped_marks: CompanyMark[]; locked_marks: CompanyMark[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Use { action: ActionQueueItem; packet: ApplicationPacket; applicationId: string }

/** 每份申请最近一次填表动作用的材料包；只留冻结的是这份简历、而且内容已经过期的。 */
function staleUses(repos: Repos, resumeId: string, currentSha: string): Use[] {
  const latest = new Map<string, Use>();
  for (const action of repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind='fill_form' AND packet_id IS NOT NULL AND application_id IS NOT NULL ORDER BY created_at`)) {
    const packet = repos.getPacket(action.packet_id!);
    if (packet) latest.set(action.application_id!, { action, packet, applicationId: action.application_id! });
  }
  return [...latest.values()].filter(u => u.packet.resume_id === resumeId && u.packet.resume_sha256 !== null && u.packet.resume_sha256 !== currentSha);
}

function markOf(repos: Repos, applicationId: string): CompanyMark {
  const app = repos.getApplication(applicationId);
  const job = app ? repos.getJob(app.job_id) : undefined;
  return companyMarkOf(job?.company_name, job?.company_id ?? null);
}

function parsePayload(action: ActionQueueItem): Record<string, unknown> {
  try { const v: unknown = JSON.parse(action.payload_json); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch (e) {
    throw new Error(`填表动作 ${action.id} 的 payload 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 换材料包：改内容会让批准失效（updateActionPayload），排队中的那几份当场按原批准人再批一次，后台照常轮到它。
 * 换的这一刻后台已经认领开填了（状态不对）就算改不了，返回 false。
 */
const APPROVERS: readonly ApprovalSource[] = ['user', 'auto', 'learned', 'system'];
function swapPacket(repos: Repos, action: ActionQueueItem, packetId: string): boolean {
  const wasApproved = action.status === 'approved';
  try { repos.updateActionPayload(action.id, { ...parsePayload(action), packet_id: packetId }); } catch (e) {
    console.warn(`[career] correction: ${action.id} 换版时已开始填，改不了：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (wasApproved) repos.reviewActions([action.id], 'approved', APPROVERS.find(x => x === action.approved_by) ?? 'system');
  return true;
}

/** 换版并分堆。没有受影响的申请时返回 null（不出更正卡）。 */
export async function refreshQueuedPackets(deps: PacketDeps, resumeId: string): Promise<CorrectionResult | null> {
  const found = deps.store.getResume(resumeId);
  if (!found) throw new Error(`简历不存在：${resumeId}`);
  const uses = staleUses(deps.repos, resumeId, sha(found.row.schema_json));
  if (!uses.length) return null;
  const swapped: string[] = []; const locked: string[] = [];
  for (const u of uses) {
    if (u.action.status !== 'pending_review' && u.action.status !== 'approved') { locked.push(u.applicationId); continue; }
    const { packet, warning } = await freezePacket(deps, { applicationId: u.applicationId, jobId: u.packet.job_id, resumeId });
    if (warning) console.warn(`[career] correction: ${u.applicationId} 换版时 ${warning}`);
    if (swapPacket(deps.repos, u.action, packet.id)) swapped.push(u.applicationId); else locked.push(u.applicationId);
  }
  return { resume_id: resumeId, swapped, locked, swapped_marks: swapped.map(id => markOf(deps.repos, id)), locked_marks: locked.map(id => markOf(deps.repos, id)) };
}

/** 页面上（工作台自动保存）改简历：停手一会儿再换版，免得每敲一个字都导一次 PDF。 */
const SETTLE_MS = 20_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleRefresh(deps: () => PacketDeps, resumeId: string, onDone: (r: CorrectionResult | null) => void): void {
  clearTimeout(timers.get(resumeId));
  timers.set(resumeId, setTimeout(() => {
    timers.delete(resumeId);
    refreshQueuedPackets(deps(), resumeId).then(onDone, (e: unknown) => console.error(`[career] correction FAILED resume=${resumeId}`, e instanceof Error ? e.message : e));
  }, SETTLE_MS));
}
