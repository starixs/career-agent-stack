/**
 * 面试与目标岗位的接口（挂在 `/api/career/*` 下，由 career.ts 的路由表展开）：
 * - POST /api/career/interviews/book：电话 / 短信约的面试，用户自己记一场；
 * - GET/POST /api/career/interviews/:id/recordings：上传自己录的面试录音，等语音识别转写后复盘；
 * - POST /api/career/targets：把岗位标成 / 取消目标（只有用户亲手标的才算，系统不替用户认定）。
 */
import type { Repos } from '@career/core';

import { bookInterview } from '../career/interview-link';
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
}
type Handler = (ctx: InterviewRouteCtx) => Promise<Response> | Response;

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** 路由定义（method, path, handler），由调用方套上自己的 route()。 */
export function interviewRoutes(): Array<[string, string, Handler]> {
  return [
    ['POST', '/api/career/interviews/book', (ctx) => {
      const company_name = str(ctx.body.company_name); const when = str(ctx.body.when);
      if (!company_name || !when) return fail('company_name 与 when（面试时间）不能为空');
      try {
        const out = bookInterview(ctx.store, ctx.repos, { company_name, when, title: strOrNull(ctx.body.title), round: strOrNull(ctx.body.round), location: strOrNull(ctx.body.location), note: strOrNull(ctx.body.note), application_id: strOrNull(ctx.body.application_id) });
        ctx.dataChanged(['application', 'application_history', 'interview', 'deadline']);
        return ok(out);
      } catch (error) {
        return fail(errorText(error, '记面试失败'));
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
