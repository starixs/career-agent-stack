/**
 * 一场笔试：搜题记录按场归在一起。第一次粘贴时开一场，之后的粘贴都记在这场里；
 * 公司、岗位跟着这场走，中途改了就更新。记录页按场列出，点开能接着粘。
 */
import type { Db } from '@career/core';

import type { CoreIds } from '../store';

/** 记录页默认列出的场数。 */
export const SESSION_LIST_LIMIT = 50;

export interface ExamSession {
  id: string;
  company_name: string | null;
  role_title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExamSessionSummary extends ExamSession {
  search_count: number;
  question_count: number;
  /** 这场第一道题的题干，公司岗位都空着时拿来认出是哪场。 */
  first_stem: string | null;
}

interface Who { companyName: string | null; roleTitle: string | null }

export class ExamSessionStore {
  constructor(private readonly db: Db, private readonly ids: CoreIds) {}

  get(id: string): ExamSession | undefined {
    return this.db.get<ExamSession>('SELECT * FROM exam_session WHERE id=?', [id]);
  }

  /** 带了 id 就记进那场（并更新公司岗位），没带就开新的一场。 */
  enter(id: string | null, who: Who): ExamSession {
    const t = this.ids.now();
    const existing = id ? this.get(id) : undefined;
    if (id && !existing) throw new Error(`这场笔试不存在：${id}`);
    if (existing) {
      this.db.update('exam_session', existing.id, {
        company_name: who.companyName ?? existing.company_name, role_title: who.roleTitle ?? existing.role_title, updated_at: t,
      });
      return this.get(existing.id)!;
    }
    const created = { id: this.ids.newId('exm'), company_name: who.companyName, role_title: who.roleTitle, created_at: t, updated_at: t };
    this.db.insert('exam_session', created);
    console.log(`[exam-search] 开了一场笔试 ${created.id}：${who.companyName ?? '公司未知'} · ${who.roleTitle ?? '岗位未知'}`);
    return created;
  }

  list(limit = SESSION_LIST_LIMIT): ExamSessionSummary[] {
    return this.db.all<ExamSessionSummary>(
      `SELECT s.*,
              COUNT(e.id) AS search_count,
              COALESCE(SUM(json_array_length(e.questions_json)), 0) AS question_count,
              (SELECT json_extract(f.questions_json, '$[0].stem') FROM exam_search f
                WHERE f.session_id = s.id ORDER BY f.created_at LIMIT 1) AS first_stem
         FROM exam_session s
         JOIN exam_search e ON e.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?`,
      [limit],
    );
  }

  remove(id: string): boolean {
    this.db.run('DELETE FROM exam_search WHERE session_id=?', [id]);
    return this.db.run('DELETE FROM exam_session WHERE id=?', [id]).changes > 0;
  }
}
