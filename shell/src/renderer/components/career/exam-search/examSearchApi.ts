/**
 * 笔试搜题的前端接口与类型（后端见 src/server/routes/career-exam-search.ts）。
 * 类型与 src/server/career/exam-search/{bank,llm-steps,service}.ts 对齐。
 */
import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';

import { careerPath, pickList, pickObject } from '../careerApi';

export type MatchTier = 'same-role-company' | 'same-role' | 'same-company' | 'general';
export type QuestionType = 'single' | 'multi' | 'judge' | 'fill' | 'short' | 'personality';

export interface BankMatch {
  item_id: string; stem: string; options: string[]; answer: string | null; explanation: string | null;
  company_name: string | null; role_title: string | null; year: number | null;
  bank_name: string; origin: 'builtin' | 'user'; tier: MatchTier; similarity: number; same: boolean;
}

export interface SearchQuestion { index: number; stem: string; options: string[]; qtype: QuestionType | null; matches: BankMatch[] }
export interface QuestionAnswer {
  index: number; answer: string; explanation: string;
  confidence: 'high' | 'medium' | 'low'; source: 'bank' | 'reference' | 'model'; ref_item_id: string | null;
}

export interface ExamSearchRecord {
  id: string; session_id: string; company_name: string | null; role_title: string | null; input_kind: 'image' | 'text'; input_text: string | null; material: string | null;
  questions: SearchQuestion[]; answers: QuestionAnswer[]; status: 'recognized' | 'answered' | 'failed'; error: string | null;
  created_at: string; updated_at: string;
}

export interface ExamSession { id: string; company_name: string | null; role_title: string | null; created_at: string; updated_at: string }
export interface ExamSessionSummary extends ExamSession { search_count: number; question_count: number; first_stem: string | null }

export interface ExamBank {
  id: string; name: string; origin: 'builtin' | 'user'; company_name: string | null; role_title: string | null; year: number | null;
  source_file: string | null; item_count: number; status: 'importing' | 'ready' | 'failed'; error: string | null; created_at: string;
}

export interface ExamContext { deadline_id: string; kind: string; title: string; due_at: string; company_name: string | null; role_title: string | null }

export interface ScreenshotInput { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }

const path = (p: string) => careerPath(`/exam-search${p}`);

export const examSearchApi = {
  recognize: (body: { session_id?: string; image?: ScreenshotInput; text?: string; company_name?: string; role_title?: string }) =>
    apiPostJson<unknown>(path('/recognize'), body)
      .then(r => ({ search: pickObject<ExamSearchRecord>(r, 'search'), session: pickObject<ExamSession>(r, 'session') })),
  answer: (id: string) => apiPostJson<unknown>(path(`/${encodeURIComponent(id)}/answer`), {}).then(r => pickObject<ExamSearchRecord>(r, 'search')),
  sessions: () => apiGetJson<unknown>(path('/sessions')).then(r => pickList<ExamSessionSummary>(r, 'sessions')),
  session: (id: string) => apiGetJson<unknown>(path(`/sessions/${encodeURIComponent(id)}`))
    .then(r => ({ session: pickObject<ExamSession>(r, 'session'), searches: pickList<ExamSearchRecord>(r, 'searches') })),
  removeSession: (id: string) => apiDelete<unknown>(path(`/sessions/${encodeURIComponent(id)}`)),
  contexts: () => apiGetJson<unknown>(path('/contexts')).then(r => pickList<ExamContext>(r, 'contexts')),
  banks: () => apiGetJson<unknown>(path('/banks')).then(r => pickList<ExamBank>(r, 'banks')),
  importBank: (body: { file_name: string; data: string; name?: string; company_name?: string; role_title?: string; year?: number }) =>
    apiPostJson<unknown>(path('/banks'), body).then(r => pickObject<ExamBank>(r, 'bank')),
  removeBank: (id: string) => apiDelete<unknown>(path(`/banks/${encodeURIComponent(id)}`)),
};

/** File / Blob → base64（不带 data: 前缀）。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}
