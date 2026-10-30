/**
 * 填表引擎打开的是校招首页 / 合集页时，去站里找哪种岗位（@career/apply navigate.ts 的 PositionTarget）。
 *
 * 岗位库里多是「XX 公司 2027 校招」「软件类 / 通信类 / IC 类」这一层（立场 10：投不了是我们的工程问题），
 * 所以要从用户的求职方向（job_prefs.keywords）和库里岗位名的片段里拼出：打分用的说法、站内搜索词、期望城市。
 */
import type { Job, JobPrefs } from '@career/core';

import { expandJobQuery } from '../../shared/jobSearch';

export interface PositionTarget { terms: string[]; search: string[]; prefer: string[] }

/** 英文岗位名常见的城市写法（外企校招页多是「Shanghai_xxx Intern」）。 */
const CITY_EN: Record<string, string> = { 上海: 'shanghai', 北京: 'beijing', 深圳: 'shenzhen', 广州: 'guangzhou', 杭州: 'hangzhou', 南京: 'nanjing', 成都: 'chengdu', 武汉: 'wuhan', 苏州: 'suzhou', 合肥: 'hefei' };
/** 技术方向搜不到时退一步的通用词：总比空手报「没表单」强。 */
const TECH_FALLBACK = ['开发', '研发', '软件', 'software', 'developer', 'engineer'];
const TECH_HINT = /(开发|研发|后端|前端|算法|测试|数据|运维|软件|java|python|go|c\+\+|engineer|developer)/i;

/** 「软件类 / 通信类 / IC类 等7个岗位」→ ['软件类', '通信类', 'IC类']。 */
export function titleParts(title: string): string[] {
  return title.replace(/等\s*\d+\s*个岗位/g, '').split(/[/／、|]+/).map(s => s.trim()).filter(s => s.length >= 2 && !/^20\d\d届|^其他$/.test(s));
}

export function positionTargetFor(prefs: JobPrefs, job: Pick<Job, 'title'> | null): PositionTarget | null {
  const directions = (prefs.keywords ?? []).map(k => k.trim()).filter(Boolean);
  const expanded = directions.flatMap(d => expandJobQuery(d));
  const parts = job ? titleParts(job.title) : [];
  // 库里岗位名里和方向沾边的片段排前面（「软件类」比「IC类」更该点）
  const relevant = parts.filter(p => expanded.some(t => p.toLowerCase().includes(t)) || TECH_HINT.test(p));
  const tech = directions.some(d => TECH_HINT.test(d)) || relevant.length > 0;
  const terms = [...new Set([...expanded, ...relevant, ...(tech ? TECH_FALLBACK : [])])];
  if (!terms.length) return null;
  // 站内搜索：先用户自己的说法，再用这家公司自己的分类名（「软件类」），再同义词，最后通用的「开发」
  const search = [...new Set([...directions, ...relevant, ...expanded.slice(1, 3), ...(tech ? ['开发'] : [])])].slice(0, 4);
  const prefer = (prefs.cities ?? []).flatMap(c => [c, CITY_EN[c]].filter((x): x is string => !!x));
  return { terms, search, prefer };
}
