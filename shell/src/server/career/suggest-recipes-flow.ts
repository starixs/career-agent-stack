/**
 * 配方 · 后半程（plan-r3-suggest §2 S13–S29）：勾选表、批量、七种等你、笔试、面试前后、Offer、低谷、跑题、
 * "你能做什么"、隔几天回来、没岗位、兜底。能直接办的全是规则（do），模型只补跑题与兜底里的回应格。
 */
import type { FeatureId } from '../../shared/careerFeatures';
import type { SuggestChip } from '../../shared/careerSuggest';
import { doChip, featureChip, fillChip, sayChip, withMode } from './suggest-chip';
import { featureChips } from './suggest-features';
import {
  companyIn, exitSay, fit, ORDER_DO, ORDER_START, ORDER_TALK, type Recipe, type RecipeCtx,
} from './suggest-recipe-kit';
import { EXAM_DUE_KINDS, INTERVIEW_DUE_KINDS, type SceneId } from './suggest-scene';
import { askNext, cardActs, EXIT_WHILE_RUNNING, exitChip, nextChip } from './suggest-seeds';
import { shortCompany } from './suggest-text';
import type { SuggestAsk, SuggestState } from './suggest-types';

const PROMPT_S19 = '网页上有一道题要他选（候选选项在"线程"里）。照抄选项原文各写一条他直接点的回答（≤22 字，可以加「选」字），不要改选项意思。';
const PROMPT_S25 = '他刚问了一个跑题的问题，小芽答完了。替他写 1 条最可能接着说的话：点到他问的那家公司或那件事（如「帮我看看字节这份」「那这家还要等多久」）。';
const PROMPT_S29 = '替他写 1–2 条最可能接着说的话：小芽问了就给两种不同答法，没问就给最顺的下一句。';

const askOf = (s: SuggestState, ...kinds: SuggestAsk['kind'][]) => s.asks.find(a => kinds.includes(a.kind)) ?? null;
const feats = (c: RecipeCtx, max = 1) => featureChips(c.s, { scene: c.scene, input: c.x }, c.recent, max);
/** 一格起头：给两个候选，第一个和本幕已有格同落点（L8）时由第二个顶上；两个都在时 L8 只留一个起头。 */
const one = (c: RecipeCtx): SuggestChip[] => feats(c, 2);
const askAdvance = (a: SuggestAsk | null): SuggestChip | null => {
  const chip = a ? askNext(a) : null;
  return chip ? withMode(chip, 'advance') : null;
};
/** 退出口：后台在跑说"你接着投"，深夜说"今天先到这"，否则轮换（suggest-seeds.exitChip）。 */
const exitOf = (s: SuggestState): SuggestChip | null => exitChip(s);
/** 批量在填时"把在填的那份给我看看"。 */
function peekLive(s: SuggestState): SuggestChip | null {
  const b = s.batch;
  if (b?.status !== 'running' || !b.runningAppId || !b.running[0]) return null;
  return doChip(fit(`把${shortCompany(b.running[0])}那份给我看看`, '把在填的那份给我看看'), 'advance', { type: 'open', surface: 'live', id: b.runningAppId }, 's14_peek');
}
const dueCompany = (s: SuggestState, kinds: readonly string[]): string | null => {
  const d = s.dueSoon.find(x => kinds.includes(x.kind));
  return d ? shortCompany(d.company) : null;
};

const S13: Recipe = {
  order: ['advance', 'answer', 'option', 'start', 'exit'],
  prompt: null,
  rules: ({ s }) => [nextChip(s), ...(cardActs(s) ?? []).map(c => withMode(c, 'advance')), exitOf(s)],
  fallback: c => S13.rules(c),
};

const S14: Recipe = {
  order: ['advance', 'start', 'option', 'answer', 'exit'],
  prompt: null,
  rules: c => [askAdvance(askOf(c.s, 'review')), peekLive(c.s), ...one(c), exitSay(EXIT_WHILE_RUNNING, 's14_exit')],
  fallback: c => S14.rules(c),
};

const S15: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s }) => [
    askAdvance(askOf(s, 'login')),
    sayChip('扫好了，接着填', 'answer', 's15_done'),
    !s.phoneLinked ? featureChip('phone_link') : null,
    exitOf(s),
  ],
  fallback: c => S15.rules(c),
};

const S16: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s }) => {
    const a = askOf(s, 'info');
    const what = (a?.title ?? '').replace(/等 \d+ 项$/, '');
    const privacy = /证件|身份证/.test(what);
    return [
      askAdvance(a),
      sayChip('这项我没有，空着', 'answer', 's16_none'),
      sayChip(fit(`这批先不填${what}`, '这批先不填这项'), 'answer', 's16_skip'),
      privacy ? sayChip('我的身份证号安全吗', 'option', 's16_privacy') : null,
    ];
  },
  fallback: c => S16.rules(c),
};

const S17: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s }) => {
    const a = askOf(s, 'failed');
    return [
      askAdvance(a),
      sayChip('哪一步没过去', 'answer', 's17_why'),
      sayChip(`这 ${a?.count ?? 1} 家不投了`, 'advance', 's17_drop'),
      exitOf(s),
    ];
  },
  fallback: c => S17.rules(c),
};

const S18: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s }) => {
    const a = askOf(s, 'review');
    const who = a?.companies[0] ? shortCompany(a.companies[0]) : null;
    const peek = a && who && a.count > 1 ? doChip(fit(`看一眼${who}那份就投`, '看一眼就投'), 'advance', { type: 'open_deck', ask_id: a.id }, 's18_peek') : null;
    const openQ = s.asks.some(x => x.title.includes('开放题'));
    return [
      askAdvance(a), peek,
      openQ ? sayChip('开放题先给我看看', 'answer', 's18_look') : peekLive(s),
      exitOf(s),
    ];
  },
  fallback: c => S18.rules(c),
};

const S19: Recipe = {
  order: ['answer', 'advance', 'option', 'start', 'exit'],
  prompt: PROMPT_S19,
  rules: ({ s }) => {
    const a = askOf(s, 'choice', 'unsure', 'confirm');
    const opts = a ? (s.askOptions[a.id] ?? []).slice(0, 2) : [];
    return [
      ...opts.map((o, i) => (a?.kind === 'choice'
        ? doChip(fit(`选「${o}」`, o.slice(0, 20)), 'answer', { type: 'ask_choose', ask_id: a.id, choice: o }, `s19_opt_${i}`)
        : sayChip(fit(`选「${o}」`, o.slice(0, 20)), 'answer', `s19_opt_${i}`))),
      sayChip('按最常见的选', 'answer', 's19_common'),
      a ? doChip('先看题是什么', 'advance', { type: 'open_deck', ask_id: a.id }, 's19_open') : null,
    ];
  },
  fallback: c => S19.rules(c),
};

const S20: Recipe = {
  order: ORDER_START,
  prompt: null,
  rules: ({ s }) => {
    const co = dueCompany(s, EXAM_DUE_KINDS);
    return [
      featureChip('exam_search'),
      sayChip(co ? fit(`先练几道${co}的题`, '先练几道笔试题') : '先练几道笔试题', 'answer', 's20_practice'),
      sayChip(co ? fit(`${co}往年考什么`, '这家往年考什么') : '这家往年考什么', 'answer', 's20_past'),
      // 收尾是一句约定，不是回答也不是退出（verify-r3 P2-11）。
      sayChip('考完跟你说结果', 'option', 's20_after'),
    ];
  },
  fallback: c => S20.rules(c),
};

const S21: Recipe = {
  order: ORDER_START,
  prompt: null,
  rules: ({ s }) => {
    const co = dueCompany(s, INTERVIEW_DUE_KINDS) ?? (s.openCard?.company ? shortCompany(s.openCard.company) : null);
    const hasPrep = s.openCard?.kind === 'interview_prep';
    const feature: FeatureId = hasPrep ? 'interview_probe' : 'interview_prep';
    return [
      featureChip(feature, co),
      // 没有公司时「这家」无指代，不出（verify-r3 P2-11）。
      co ? sayChip(fit(`${co}会深挖我简历哪里`, '会深挖我简历哪里'), 'answer', 's21_predict') : null,
      hasPrep ? sayChip('一分钟自我介绍先备一版', 'answer', 's21_intro') : sayChip('来一遍模拟面试', 'answer', 's21_probe'),
      sayChip('面完我来复盘', 'answer', 's21_retro'),
    ];
  },
  fallback: c => S21.rules(c),
};

const S22: Recipe = {
  order: ['option', 'answer', 'advance', 'start', 'exit'],
  prompt: null,
  rules: () => [
    sayChip('先说最卡的那题', 'option', 's22_hard'),
    sayChip('问了什么我记不全了', 'option', 's22_forgot'),
    fillChip('面试官当时反应：', 'option', 's22_reaction'),
    sayChip('下一场怎么改', 'answer', 's22_next'),
  ],
  fallback: c => S22.rules(c),
};

const S23: Recipe = {
  order: ['start', 'option', 'advance', 'answer', 'exit'],
  prompt: null,
  rules: () => [
    featureChip('offer'),
    sayChip('我更在意钱', 'option', 's23_money'),
    sayChip('我更在意城市和离家', 'option', 's23_city'),
    doChip('先接着投别的', 'advance', { type: 'propose_batch' }, 's23_more'),
  ],
  fallback: c => S23.rules(c),
};

/** 低谷那一格（S24 第一格，也是别的幕叠加低谷时换进去的那格）。 */
export const LOW_CHIP = sayChip('看我这个月的数', 'advance', 's24_month');

const S24: Recipe = {
  order: ['advance', 'option', 'answer', 'start', 'exit'],
  prompt: null,
  rules: () => [
    LOW_CHIP,
    sayChip('换个方向试试', 'option', 's24_direction'),
    sayChip('先不投了，歇两天', 'option', 's24_rest'),
    doChip('接着投，别管了', 'option', { type: 'propose_batch' }, 's24_keep'),
  ],
  fallback: c => S24.rules(c),
};

const S25: Recipe = {
  order: ORDER_TALK,
  prompt: PROMPT_S25,
  // 「继续聊刚才的」无对象、点了无结果（verify-r3 P2-11）：换成按状态说得出的下一步。
  rules: c => {
    const next = nextChip(c.s, { lastUser: c.x.lastUser, lastAssistant: c.x.lastAssistant });
    return [
      next ? withMode(next, 'answer') : null,
      doChip('再投几家别的', 'advance', { type: 'propose_batch' }, 's25_more'),
      exitOf(c.s),
    ];
  },
  fallback: ({ s, x }) => {
    const co = companyIn(x.lastUser, s);
    return [co ? sayChip(fit(`帮我看看${co}这份`, '帮我看看这份'), 'answer', 's25_look') : null, fillChip('我想问点别的：', 'option', 's25_other')];
  },
};

/** "你能做什么"：四格全是此刻用得上的起头，不够四个时用这几个补。 */
const S26_FILL: readonly FeatureId[] = ['job_evaluate', 'company_research', 'direction_explore', 'self_intro', 'exam_search', 'funnel'];
/** 方向期还没投：看岗位、查公司、找方向、接邮箱。 */
const S26_DIRECTION: readonly FeatureId[] = ['job_evaluate', 'company_research', 'direction_explore', 'mail_bind'];

const S26: Recipe = {
  order: ['start', 'advance', 'answer', 'option', 'exit'],
  prompt: null,
  rules: c => feats(c, 4),
  fallback: ({ s }) => {
    if (s.stage === 'profile') {
      return [
        s.mailConnected ? null : featureChip('mail_bind'),
        s.resume.has ? featureChip('resume_editor') : sayChip('有简历，我拖进来', 'answer', 's26_resume'),
        sayChip('先口述一段实习', 'answer', 's26_tell'),
      ];
    }
    const ids: readonly FeatureId[] = s.stage === 'direction' ? S26_DIRECTION : S26_FILL;
    return ids.map(id => featureChip(id));
  },
};

const S27: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s }) => {
    const openQ = s.asks.find(a => a.title.includes('开放题'));
    return [
      doChip('从最急的开始', 'advance', { type: 'open_deck' }, 's27_urgent'),
      openQ ? doChip('先看开放题写了什么', 'advance', { type: 'open_deck', ask_id: openQ.id }, 's27_openq') : askAdvance(askOf(s, 'review')),
      sayChip('这几天投出了几家', 'answer', 's27_sent'),
      exitSay('我先忙，等下处理', 's27_exit'),
    ];
  },
  fallback: c => S27.rules(c),
};

const S28: Recipe = {
  order: ['option', 'start', 'answer', 'advance', 'exit'],
  prompt: null,
  rules: ({ s }) => [
    s.prefs.cities.length ? sayChip('城市不限了', 'option', 's28_city') : null,
    fillChip('方向改成：', 'option', 's28_direction'),
    featureChip('job_evaluate'),
    sayChip('有新岗位进来叫我', 'answer', 's28_notify'),
  ],
  fallback: c => S28.rules(c),
};

const S29: Recipe = {
  order: ['answer', 'advance', 'start', 'option', 'exit'],
  prompt: PROMPT_S29,
  rules: c => {
    const next = nextChip(c.s, { lastUser: c.x.lastUser, lastAssistant: c.x.lastAssistant });
    return [next ? withMode(next, 'advance') : null, ...one(c), exitOf(c.s)];
  },
  fallback: c => [fillChip('我想问点别的：', 'option', 's29_other'), ...feats(c, 2)],
};

export const FLOW_RECIPES: Readonly<Partial<Record<SceneId, Recipe>>> = {
  S13, S14, S15, S16, S17, S18, S19, S20, S21, S22, S23, S24, S25, S26, S27, S28, S29,
};
