/**
 * 技能成果的读取接口（挂在 `/api/career/*` 下，由 career.ts 的路由表展开）。
 * 技能把结果写进库之后，功能市场和工作台要能读出来给用户看：
 * - GET /api/career/probe-predictions：interview_predict 写的追问预测（含按主简历预测的，resume_tailored_id 为空）；
 * - GET /api/career/job-evaluations：job_evaluate 评估过的岗位（五维评分 + 硬门槛结果），不带 JD 原文。
 */
import type { Repos } from '@career/core';

import type { ProbePrediction } from '../career/store';

import { ok } from './career-http';

export interface SkillRouteCtx { repos: Repos }
type Handler = (ctx: SkillRouteCtx) => Response;

/** 评估过的岗位：列表页只要认得出是哪个岗位，再加两段评估结果。 */
export interface JobEvaluationRow {
  job_id: string; company_name: string | null; title: string; url: string | null;
  score_json: string; prefilter_json: string | null; updated_at: string;
}

export function skillRoutes(): Array<[string, string, Handler]> {
  return [
    ['GET', '/api/career/probe-predictions', ({ repos }) => ok({
      predictions: repos.db.all<ProbePrediction>('SELECT * FROM probe_prediction ORDER BY created_at DESC'),
    })],
    ['GET', '/api/career/job-evaluations', ({ repos }) => ok({
      evaluations: repos.db.all<JobEvaluationRow>(
        'SELECT id AS job_id, company_name, title, url, score_json, prefilter_json, updated_at FROM job WHERE score_json IS NOT NULL ORDER BY updated_at DESC',
      ),
    })],
  ];
}
