/**
 * /api/career/* 的统一响应：`{ ok: true, ...data }` / `{ ok: false, error }`。
 */
type Json = Record<string, unknown>;

function careerJson(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export const ok = (data: Json = {}, status = 200) => careerJson({ ok: true, ...data }, status);
export const fail = (error: string, status = 400) => careerJson({ ok: false, error }, status);
