/**
 * 下一步条的字面规则（plan-r2 §B.5）：一条 ≤22 字；公司名最多点 2 家 + "等 n 家"；长名截到 5 字 + "…"。
 */
import { SUGGEST_MAX_CHARS } from '../../shared/careerSuggest';

/** 公司名超过几个字就截：一格里还要放动词和数字。 */
export const COMPANY_NAME_MAX = 6;
/** 截断后留几个字（再加一个"…"）。 */
export const COMPANY_NAME_KEEP = 5;
/** 一句话里最多点名几家。 */
export const NAMED_COMPANIES_MAX = 2;

const LEGAL_SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团|公司)$/;

/** 去掉"有限公司"之类的尾巴，再按 §B.5 截断。 */
export function shortCompany(name: string): string {
  const base = name.trim().replace(/[（(].*?[）)]/g, '').replace(LEGAL_SUFFIX, '').trim() || name.trim();
  return base.length > COMPANY_NAME_MAX ? `${base.slice(0, COMPANY_NAME_KEEP)}…` : base;
}

/** 去重后的短名列表。 */
function shortNames(companies: readonly string[]): string[] {
  return [...new Set(companies.map(shortCompany).filter(Boolean))];
}

/**
 * "华为、字节" / "华为、字节等 5 家"。total 是总家数（≥ 列出的家数）；
 * 列出的已经是全部时不说"等 n 家"。
 */
export function namesPhrase(companies: readonly string[], total = companies.length): string {
  const names = shortNames(companies).slice(0, NAMED_COMPANIES_MAX);
  if (!names.length) return total > 0 ? `${total} 家` : '';
  const head = names.join('、');
  return total > names.length ? `${head}等 ${total} 家` : head;
}

/** 从几种写法里取第一条放得下的；都放不下返回 null。 */
export function fitText(...options: Array<string | null | undefined>): string | null {
  for (const option of options) {
    const t = option?.trim();
    if (t && t.length <= SUGGEST_MAX_CHARS) return t;
  }
  return null;
}
