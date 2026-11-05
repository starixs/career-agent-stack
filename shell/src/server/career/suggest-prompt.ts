/**
 * 下一步条 r4 · 提示词（plan-r4-suggest §3.3）：一次调用写全部四格。
 * 输出是紧凑行 {"c":[["文字","intent","target"]]}（省默认值、不写 mode），四条 ≈ 60–90 token，压在 3s 内。
 * system = 公共要求 + 这一幕的思路 + 允许意图 + 示例（标"示例，别照抄"）；
 * user = 状态快照（去 id）+ 这一轮（他说的 / 小芽说的 / 用了什么 / 放了什么卡）+ 最近几轮 + 上一轮出过的四格。
 */
import { SUGGEST_MAX_CHARS, SUGGEST_MAX_CHIPS, type SuggestThisTurn } from '../../shared/careerSuggest';
import { ASK_KIND_NAMES } from './suggest-intents';
import type { SceneGuide, SuggestIntent } from './suggest-guide-types';
import { roundLabel, type SuggestInput } from './suggest-scene';
import type { SuggestState } from './suggest-types';

/** 这一轮他说的最多带几个字。 */
const THIS_USER_CHARS = 300;
/** 这一轮小芽说的最多带几个字（最要紧的上下文）。 */
const THIS_ASSISTANT_CHARS = 600;
/** 历史每轮最多几个字：只给模型看来龙去脉，细节在"这一轮"。 */
const HISTORY_TURN_CHARS = 150;
/** system + user 总字数上限（≈ 900 + 1 200 token 的字符近似，§3.3 预算）。 */
export const PROMPT_MAX_CHARS = 3_000;
/** 状态里每类列表最多带几项。 */
const STATE_LIST_MAX = 4;

/** 常用工具的中文叫法；没有的用原名（§3.3）。 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  resume_import: '读简历', experience_interview: '访谈经历', experience_add: '记下经历', claims_confirm: '核对主张',
  jobs_apply: '开始投', batch_propose: '挑一批岗位', job_evaluate: '评估岗位', jd_parse: '读岗位要求',
  browser_capture_job: '抓岗位', resume_tailor: '定制简历', tailor_diff: '定制简历', interview_retro: '面试复盘',
  interview_prep: '准备面试', interview_probe: '模拟面试', company_research: '查公司', direction_explore: '找方向',
  mail_import: '从邮箱接投递', exam_search: '搜题', offer_save: '记 Offer', application_correct: '更正申请',
};

/** 每种意图的 target 怎么写（只给本幕允许的）。 */
const INTENT_HELP: Readonly<Record<SuggestIntent, string>> = {
  say: 'say：点了直接发这句话；可省（只写 ["文字"]）',
  fill: 'fill：填进输入框等他补，文字以"："收尾或含"＿＿"',
  start_card: 'start_card：按底下勾选表开始投，target 写 picked（勾了的）或 all（全部）',
  propose_batch: 'propose_batch：挑一批来投，target 写 next（下一批）或公司名（顿号分隔），也可不写',
  dismiss_card: 'dismiss_card：底下那张卡先放着，不写 target',
  open_deck: 'open_deck：打开要他办的事，target 写种类（登录/缺信息/没填成/过目/选择）或公司名，也可不写',
  ask_primary: 'ask_primary：直接办掉一件事（过目投出/没填成再试），target 写种类或公司名',
  ask_choose: 'ask_choose：替他选网页上的一项，target 写选项原文',
  open: 'open：打开一页，target 写 live / resume / resume:tailored / jobs / dossier / dossier:公司',
  start_feature: 'start_feature：直接进一个功能，target 写功能 id 或 功能id:公司',
};

const COMMON = [
  `你替一个找工作的大学生写"下一句直接可以点的话"，每轮正好 ${SUGGEST_MAX_CHIPS} 条。他不爱打字、没耐心、不会探索、不太信 AI。`,
  '四条合起来要做到：至少 1 条直接回小芽刚说的（小芽问了问题就至少 2 条）；至少 1 条点下去直接办事或直接进一个功能；',
  '每条都点到这一轮对话或状态里的真名字（公司、数字、经历、岗位、选项原文）；四条对象不重复、类型不全相同；和"上一轮出过"的不重复。',
  '不编他没说过的事实；不替他答应没定的事；不以"发给我 / 告诉我"收尾；不出现 技能/工具/模型/会话/任务 这些词；不加表情。',
  `每条 ≤${SUGGEST_MAX_CHARS} 字、第一人称、像他会说的话。`,
  '只输出 JSON，每条一个数组 [文字,intent,target]，say 只写 [文字]，没 target 不写：{"c":[["…"],["…","fill"],["…","open","live"]]}',
].join('\n');

export interface PromptInput {
  guide: SceneGuide;
  s: SuggestState;
  x: SuggestInput;
  thisTurn: SuggestThisTurn;
  /** 上一轮出过的四格文字。 */
  lastShown: readonly string[];
}

export interface BuiltPrompt { system: string; user: string }

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);
const toolName = (t: string) => TOOL_LABELS[t] ?? t;

/** 给模型看的状态：去掉 id，只留名字、数字和选项原文。 */
export function compactState(s: SuggestState): Record<string, unknown> {
  return {
    阶段: s.stage,
    等他: s.asks.slice(0, STATE_LIST_MAX).map(a => ({ 类: ASK_KIND_NAMES[a.kind]?.[0] ?? a.kind, 事: a.title, 公司: a.companies, 家数: a.count, 选项: s.askOptions[a.id] ?? [] })),
    底下的卡: s.openCard ? { 类: s.openCard.kind, 默认勾: s.openCard.picked, 勾了几家: s.openCard.pickedIds.length, 表里几家: s.openCard.allIds.length, 公司: s.openCard.company } : null,
    批量: s.batch ? { 状态: s.batch.status, 在填: s.batch.running, 填完: s.batch.done, 排队: s.batch.queued } : null,
    备好待投: s.held.count ? { 份数: s.held.count, 公司: s.held.companies } : null,
    下一批: s.nextJobs.slice(0, STATE_LIST_MAX).map(j => (j.title ? { 公司: j.company, 岗位: j.title } : { 公司: j.company })),
    刚定制: s.lastTailor ? { 公司: s.lastTailor.company, 改了几处: s.lastTailor.changes } : null,
    条件: s.prefs,
    简历: s.resume.has ? { 名字: s.resume.name, 定制几份: s.resume.tailored } : '还没有',
    经历段数: s.resume.experiences,
    访谈: s.interview ? {
      这一轮: roundLabel(s.interview.round), 在聊: s.interview.experienceTitle,
      接下来想问: s.interview.followUps, 还没聊: s.interview.roundsTodo.map(r => roundLabel(r)).filter(Boolean),
    } : null,
    三天内截止: s.dueSoon.slice(0, STATE_LIST_MAX).map(d => ({ 类: d.kind, 公司: d.company, 几天后: d.daysLeft ?? null })),
    近7天拒信: s.rejections7d,
    离上次说话小时: s.awayHours === null ? null : Math.round(s.awayHours),
    今天投出: s.todaySent,
    邮箱已连: s.mailConnected,
    手机已连: s.phoneLinked,
  };
}

function examplesOf(guide: SceneGuide): string {
  if (!guide.examples.length) return '';
  const rows = guide.examples.map((group, i) => `${i + 1}. ${group.map(e => e.split('|').map(p => p.trim()).filter(Boolean).join('｜')).join(' ／ ')}`);
  return `【示例，别照抄：只看思路，名字和数字必须换成下面状态和这一轮里的真东西】\n${rows.join('\n')}`;
}

export function systemOf(guide: SceneGuide): string {
  const intents = guide.intents.map(i => INTENT_HELP[i]).join('\n');
  return [COMMON, `intent 只能用：\n${intents}`, `【这一幕】${guide.text}`, examplesOf(guide)].filter(Boolean).join('\n');
}

function thisTurnText(t: SuggestThisTurn): string {
  const tools = t.tools.length ? t.tools.map(toolName).join('、') : '（没用）';
  const cards = t.cards.length ? t.cards.join('、') : '（没放）';
  return `这一轮：他说「${clip(t.user.trim(), THIS_USER_CHARS)}」；小芽说「${clip(t.assistant.trim(), THIS_ASSISTANT_CHARS)}」；小芽做了：${tools}；放了卡：${cards}`;
}

function historyLines(x: SuggestInput): string[] {
  return x.turns.map(t => `${t.role === 'user' ? 'U' : '小芽'}: ${clip(t.text.trim(), HISTORY_TURN_CHARS)}`);
}

/** 拼 system + user；超预算时先丢最早的历史轮。 */
export function buildPrompt({ guide, s, x, thisTurn, lastShown }: PromptInput): BuiltPrompt {
  const system = systemOf(guide);
  const head = [`状态：${JSON.stringify(compactState(s))}`, thisTurnText(thisTurn)];
  const tail = [`上一轮出过：${JSON.stringify(lastShown)}`, `出 ${SUGGEST_MAX_CHIPS} 条。`];
  let history = historyLines(x);
  const userOf = () => [...head, `最近几轮：\n${history.join('\n') || '（还没说话）'}`, ...tail].join('\n');
  let user = userOf();
  while (history.length && system.length + user.length > PROMPT_MAX_CHARS) {
    history = history.slice(1);
    user = userOf();
  }
  return { system, user };
}
