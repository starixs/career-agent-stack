/**
 * 下一步条 r4 · 意图解析（plan-r4-suggest §3.2）：模型写 {text, intent, target}，target 是自然语言引用
 * （"picked" / 公司名 / "登录" / 选项原文 / "dossier:平安"），这里换成带真 id 的 SuggestAction。
 * 换不出来的格丢掉并记 `[career-suggest] unresolved <intent> <target>`；越界的意图按 say 处理（文字仍可用）。
 */
import type { AskKind } from '@career/core';
import { z } from 'zod';

import { isFeatureId } from '../../shared/careerFeatures';
import {
  SUGGEST_MAX_CHIPS, type SuggestAction, type SuggestChip, type SuggestMode, type SuggestSurface,
} from '../../shared/careerSuggest';
import { FEATURE_SEED_PREFIX, slotOf } from './suggest-chip';
import { SUGGEST_INTENTS, type SuggestIntent } from './suggest-guide-types';
import { shortCompany } from './suggest-text';
import type { SuggestAsk, SuggestState } from './suggest-types';

/**
 * 模型输出的一格（紧凑行）：["文字"] 或 ["文字","intent"] 或 ["文字","intent","target"]。
 * intent 省略 = say；不认识的退成 say，不整条作废。mode 不由模型写，服务端按意图推（modeOf）。
 */
export interface ModelChip {
  text: string;
  intent: SuggestIntent;
  target: string | null;
}

const ModelIntent = z.enum(SUGGEST_INTENTS).catch('say');
/** 一行 1–3 个字符串（target 可为 null）；多一列、少文字、非字符串的整行丢。 */
const ModelRow = z.array(z.string().nullable()).min(1).max(3).transform((row): ModelChip | null => {
  const [text, intent, target] = row;
  if (typeof text !== 'string') return null;
  return { text, intent: ModelIntent.parse(intent ?? 'say'), target: target ?? null };
});

/** 最多收几条：要 4 条，多给的留给 lint 丢了以后补位。 */
const MODEL_CHIPS_MAX = SUGGEST_MAX_CHIPS * 2;
/** 模型整体输出：{"c":[行, …]}；c 缺了或不是数组 → 解析失败（调用方走兜底）。 */
export const ModelOut = z.object({ c: z.array(z.unknown()) }).transform(o => ({
  chips: o.c.slice(0, MODEL_CHIPS_MAX).flatMap(raw => {
    const r = ModelRow.safeParse(raw);
    return r.success && r.data ? [r.data] : [];
  }),
}));

/** 退出口的词表：say 文字命中才算退出口（mode 由服务端推，不让普通的话被当成退出口）。 */
const EXIT_WORDS = /我先去忙|我先忙|先到这|稍后|等下再|先跳过|先放着|明天(再|接着)/;
/** fill 要留给他补的地方：冒号收尾或 ＿＿。 */
const FILL_SLOT = /[：:]\s*$|＿/;
/** ask_primary 只接这几类（与 renderer askPrimary.ts 的 NEEDS_DECK 互补：其余要开卡组）。 */
const PRIMARY_KINDS: readonly AskKind[] = ['review', 'failed', 'start'];
const SURFACES: readonly SuggestSurface[] = ['live', 'dossier', 'jobs', 'resume'];

/** 等你事的中文叫法（模型按这个写 target）。 */
export const ASK_KIND_NAMES: Readonly<Partial<Record<AskKind, readonly string[]>>> = {
  login: ['登录', '验证码'], info: ['缺信息', '缺'], failed: ['没填成', '失败'], review: ['过目', '投出', '备好'],
  choice: ['选择', '选'], unsure: ['拿不准'], confirm: ['确认'], start: ['开始'],
};

export interface ResolveCtx {
  s: SuggestState;
  /** 这一幕允许的意图；空 = 全部。 */
  allowed: readonly SuggestIntent[];
  /** 这一幕回应格（say）记成 answer 还是 option：取这一幕排序里先出现的那个。 */
  replyMode?: SuggestMode;
}

const norm = (t: string | null | undefined) => (t ?? '').trim();
const stripQuotes = (t: string) => t.trim().replace(/^["“「]|["”」]$/g, '');

/** 状态里认识的公司（全名去重），按"等他 > 截止 > 在填 > 备好 > 下一批 > 定制"排。 */
function knownCompanies(s: SuggestState): string[] {
  return [...new Set([
    ...s.asks.flatMap(a => a.companies), ...s.dueSoon.map(d => d.company), ...(s.batch?.running ?? []),
    ...s.held.companies, ...s.nextJobs.map(j => j.company), ...(s.lastTailor ? [s.lastTailor.company] : []),
    ...(s.openCard?.picked ?? []), ...(s.openCard?.company ? [s.openCard.company] : []),
  ].filter(Boolean))];
}

const shortOf = (name: string) => shortCompany(name).replace(/…$/, '');

/** 一段话里点到的状态里的公司（全名）；没有 null。 */
export function companyMentioned(text: string, s: SuggestState): string | null {
  return knownCompanies(s).find(name => { const short = shortOf(name); return !!short && (text.includes(short) || short.includes(text.trim())); }) ?? null;
}

/** 按 target 找那件等他的事：种类中文名 / 种类英文 / 公司 / 标题。 */
function findAsk(s: SuggestState, target: string, kinds?: readonly AskKind[]): SuggestAsk | null {
  const pool = kinds ? s.asks.filter(a => kinds.includes(a.kind)) : s.asks;
  if (!target) return pool[0] ?? null;
  return pool.find(a => a.kind === target)
    ?? pool.find(a => (ASK_KIND_NAMES[a.kind] ?? []).some(n => target.includes(n)))
    ?? pool.find(a => a.companies.some(c => { const sh = shortOf(c); return !!sh && target.includes(sh); }))
    ?? pool.find(a => !!a.title && (a.title.includes(target) || target.includes(a.title)))
    ?? null;
}

function proposeBatch(s: SuggestState, target: string): SuggestAction | null {
  if (!target) return { type: 'propose_batch' };
  if (target === 'next') return s.nextJobs.length ? { type: 'propose_batch', job_ids: s.nextJobs.map(j => j.job_id) } : { type: 'propose_batch' };
  const jobs = [...s.nextJobs, ...(s.lastTailor ? [{ job_id: s.lastTailor.job_id, company: s.lastTailor.company }] : [])];
  const names = target.split(/[、,，/／\s]+/).map(n => n.trim()).filter(Boolean);
  const ids = names.map(n => jobs.find(j => { const sh = shortOf(j.company); return !!sh && (n.includes(sh) || sh.includes(n)); })?.job_id);
  if (!ids.length || ids.some(id => !id)) return null;
  return { type: 'propose_batch', job_ids: [...new Set(ids.filter((id): id is string => !!id))] };
}

function startCard(s: SuggestState, target: string): SuggestAction | null {
  const card = s.openCard;
  if (card?.kind !== 'batch_pick') return null;
  const ids = target === 'all' ? card.allIds : card.pickedIds;
  return ids.length ? { type: 'start_card', card_id: card.id, job_ids: ids } : null;
}

function askChoose(s: SuggestState, target: string, text: string): SuggestAction | null {
  const want = target || text;
  for (const a of s.asks.filter(x => x.kind === 'choice')) {
    const opts = s.askOptions[a.id] ?? [];
    const hit = opts.find(o => o === want) ?? opts.find(o => want.includes(o) || (!!target && o.includes(target)));
    if (hit) return { type: 'ask_choose', ask_id: a.id, choice: hit };
  }
  return null;
}

function openSurface(s: SuggestState, target: string): SuggestAction | null {
  const [head, rest] = target.split(/[:：]/, 2).map(norm);
  const surface = SURFACES.find(x => x === head);
  if (!surface) return null;
  if (surface === 'live') return s.batch?.runningAppId ? { type: 'open', surface, id: s.batch.runningAppId } : { type: 'open', surface };
  if (surface === 'resume' && rest === 'tailored') return s.lastTailor ? { type: 'open', surface, id: s.lastTailor.tailored_id } : null;
  if (surface === 'dossier' && rest && s.batch?.runningAppId && s.batch.running[0] && companyMentioned(rest, s) === s.batch.running[0]) {
    return { type: 'open', surface, id: s.batch.runningAppId };
  }
  return { type: 'open', surface };
}

function startFeature(s: SuggestState, target: string): SuggestAction | null {
  const [id, rest] = target.split(/[:：]/, 2).map(norm);
  if (!isFeatureId(id)) return null;
  const company = rest ? companyMentioned(rest, s) : null;
  return company ? { type: 'start_feature', feature_id: id, args: { company } } : { type: 'start_feature', feature_id: id };
}

/** 意图 → 动作；say / fill 返回 undefined（无动作），解析不出返回 null。 */
export function actionOf(intent: SuggestIntent, target: string, text: string, s: SuggestState): SuggestAction | null | undefined {
  switch (intent) {
    case 'say': case 'fill': return undefined;
    case 'start_card': return startCard(s, target);
    case 'dismiss_card': return s.openCard ? { type: 'dismiss_card', card_id: s.openCard.id } : null;
    case 'propose_batch': return proposeBatch(s, target);
    case 'open_deck': {
      if (!target) return { type: 'open_deck' };
      const a = findAsk(s, target);
      return a ? { type: 'open_deck', ask_id: a.id } : null;
    }
    case 'ask_primary': {
      const a = findAsk(s, target, PRIMARY_KINDS);
      return a ? { type: 'ask_primary', ask_id: a.id } : null;
    }
    case 'ask_choose': return askChoose(s, target, text);
    case 'open': return openSurface(s, target);
    case 'start_feature': return startFeature(s, target);
  }
}

/** 按意图推 mode：起头 start；先放着、带退出词的 say 为 exit；其余能办的 advance；替他选与填空 option；say 用这一幕的回应 mode。 */
export function modeOf(intent: SuggestIntent, text: string, replyMode: SuggestMode = 'answer'): SuggestMode {
  if (intent === 'start_feature') return 'start';
  if (intent === 'dismiss_card') return 'exit';
  if (intent === 'say') return EXIT_WORDS.test(text) ? 'exit' : replyMode;
  if (intent === 'fill' || intent === 'ask_choose') return 'option';
  return 'advance';
}

/** 一格：越界意图退 say；解析不出动作的丢（null）。功能起头带 feat_ 种子，冷却照旧（L9）。 */
export function resolveChip(raw: ModelChip, { s, allowed, replyMode }: ResolveCtx): SuggestChip | null {
  const text = stripQuotes(raw.text);
  if (!text) return null;
  const intent: SuggestIntent = !allowed.length || allowed.includes(raw.intent) ? raw.intent : 'say';
  const target = norm(raw.target);
  const action = actionOf(intent, target, text, s);
  if (action === null) {
    console.warn(`[career-suggest] unresolved ${intent} ${target || '-'}`);
    return null;
  }
  const mode = modeOf(intent, text, replyMode);
  if (action) {
    const seed = action.type === 'start_feature' ? `${FEATURE_SEED_PREFIX}${action.feature_id}` : null;
    return { text, slot: slotOf(mode), kind: 'do', mode, action, seed_id: seed };
  }
  const kind = intent === 'fill' && FILL_SLOT.test(text) ? 'fill' : 'say';
  return { text, slot: slotOf(mode), kind, mode, seed_id: null };
}

export function resolveIntents(chips: readonly ModelChip[], ctx: ResolveCtx): SuggestChip[] {
  return chips.map(c => resolveChip(c, ctx)).filter((c): c is SuggestChip => c !== null);
}
