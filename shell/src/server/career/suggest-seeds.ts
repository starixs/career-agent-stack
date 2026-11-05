/**
 * 下一步条的规则层（plan-r2 §B.3，不过模型，<30ms）：
 *  - next：永远具体、能直接做——底下有卡就是卡的主动作，有等他的事就点名公司去处理，否则按主线阶段给下一批；
 *  - shape：塑形候选（收偏好、收数据、教功能、给底气），模板里填真实的公司、城市、家数；模型从里面挑一条；
 *  - exit：有后台在跑或有东西等他时才出的退出口；
 *  - cardActs：底下有卡在等他时，接话那一格给卡的次动作（不叫模型）。
 * 已经有的数据不再收（连了邮箱就不出"手投过"，说过城市就不问城市）。
 */
import { modeOfSlot, type SuggestAction, type SuggestChip, type SuggestSlot } from '../../shared/careerSuggest';
import { BATCH_PICK_CARD_KIND } from './batch-propose';
import { fitText, namesPhrase, shortCompany } from './suggest-text';
import type { SuggestAsk, SuggestState } from './suggest-types';

export type { SuggestContext, SuggestState } from './suggest-types';

/** 他和小芽最后一来一回（规则层只用来判断小芽是不是刚提过某件事）。 */
export interface SuggestTalk { lastUser: string; lastAssistant: string }

/** 几点以后退出口说"今天先到这"。 */
export const LATE_HOUR = 22;
/** 离开多少小时算"回来"：回来时先从最急的开始。 */
export const AWAY_HOURS = 12;
/** 三句退出口轮换（同一句不连着出）。 */
export const EXIT_LINES: readonly string[] = ['我先去忙', '今天先到这，明天接着', '有事再叫我'];
export const EXIT_WHILE_RUNNING = '我先去忙，你接着投';
/** 勾选表在等时的退出口：不能和卡上「先不投」撞（plan-r3 L5）。 */
export const EXIT_CARD = '这批先放着，我去忙';

// 积木格都是规则写的模板：seed_id 用 `rule_<slot>`，过 L4 时算白名单。
const say = (text: string, slot: SuggestSlot, seed: string | null = null): SuggestChip => ({ text, slot, kind: 'say', mode: modeOfSlot(slot), seed_id: seed ?? `rule_${slot}` });
const act = (text: string, slot: SuggestSlot, action: SuggestAction, seed: string | null = null): SuggestChip => ({ text, slot, kind: 'do', mode: modeOfSlot(slot), action, seed_id: seed ?? `rule_${slot}` });

// ---------- ② 下一步 ----------

export function askNext(a: SuggestAsk): SuggestChip | null {
  const who = namesPhrase(a.companies, a.count);
  switch (a.kind) {
    case 'login': {
      const text = fitText(`先处理${who}要登录的`, `先处理 ${a.count} 家要登录的`);
      return text ? act(text, 'next', { type: 'open_deck', ask_id: a.id }) : null;
    }
    case 'info': {
      const what = a.title.replace(/等 \d+ 项$/, '');
      const text = fitText(`填${what}，${a.count} 家一起放行`, `补上信息，${a.count} 家一起放行`);
      return text ? act(text, 'next', { type: 'open_deck', ask_id: a.id }) : null;
    }
    case 'failed': return act(`再试一次这 ${a.count} 家`, 'next', { type: 'ask_primary', ask_id: a.id });
    case 'start': return act(`这 ${a.count} 家都开始`, 'next', { type: 'ask_primary', ask_id: a.id });
    case 'review': return a.count > 1
      ? act(`备好的 ${a.count} 家都投出`, 'next', { type: 'ask_primary', ask_id: a.id })
      : act(fitText(`看一眼${who}那份就投`, '看一眼就投') ?? '看一眼就投', 'next', { type: 'open_deck', ask_id: a.id });
    default: return act(fitText(`先处理${a.title}`, '先处理等我的事') ?? '先处理等我的事', 'next', { type: 'open_deck', ask_id: a.id });
  }
}

function cardNext(s: SuggestState): SuggestChip | null {
  const card = s.openCard;
  if (!card) return null;
  if (card.kind === BATCH_PICK_CARD_KIND && card.pickedIds.length) {
    return act(`就这 ${card.pickedIds.length} 家`, 'next', { type: 'start_card', card_id: card.id, job_ids: card.pickedIds });
  }
  if (s.lastTailor && s.lastTailor.card_id === card.id) return act('打开整份看看', 'next', { type: 'open', surface: 'resume', id: s.lastTailor.tailored_id });
  return null;
}

export function jobsNext(s: SuggestState): SuggestChip {
  const jobs = s.nextJobs;
  if (!jobs.length) return say('我自己贴几个岗位链接', 'next');
  if (s.stage === 'first') {
    return act(fitText(`先投${shortCompany(jobs[0].company)}一家给我看`, '先投一家给我看') ?? '先投一家给我看', 'next', { type: 'propose_batch', job_ids: [jobs[0].job_id] });
  }
  const ids = jobs.map(j => j.job_id);
  const who = namesPhrase(jobs.map(j => j.company), jobs.length);
  const text = fitText(jobs.length <= 2 ? `先投${who}这 ${jobs.length} 家` : `先投${who}`, `再投 ${jobs.length} 家`) ?? '再投一批';
  return act(text, 'next', { type: 'propose_batch', job_ids: ids });
}

function stageNext(s: SuggestState, talk: SuggestTalk): SuggestChip | null {
  switch (s.stage) {
    case 'profile':
      if (s.resume.experiences > 0) return null; // 访谈中：接话那两格就是下一步
      return say('还没有，先聊聊', 'next');
    case 'direction':
      return /方向|类岗位|投哪/.test(talk.lastAssistant) ? null : say('按我的经历推荐方向', 'next');
    default:
      return jobsNext(s);
  }
}

/** 下一步：卡 > 一件等他的事 > 几件一起（从最急的开始）> 按阶段。 */
export function nextChip(s: SuggestState, talk: SuggestTalk = { lastUser: '', lastAssistant: '' }): SuggestChip | null {
  const fromCard = cardNext(s);
  if (fromCard || s.openCard?.kind === BATCH_PICK_CARD_KIND) return fromCard;
  if (s.asks.length === 1) return askNext(s.asks[0]);
  if (s.asks.length > 1) return act('从最急的开始', 'next', { type: 'open_deck' });
  return stageNext(s, talk);
}

// ---------- ① 卡的次动作 ----------

/** 底下有卡在等他：接话那一格给卡的次动作，不叫模型。别的卡返回 null（交给模型接话）。 */
export function cardActs(s: SuggestState): SuggestChip[] | null {
  const card = s.openCard;
  if (!card) return null;
  if (card.kind === BATCH_PICK_CARD_KIND) {
    const chips: SuggestChip[] = [];
    if (card.allIds.length > card.pickedIds.length) {
      chips.push(act(`全投，${card.allIds.length} 家都投`, 'act', { type: 'start_card', card_id: card.id, job_ids: card.allIds }));
    }
    chips.push(act('换一批', 'act', { type: 'propose_batch' }));
    return chips;
  }
  const t = s.lastTailor;
  if (t && t.card_id === card.id) {
    const text = fitText(`可以，就这样投${shortCompany(t.company)}`, '可以，就这样投') ?? '可以，就这样投';
    return [act(text, 'act', { type: 'propose_batch', job_ids: [t.job_id] }), say('改得太多了，轻一点', 'act')];
  }
  return null;
}

// ---------- ④ 退出口 ----------

let exitTurn = 0;

/** 有后台在跑、有东西等他、或底下有勾选表时才出；没有后台事返回 null（④ 让给第二条塑形）。 */
export function exitChip(s: SuggestState): SuggestChip | null {
  if (s.openCard?.kind === BATCH_PICK_CARD_KIND) return act(EXIT_CARD, 'exit', { type: 'dismiss_card', card_id: s.openCard.id });
  const running = s.batch?.status === 'running' && (s.batch.running.length > 0 || s.batch.queued > 0);
  if (!running && !s.asks.length && !s.held.count) return null;
  if (s.hour >= LATE_HOUR) return say('今天先到这，明天接着', 'exit');
  if (running) return say(EXIT_WHILE_RUNNING, 'exit');
  const text = EXIT_LINES[exitTurn % EXIT_LINES.length];
  exitTurn += 1;
  return say(text, 'exit');
}

/** 测试用：退出口轮换从头开始。 */
export function resetExitRotation(): void {
  exitTurn = 0;
}
