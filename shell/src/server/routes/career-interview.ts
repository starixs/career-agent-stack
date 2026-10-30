/**
 * 面试与目标岗位的接口（挂在 `/api/career/*` 下，由 career.ts 的路由表展开）：
 * - POST /api/career/interviews/book：电话 / 短信约的面试，用户自己记一场；
 * - GET/POST /api/career/interviews/:id/recordings：上传自己录的面试录音，等语音识别转写后复盘；
 * - POST /api/career/interviews/:id/retro：面试页「说几句」直接复盘，结果留在页面上，不绕到对话；
 * - POST /api/career/targets：把岗位标成 / 取消目标（只有用户亲手标的才算，系统不替用户认定）。
 */
import type { Repos } from '@career/core';

import { bookInterview } from '../career/interview-link';
import { runInterviewRetro, type AskSkill, type PostCard } from '../career/interview-retro-run';
import { listRecordings, saveRecording } from '../career/recordings';
import type { CareerStore } from '../career/store';
import { setTargetJob } from '../career/targets';

import { fail, ok, str, strOrNull, type Json } from './career-http';

export interface InterviewRouteCtx {
  params: Record<string, string>;
  body: Json;
  repos: Repos;
  store: CareerStore;
  recordingsDir: string;
  dataChanged: (tables: string[]) => void;
  /** 调技能（没有模型时为 null）与往对话里放卡（复盘冒出的新说法要确认）。 */
  ask: AskSkill | null;
  postCard: PostCard;
}
type Handler = (ctx: InterviewRouteCtx) => Promise<Response> | Response;

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** 路由定义（method, path, handler），由调用方套上自己的 route()。 */
export function interviewRoutes(): Array<[string, string, Handler]> {
  return [
    ['POST', '/api/career/interviews/book', (ctx) => {
      const company_name = str(ctx.body.company_name); const when = strOrNull(ctx.body.when);
      if (!company_name) return fail('company_name 不能为空');
      try {
        const out = bookInterview(ctx.store, ctx.repos, { company_name, when, title: strOrNull(ctx.body.title), round: strOrNull(ctx.body.round), location: strOrNull(ctx.body.location), note: strOrNull(ctx.body.note), application_id: strOrNull(ctx.body.application_id) });
        ctx.dataChanged(['application', 'application_history', 'interview', 'deadline']);
        return ok(out);
      } catch (error) {
        return fail(errorText(error, '记面试失败'));
      }
    }],
    ['POST', '/api/career/interviews/:id/retro', async (ctx) => {
      const words = str(ctx.body.words);
      if (!words) return fail('words 不能为空');
      const itv = ctx.store.getInterview(ctx.params.id);
      if (!itv) return fail(`面试记录不存在：${ctx.params.id}`, 404);
      if (!ctx.ask) return fail('助理暂时不在线，稍后再复盘');
      try {
        const out = await runInterviewRetro(ctx.store, ctx.repos, ctx.ask, ctx.postCard, { transcript: words, interview_id: itv.id });
        ctx.dataChanged(out.tables);
        return ok({ interview: ctx.store.getInterview(out.interview_id), followups: out.followups.length });
      } catch (error) {
        console.error(`[career] retro FAILED interview=${itv.id}:`, errorText(error, ''));
        return fail(errorText(error, '复盘失败'));
      }
    }],
    ['GET', '/api/career/interviews/:id/recordings', (ctx) => ok({ recordings: listRecordings(ctx.repos, ctx.params.id).map(({ path: _path, ...rest }) => rest) })],
    ['POST', '/api/career/interviews/:id/recordings', async (ctx) => {
      if (!ctx.store.getInterview(ctx.params.id)) return fail(`面试记录不存在：${ctx.params.id}`, 404);
      const name = str(ctx.body.name); const data = str(ctx.body.data);
      if (!name || !data) return fail('需要录音文件名 name 与 base64 内容 data');
      try {
        const rec = await saveRecording(ctx.repos, ctx.recordingsDir, { interview_id: ctx.params.id, name, mime: strOrNull(ctx.body.mime), data_base64: data });
        ctx.dataChanged(['interview']);
        const { path: _path, ...dto } = rec;
        return ok({ recording: dto });
      } catch (error) {
        console.error(`[career] recording upload FAILED interview=${ctx.params.id}:`, errorText(error, ''));
        return fail(errorText(error, '上传录音失败'));
      }
    }],
    ['POST', '/api/career/targets', (ctx) => {
      const job_id = str(ctx.body.job_id);
      if (!job_id || typeof ctx.body.target !== 'boolean') return fail('需要 job_id 与 target（true / false）');
      try {
        setTargetJob(ctx.repos, job_id, ctx.body.target);
        ctx.dataChanged(['kv']);
        return ok({ job_id, target: ctx.body.target });
      } catch (error) {
        return fail(errorText(error, '标记目标失败'));
      }
    }],
  ];
}
