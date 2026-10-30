/** 求职路由共用的 HTTP 小工具：JSON 响应与请求体取值。career.ts 与按领域拆出的路由文件共用。 */
export type Json = Record<string, unknown>;

export function careerJson(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export const ok = (data: Json = {}, status = 200) => careerJson({ ok: true, ...data }, status);
export const fail = (error: string, status = 400) => careerJson({ ok: false, error }, status);

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export const strOrNull = (v: unknown): string | null | undefined => (v === null ? null : str(v));
