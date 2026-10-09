/**
 * 投递材料包：入队（apply_prepare / mail_compose）时把要投的简历冻结下来——
 * 简历内容快照进 resume_snapshot，PDF 按内容哈希存到 `exports/packets/<sha256>.pdf`（同内容只存一份、永不覆盖），
 * JD 原文进 application_packet.jd_snapshot_json。动作 payload 只带 packet_id，审批哈希因此覆盖了简历与附件内容；
 * 执行时（对话 apply_run、后台批量、邮件发送）一律从材料包取文件，并核对文件哈希。
 *
 * 旧动作没有 packet_id：退回"按 resume_id 现导"，行为与以前一致。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { ApplicationPacket, Repos } from '@career/core';

import type { CareerStore } from './store';

export interface PacketDeps {
  repos: Repos;
  store: CareerStore;
  /** 导出 PDF（渲染前解私密库占位符）；返回文件路径。 */
  exportPdf: (resumeId: string) => Promise<string>;
  exportsDir: string;
}

export interface FrozenPacket { packet: ApplicationPacket; warning?: string }

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 选要投的简历：显式指定 → 这个岗位最近一份定制简历 → 唯一一份主简历。
 * 多份主简历又没指定时返回 undefined，由调用方让用户选（不替用户猜）。
 */
export function pickResumeForJob(store: CareerStore, jobId: string | null | undefined, explicit?: string | null): { id: string; kind: 'master' | 'tailored'; reason: string } | undefined {
  if (explicit) {
    const found = store.getResume(explicit);
    return found ? { id: explicit, kind: found.kind, reason: '指定' } : undefined;
  }
  if (jobId) {
    const tailored = store.listResumeTailored().filter(t => t.job_id === jobId).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    if (tailored) return { id: tailored.id, kind: 'tailored', reason: '这个岗位的定制简历' };
  }
  const masters = store.listResumeMasters();
  if (masters.length === 1) return { id: masters[0].id, kind: 'master', reason: '唯一一份主简历' };
  return undefined;
}

export async function freezePacket(deps: PacketDeps, input: { applicationId?: string | null; jobId?: string | null; resumeId?: string | null; answers?: unknown }): Promise<FrozenPacket> {
  const found = input.resumeId ? deps.store.getResume(input.resumeId) : undefined;
  let pdfPath: string | null = null;
  let pdfSha: string | null = null;
  let warning: string | undefined;
  if (found) {
    try {
      const exported = await deps.exportPdf(found.row.id);
      pdfSha = fileSha256(exported);
      const dir = join(deps.exportsDir, 'packets');
      mkdirSync(dir, { recursive: true });
      pdfPath = join(dir, `${pdfSha}.pdf`);
      if (!existsSync(pdfPath)) copyFileSync(exported, pdfPath);
    } catch (error) {
      warning = `简历 PDF 导出失败，这次投递不会上传附件：${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (input.resumeId) {
    warning = `简历不存在：${input.resumeId}`;
  }
  const packet = deps.repos.createPacket({
    application_id: input.applicationId ?? null,
    job_id: input.jobId ?? null,
    resume_id: found?.row.id ?? null,
    resume_kind: found?.kind ?? null,
    resume_schema_json: found?.row.schema_json ?? null,
    resume_pdf_path: pdfPath,
    resume_pdf_sha256: pdfSha,
    answers: input.answers,
  });
  return { packet, ...(warning ? { warning } : {}) };
}

/**
 * 执行时取材料包里的简历文件：文件还在且哈希对得上才用；对不上说明被改过，拒绝上传（返回 error）。
 * 没有材料包的旧动作走 legacy（按 resume_id 现导）。
 */
export async function packetResumeFile(
  repos: Repos,
  payload: Record<string, unknown>,
  legacy?: (resumeId: unknown) => Promise<string | undefined>,
): Promise<{ path?: string; error?: string }> {
  const packetId = typeof payload.packet_id === 'string' ? payload.packet_id : undefined;
  if (!packetId) return { path: await legacy?.(payload.resume_id) };
  const packet = repos.getPacket(packetId);
  if (!packet) return { error: `投递材料包不存在：${packetId}` };
  if (!packet.resume_pdf_path) return {};
  if (!existsSync(packet.resume_pdf_path)) return { error: `材料包里的简历文件不见了：${packet.resume_pdf_path}` };
  if (packet.resume_pdf_sha256 && fileSha256(packet.resume_pdf_path) !== packet.resume_pdf_sha256) return { error: '材料包里的简历文件与批准时不一致，已停止上传，请重新准备这份投递' };
  return { path: packet.resume_pdf_path };
}
