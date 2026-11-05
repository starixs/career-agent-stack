/**
 * 下一步条 · 判幕（plan-r3-suggest §2）：先判"他在哪一幕"，再按这一幕的配方出四格。纯函数，规则，<5ms。
 *
 * 多幕同时成立时的优先级：卡在等（S13/S11/S7）> 他刚说 / 刚问的（S26/S9/S22/S23/S24/S25）> 等他的事（S27, S15–S19）
 * > 访谈（S3–S6）> 截止驱动（S21/S20）> 阶段（S2/S10/S1/S8/S12/S14/S28）> 兜底 S29。
 * 低谷（近 7 天拒信多）不抢幕：只作叠加标记 low，配方出完后把一格换成低谷那格；只有落到兜底时才整幕变 S24。
 */
import { INTERVIEW_ROUNDS, type InterviewRound } from '@career/core';

import {
  SUGGEST_MAX_TOOLS, SUGGEST_MAX_TURNS, SUGGEST_TURN_CHARS, type SuggestRequest, type SuggestTurn,
} from '../../shared/careerSuggest';
import { BATCH_PICK_CARD_KIND } from './batch-propose';
import { LOW_POINT_MIN_REJECTIONS } from './low-point';
import { AWAY_HOURS } from './suggest-seeds';
import type { SuggestAsk, SuggestState } from './suggest-types';

export const SCENES = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15',
  'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25', 'S26', 'S27', 'S28', 'S29',
] as const;
export type SceneId = typeof SCENES[number];

export const SCENE_NAMES: Readonly<Record<SceneId, string>> = {
  S1: '冷启动', S2: '简历刚解析', S3: '访谈·开放问', S4: '访谈·追数字', S5: '访谈·降级问', S6: '访谈·一轮聊完',
  S7: '主张确认', S8: '方向提议', S9: '方向咨询', S10: 'JD 评估', S11: '定制审看', S12: '第一份当面投',
  S13: '勾选表在等', S14: '批量进行中', S15: '等你·登录', S16: '等你·缺信息', S17: '等你·没填成', S18: '等你·过目',
  S19: '等你·选择', S20: '笔试测评', S21: '面试准备', S22: '面后复盘', S23: 'Offer', S24: '低谷', S25: '跑题问答',
  S26: '你能做什么', S27: '隔几天回来', S28: '没匹配岗位', S29: '兜底',
};

/** 路由送来的请求整理成规则层要的样子（旧字段 last_user / last_assistant 兜底）。 */
export interface SuggestInput {
  lastUser: string;
  lastAssistant: string;
  turns: SuggestTurn[];
  lastTools: string[];
}

export interface SceneResult { scene: SceneId; low: boolean }

const TOOL_NAME = /^[a-z_]+$/;
const lastOf = (turns: readonly SuggestTurn[], role: SuggestTurn['role']) => [...turns].reverse().find(t => t.role === role)?.text ?? '';

export function inputOf(req: SuggestRequest): SuggestInput {
  const turns = (req.turns ?? []).slice(-SUGGEST_MAX_TURNS).map(t => ({ role: t.role, text: t.text.slice(0, SUGGEST_TURN_CHARS) }));
  return {
    lastUser: (req.last_user ?? lastOf(turns, 'user')).trim(),
    lastAssistant: (req.last_assistant ?? lastOf(turns, 'assistant')).trim(),
    turns,
    lastTools: (req.last_tools ?? []).filter(t => TOOL_NAME.test(t)).slice(0, SUGGEST_MAX_TOOLS),
  };
}

// ---------- 信号 ----------

const ASKS_QUESTION = /[？?]\s*$/;
const WHAT_CAN_YOU_DO = /(你|小芽).{0,4}(能|会|可以)(做|干|帮).{0,6}(什么|啥)|还能帮|有什么功能|怎么用你|不知道.{0,4}(怎么开始|从哪)/;
const DIRECTION_CONSULT = /(还是|哪个好|哪个更|适合(做|什么|哪)|选哪)/;
const AFTER_INTERVIEW = /(面完|面试完|刚面|今天面了|面试结束|面了一)/;
const OFFER = /offer|录用|意向书|三方/i;
const LOW_WORDS = /(是不是我不行|我是不是不行|没希望|都挂了|全挂|好丧|好累|投了没用|不想投了|太难了)/;
const NUMBER_QUESTION = /(多少|几个|几人|几位|几周|几天|几个月|多久|多长时间|多大|规模|名次|排名|占比|百分|提升了|增长了)/;
const SAID_NONE = /^(没有|没做过|没啥|没什么|好像没|真没|不记得|想不起)|没(有|做过)(什么|啥)/;
const ROUND_CLOSED = /(这段(够了|差不多|聊完)|接着(说|聊)|下一(段|类))/;
const INTERVIEW_TOOLS = ['experience_interview', 'experience_add'];
const RESUME_IMPORT_TOOLS = ['resume_import'];
const JD_TOOLS = ['jd_parse', 'job_evaluate', 'browser_capture_job'];
const EXAM_WORDS = /笔试|测评/;
const INTERVIEW_WORDS = /面试/;
const LATER = ['first', 'batch', 'released'];
const ASK_ORDER: readonly SuggestAsk['kind'][] = ['login', 'info', 'failed', 'review', 'choice', 'unsure', 'confirm'];
const ASK_SCENE: Partial<Record<SuggestAsk['kind'], SceneId>> = {
  login: 'S15', info: 'S16', failed: 'S17', review: 'S18', choice: 'S19', unsure: 'S19', confirm: 'S19',
};

const usedAny = (x: SuggestInput, tools: readonly string[]) => x.lastTools.some(t => tools.includes(t));
const dueOf = (s: SuggestState, kinds: readonly string[]) => s.dueSoon.find(d => kinds.includes(d.kind)) ?? null;
export const EXAM_DUE_KINDS: readonly string[] = ['assessment', 'written_test'];
export const INTERVIEW_DUE_KINDS: readonly string[] = ['interview'];

/**
 * 还在访谈里：只在攒简历期（profile）算——当前轮 in_progress，或小芽这一轮刚用过访谈工具。
 * 过了 profile 还挂着的 in_progress 是没记 done 的旧 kv（rail.ts 同一前提），不能劫持后面的幕。
 */
export function interviewing(s: SuggestState, x: SuggestInput): boolean {
  return s.stage === 'profile' && (!!s.interview?.inProgress || usedAny(x, INTERVIEW_TOOLS));
}

/** 下一轮要聊的那一类（todo 里第一个）。 */
export function nextRound(s: SuggestState): InterviewRound | null {
  return s.interview?.roundsTodo.find(r => r !== s.interview?.round) ?? null;
}

export const roundLabel = (r: InterviewRound | null): string | null => INTERVIEW_ROUNDS.find(x => x.key === r)?.label ?? null;

// ---------- 各层 ----------

function cardTier(s: SuggestState): SceneId | null {
  const card = s.openCard;
  if (!card) return null;
  if (card.kind === BATCH_PICK_CARD_KIND) return 'S13';
  if (s.lastTailor && s.lastTailor.card_id === card.id) return 'S11';
  if (card.kind === 'claims_confirm') return 'S7';
  return null;
}

function saidTier(s: SuggestState, x: SuggestInput): SceneId | null {
  const u = x.lastUser;
  if (!u) return null;
  if (WHAT_CAN_YOU_DO.test(u)) return 'S26';
  if (LOW_WORDS.test(u)) return 'S24';
  if (AFTER_INTERVIEW.test(u) || usedAny(x, ['interview_retro'])) return 'S22';
  if (OFFER.test(u)) return 'S23';
  const asked = ASKS_QUESTION.test(u) || /吗$/.test(u);
  if (asked && s.stage === 'direction' && DIRECTION_CONSULT.test(u)) return 'S9';
  if (asked && LATER.includes(s.stage) && !interviewing(s, x)) return 'S25';
  return null;
}

function askTier(s: SuggestState, awayHours: number | null): SceneId | null {
  if (!s.asks.length) return null;
  if (awayHours !== null && awayHours >= AWAY_HOURS) return 'S27';
  const kind = ASK_ORDER.find(k => s.asks.some(a => a.kind === k));
  return kind ? ASK_SCENE[kind] ?? null : null;
}

function interviewTier(s: SuggestState, x: SuggestInput): SceneId | null {
  if (!interviewing(s, x)) return null;
  if (SAID_NONE.test(x.lastUser)) return 'S5';
  const closed = !s.interview?.inProgress || ROUND_CLOSED.test(x.lastAssistant);
  if (closed && !ASKS_QUESTION.test(x.lastAssistant)) return 'S6';
  if (NUMBER_QUESTION.test(x.lastAssistant)) return 'S4';
  return 'S3';
}

function dueTier(s: SuggestState, x: SuggestInput): SceneId | null {
  if (s.openCard?.kind === 'interview_prep' || dueOf(s, INTERVIEW_DUE_KINDS) || INTERVIEW_WORDS.test(x.lastUser)) return 'S21';
  if (dueOf(s, EXAM_DUE_KINDS) || EXAM_WORDS.test(x.lastUser)) return 'S20';
  return null;
}

function stageTier(s: SuggestState, x: SuggestInput): SceneId | null {
  if (usedAny(x, RESUME_IMPORT_TOOLS) || s.openCard?.kind === 'resume_intake') return 'S2';
  if (usedAny(x, JD_TOOLS)) return 'S10';
  if (s.stage === 'profile' && !s.resume.has && s.resume.experiences === 0) return 'S1';
  if (s.stage === 'direction') return 'S8';
  const running = s.batch?.status === 'running' && (s.batch.running.length > 0 || s.batch.queued > 0);
  if (running && s.stage === 'first') return 'S12';
  if (running) return 'S14';
  if (LATER.includes(s.stage) && s.resume.has && !s.nextJobs.length) return 'S28';
  return null;
}

/** 判幕：按优先级取第一个成立的；都不成立是兜底（低谷时兜底换成 S24）。 */
export function classifyScene(s: SuggestState, x: SuggestInput): SceneResult {
  const low = s.rejections7d >= LOW_POINT_MIN_REJECTIONS;
  const scene = cardTier(s) ?? saidTier(s, x) ?? askTier(s, s.awayHours) ?? interviewTier(s, x)
    ?? dueTier(s, x) ?? stageTier(s, x) ?? (low ? 'S24' : 'S29');
  return { scene, low: low && scene !== 'S24' };
}
