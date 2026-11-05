/**
 * ③ 塑形候选（plan-r2 §B.3）：规则出候选、填真实数据，模型从里面挑一条最自然的，挑不出取第一条。
 *
 * 排在前面的是"此刻的情境"给的（在填谁、哪件事等他、底下那张卡），后面是按阶段的老种子：
 *  - 收偏好：批量投按方向挑，偏好越早说清，勾选表越准；
 *  - 收数据：手投过的申请从邮箱接过来；
 *  - 教功能：笔试搜题、面后复盘、查公司，在用得到之前先让他知道有；
 *  - 给底气：不信任 AI 的人最想问的那几句，替他问出来。
 * 情境候选不冷却（数据变了它就变）；老种子出过一次隔 SEED_COOLDOWN 轮再出（suggest.ts）。
 */
import type { MainlineStage } from '../../shared/careerRail';
import type { SuggestAction, SuggestChip } from '../../shared/careerSuggest';
import { fitText, shortCompany } from './suggest-text';
import type { SuggestState } from './suggest-types';

export interface ShapeCandidate {
  id: string;
  chip: SuggestChip;
  /** 老种子：出过以后冷却；情境候选为 false。 */
  cools: boolean;
}

const shape = (id: string, text: string, kind: 'say' | 'fill' = 'say', cools = false): ShapeCandidate =>
  ({ id, cools, chip: { text, slot: 'shape', kind, seed_id: id } });
const shapeDo = (id: string, text: string, action: SuggestAction): ShapeCandidate =>
  ({ id, cools: false, chip: { text, slot: 'shape', kind: 'do', action, seed_id: id } });

const LATER: readonly MainlineStage[] = ['first', 'batch', 'released'];
const hasAsk = (s: SuggestState, kind: string) => s.asks.some(a => a.kind === kind);

/** 底下那张卡、后台在填、等他的事给的候选。 */
function situational(s: SuggestState): ShapeCandidate[] {
  const out: ShapeCandidate[] = [];
  if (s.lastTailor && s.openCard?.id === s.lastTailor.card_id) out.push(shape('tailor_rest', '其余的也都这样改'));
  const b = s.batch;
  if (b?.status === 'running' && b.running[0] && b.runningAppId) {
    const text = fitText(`把${shortCompany(b.running[0])}那份给我看看`, '把在填的那份给我看看');
    if (text) out.push(shapeDo('peek_live', text, { type: 'open', surface: 'live', id: b.runningAppId }));
  }
  const openQ = s.asks.find(a => a.title.includes('开放题'));
  if (openQ && s.asks.length > 1) out.push(shapeDo('peek_open_q', '先看开放题写了什么', { type: 'open_deck', ask_id: openQ.id }));
  const failed = s.asks.find(a => a.kind === 'failed');
  if (failed) out.push(shape('drop_failed', `这 ${failed.count} 家不投了`));
  if (s.asks.some(a => a.kind === 'info' && /证件|身份证/.test(a.title))) out.push(shape('trust_privacy', '我的身份证号安全吗'));
  if (b?.status !== 'running' && s.asks.length && s.nextJobs.length && LATER.includes(s.stage)) {
    out.push(shapeDo('again', '再投一批', { type: 'propose_batch' }));
  }
  if (!s.phoneLinked && hasAsk(s, 'login')) out.push(shape('phone_codes', '连上手机能自动收验证码'));
  return out;
}

/** 方向内一家都投不了：放宽条件或叫他等新岗位。 */
function noJobs(s: SuggestState): ShapeCandidate[] {
  if (!LATER.includes(s.stage) || s.nextJobs.length || !s.resume.has) return [];
  const out = [shape('notify_new', '有新岗位进来叫我')];
  if (s.prefs.cities.length) out.push(shape('relax_city', '城市不限了'));
  out.push(shape('change_direction', '方向改成：', 'fill'));
  return out;
}

function preferences(s: SuggestState): ShapeCandidate[] {
  const out: ShapeCandidate[] = [];
  if (!['direction', 'first', 'batch'].includes(s.stage)) return out;
  const cities = s.prefs.cities.map(shortCompany).slice(0, 2).join('、');
  const cityText = cities ? fitText(`只看${cities}`) : null;
  out.push(cityText ? shape('pref_city_only', cityText) : shape('pref_city', '我对城市有要求：', 'fill'));
  out.push(s.pool.outsourced > 0 ? shape('pref_outsourcing', `不投外包的那 ${s.pool.outsourced} 家`) : shape('pref_outsourcing', '不考虑外包', 'say', true));
  return out;
}

/** 按阶段的候选（访谈中、没简历、方向、第一份、批量）。 */
function byStage(s: SuggestState): ShapeCandidate[] {
  const interviewing = s.stage === 'profile' && !s.resume.has && s.resume.experiences > 0;
  if (interviewing) return [shape('skip_part', '这段先跳过'), shape('pause_talk', '今天先聊到这，明天接着')];
  const out: ShapeCandidate[] = [];
  if (s.stage === 'profile') out.push(shape('trust_review', '提交前我能先看吗', 'say', true));
  if (!s.prefs.cohort && ['profile', 'direction'].includes(s.stage)) out.push(shape('pref_cohort', `我是 ${s.cohortGuess} 届，找校招`, 'fill'));
  if (['profile', 'direction', 'first'].includes(s.stage) && !s.mailConnected) out.push(shape('mail_takeover', '我之前手投过一些了', 'say', true));
  out.push(...preferences(s));
  const first = s.nextJobs[0];
  if (first && ['first', 'batch'].includes(s.stage)) {
    const text = fitText(`提交前先让我看${shortCompany(first.company)}那份`);
    if (text) out.push(shape('trust_review_one', text));
  }
  return out;
}

const GENERIC: ReadonlyArray<{ id: string; text: string; stages: readonly MainlineStage[]; skip?: (s: SuggestState) => boolean }> = [
  { id: 'feat_company', text: '帮我看看一家公司靠谱吗', stages: ['direction', 'first', 'batch'] },
  { id: 'data_internship', text: '我还有段经历没说', stages: LATER },
  { id: 'feat_exam', text: '笔试时你能帮我搜题吗', stages: ['batch', 'released'] },
  { id: 'feat_retro', text: '面试完怎么复盘', stages: ['batch', 'released'] },
  { id: 'mail_connect', text: '帮我盯着邮箱', stages: ['profile', 'direction', 'first', 'batch', 'released'], skip: s => s.mailConnected },
];

/** 这一轮能出的塑形候选（去掉冷却中的老种子），情境在前。 */
export function shapeCandidates(s: SuggestState, recent: ReadonlySet<string> = new Set()): ShapeCandidate[] {
  const generic = GENERIC.filter(g => g.stages.includes(s.stage) && !g.skip?.(s)).map(g => shape(g.id, g.text, 'say', true));
  const all = [...situational(s), ...noJobs(s), ...byStage(s), ...generic];
  const seen = new Set<string>();
  return all.filter(c => !(c.cools && recent.has(c.id)) && !seen.has(c.chip.text) && (seen.add(c.chip.text), true));
}
