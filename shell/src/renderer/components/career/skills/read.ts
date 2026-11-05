/**
 * 技能产出是模型写的 JSON，库里不校验形状：字段可能缺、类型可能不对、不同版本的提示词叫法不一样。
 * 这里把 unknown 收窄成页面要用的几种形状；收不出来就给空值，由调用方决定退回通用展示。
 */

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 解析库里的 JSON 字段；不是合法 JSON 时记一笔并当作没有。 */
export function parseJson(raw: string | null | undefined, where: string): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    console.warn(`[career-skills] ${where} 不是合法 JSON：`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function dict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 取一段可以直接显示的文字；数字也算，空串当没有。 */
export function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 依次试几个字段名，取第一个有内容的。 */
export function pickText(source: Dict, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = text(source[key]);
    if (found) return found;
  }
  return null;
}

/**
 * 一组文字：数组里的字符串原样取；对象取它最像正文的那个字段；单个字符串当成一条。
 * 模型有时给 `["a","b"]`，有时给 `[{reason:"a"}]`，有时干脆给一句话。
 */
export function texts(value: unknown, ...objectKeys: string[]): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  const keys = objectKeys.length ? objectKeys : ['text', 'item', 'reason', 'requirement', 'title', 'question', 'name'];
  return list(value)
    .map(item => (isDict(item) ? pickText(item, ...keys) : text(item)))
    .filter((item): item is string => item !== null);
}

export function dicts(value: unknown): Dict[] {
  return list(value).filter(isDict);
}
