/**
 * 素材起草：material-draft 技能 + 已有素材 + 对该公司说过的话（一致性）。路由与工具共用。
 */
import type { Material, MaterialKind } from '@career/core';

import type { IntakeDeps } from './intake';
import { loadSkillPrompt } from './skills';

export interface MaterialDraftInput {
  kind: MaterialKind;
  question: string;
  length?: string;
  job_id?: string | null;
  application_id?: string | null;
  company_name?: string | null;
  extra?: string;
}
export interface MaterialDraftOutput {
  drafts?: Array<{ length_variant?: string; content: string; claim_ids?: string[]; reused_material_id?: string }>;
  question_key?: string;
  conflicts?: Array<{ field: string; said_before: string; now: string; where?: string }>;
  placeholders?: Array<{ text: string; why: string }>;
  save_as?: { kind?: MaterialKind; title?: string };
}

export async function draftMaterial(deps: IntakeDeps, input: MaterialDraftInput): Promise<{ output: MaterialDraftOutput; reused: Material[]; said_before: string[] }> {
  const r = deps.repos;
  if (!deps.llm) throw new Error('模型不可用');
  const app = input.application_id ? r.getApplication(input.application_id) : undefined;
  const job = input.job_id ? r.getJob(input.job_id) : app ? r.getJob(app.job_id) : undefined;
  const company = input.company_name ?? job?.company_name ?? null;
  const reused = r.listMaterials({ kind: input.kind, company: company ?? undefined });
  const uses = company ? r.listMaterialUses({ company_name: company }) : [];
  const notes = app ? r.listDossierNotes(app.id).filter(n => n.kind === 'said') : [];
  const saidBefore = [...uses.map(u => `[${u.context}] ${u.content_snapshot.slice(0, 400)}`), ...notes.map(n => `[面试 ${n.round ?? ''} 说过] ${n.content}`)];
  const claims = r.listClaims().filter(c => c.status !== 'pending').map(c => `- [${c.id}] ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '（无）';
  const system = await loadSkillPrompt('material-draft');
  const user = [
    `素材类型：${input.kind}\n问题原文：${input.question}\n长度要求：${input.length ?? '按常规'}`,
    `目标公司：${company ?? '未指定'}；岗位：${job?.title ?? '未指定'}`,
    job?.jd_parsed_json ? `JdParsed：${job.jd_parsed_json.slice(0, 4000)}` : '',
    `已有同类素材：\n${reused.map(m => `- [${m.id}]${m.confirmed ? '（已确认）' : ''} ${m.title}：${m.content.slice(0, 500)}`).join('\n') || '（无）'}`,
    `对这家公司已经说过的内容：\n${saidBefore.join('\n') || '（无）'}`,
    `已确认主张：\n${claims}`,
    input.extra ? `用户补充：${input.extra}` : '',
  ].filter(Boolean).join('\n\n');
  const res = await deps.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.4 });
  const output = deps.core.extractJson<MaterialDraftOutput>(res.text);
  return { output, reused, said_before: saidBefore };
}
