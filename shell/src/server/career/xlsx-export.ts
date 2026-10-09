/**
 * 导出个人求职表格（R08：本地存 ID 的几张表导出成一个 Excel，方便自己看 / 打印 / 交给老师）。
 *
 * 工作表：岗位汇总（含匹配与我的进度）/ 投递进度（阶段、提交方式、用的哪份简历）/ 网申答案 / 题库（有题目时）。
 * 每张表都带稳定 id（job_key / 投递 id / 题目 id），重新导入或对账时能对上。个人信息与自我认同类答案不导出值。
 * 写到 `exports/求职表格-<日期>.xlsx`，返回路径。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repos } from '@career/core';

import { jobBoard } from './job-board';

const STAGE: Record<string, string> = { evaluated: '已评估', ready: '待准备', approved: '已同意投递', pending: '投递中', needs_user: '需要你', blocked: '卡住', applied: '已投递', responded: '已回复', interview: '面试中', offer: 'Offer', rejected: '未通过', discarded: '已放弃', skip: '跳过', hired: '已入职' };
const TYPE: Record<string, string> = { campus: '校招', intern: '实习', social: '社招', unknown: '' };

export async function exportCareerWorkbook(repos: Repos, exportsDir: string, now = new Date()): Promise<{ path: string; sheets: Record<string, number> }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const sheets: Record<string, number> = {};
  const add = (name: string, rows: Array<Record<string, unknown>>) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 说明: '暂无数据' }]);
    XLSX.utils.book_append_sheet(wb, ws, name);
    sheets[name] = rows.length;
  };

  add('岗位汇总', jobBoard(repos, { sort: 'deadline' }).map(({ job, match, application }) => ({
    岗位键: job.job_key, 公司: job.company_name ?? '', 岗位: job.title, 类型: TYPE[job.employment_type ?? 'unknown'] ?? '', 届别: job.cohort ?? '', 地点: job.location ?? '',
    截止: job.deadline?.slice(0, 10) ?? '', 截止已核实: job.deadline_verified_at ? '是' : '否', 匹配分: match?.score ?? '', 符合条件: match ? (match.hard_ok ? '是' : '否') : '',
    匹配说明: match?.summary ?? '', 我的进度: application ? STAGE[application.stage] ?? application.stage : '未投递', 网申链接: job.url ?? '', 来源: job.source_platform,
  })));

  const jobs = new Map(repos.listJobs().map(j => [j.id, j]));
  add('投递进度', repos.listApplications().map(a => {
    const job = jobs.get(a.job_id);
    const packet = a.packet_id ? repos.getPacket(a.packet_id) : undefined;
    const submit = repos.listActions().find(x => x.application_id === a.id && x.kind === 'submit' && x.status === 'done');
    return {
      投递id: a.id, 岗位键: job?.job_key ?? '', 公司: job?.company_name ?? '', 岗位: job?.title ?? '', 阶段: STAGE[a.stage] ?? a.stage, 下一步: a.next_action ?? '',
      下一步到期: a.next_action_due?.slice(0, 10) ?? '', 卡点: a.blocker_reason ?? '', 提交依据: a.submission_evidence ?? '',
      提交方式: submit ? ({ user: '你批准后提交', auto: 'auto 模式', learned: '自学习免确认' } as Record<string, string>)[submit.approved_by ?? ''] ?? '' : '',
      用的简历: packet?.resume_id ?? '', 简历文件哈希: packet?.resume_pdf_sha256?.slice(0, 12) ?? '', 更新于: a.updated_at.slice(0, 16).replace('T', ' '),
    };
  }));

  add('网申答案', repos.listAnswers().map(a => ({
    问题: a.question_text, 答案: a.sensitivity === 'normal' ? a.answer : '（个人信息，不导出）', 状态: a.status === 'pinned' ? '总是用这条' : '在用', 来源: a.source, 用过次数: a.use_count, 更新于: a.updated_at.slice(0, 10),
  })));

  const questions = repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='question'`)?.n
    ? repos.db.all<Record<string, unknown>>('SELECT id, kind, company_name, title, content, source, seen_count, last_attempt_score FROM question ORDER BY updated_at DESC') : [];
  if (questions.length) add('题库', questions.map(q => ({ 题目id: q.id, 类型: q.kind, 公司: q.company_name ?? '', 岗位: q.title ?? '', 题目: q.content, 来源: q.source, 见过次数: q.seen_count, 最近得分: q.last_attempt_score ?? '' })));

  mkdirSync(exportsDir, { recursive: true });
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const path = join(exportsDir, `求职表格-${day}.xlsx`);
  // ESM 版 SheetJS 的 writeFile 需要 set_fs；直接写 buffer 更稳
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  return { path, sheets };
}
