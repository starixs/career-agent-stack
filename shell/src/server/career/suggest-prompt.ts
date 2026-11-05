/**
 * 下一步条 · 提示词（2026-11-05 你定的六段）：一次调用按配合 / 犹豫 / 纠正各写两条备选。
 * system = ① 角色与任务（第一人称、口语）② 立场分类 + 硬规矩 + 允许意图 + 这一幕的思路与示例（标"别照抄"）+ 输出格式；
 * user = ③ 用户画像 ④ 场景与状态 ⑤ 最近对话（每轮一句摘要）⑥ 最后一条回复（全文，连同他刚说的、小芽做了什么）+ 上一轮出过的。
 * 输出 {"配合":[[文字,intent,target],…],"犹豫":…,"纠正":…}，≈ 90–130 token，压在 3s 内。
 */
import { featureCatalogLine } from '../../shared/careerFeatures';
import { SUGGEST_MAX_CHARS, type SuggestThisTurn } from '../../shared/careerSuggest';
import { ASK_KIND_NAMES } from './suggest-intents';
import type { SceneGuide, SuggestIntent } from './suggest-guide-types';
import { roundLabel, type SuggestInput } from './suggest-scene';
import type { SuggestState } from './suggest-types';

/** 这一轮他说的最多带几个字。 */
const THIS_USER_CHARS = 300;
/** 这一轮小芽说的最多带几个字（最要紧的上下文）。 */
const THIS_ASSISTANT_CHARS = 600;
/** 最近对话每轮摘要最多几个字：取第一句，只给模型看来龙去脉，细节在"最后一条回复"。 */
const HISTORY_TURN_CHARS = 50;
/** system + user 总字数上限（≈ 1 000 + 1 300 token 的字符近似）；六段版比 r4 多了角色 / 立场 / 输出三段约 500 字。 */
export const PROMPT_MAX_CHARS = 3_500;
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
  start_feature: `start_feature：直接进一个功能，target 写功能 id 或 功能id:公司；id 只能是这些（id=名字）：${featureCatalogLine()}`,
};

const ROLE = [
  '【角色与任务】你就是这个正在找工作的大学生本人。小芽（你的求职助理）刚说完一段话，你替自己写下一句要回它的话：',
  `第一人称、口语、像微信里随手打的；每条 ≤${SUGGEST_MAX_CHARS} 字，点一下就发出去或直接办。`,
].join('\n');

const STANCES = [
  '【立场】按三种立场写，每种 2 条备选，第一条最好：',
  '配合：顺着小芽往下走——直接答它问的、答应它提的、让它办下一件具体的事。能点了直接办的（开投、挑一批、进功能、打开某页）放这里。',
  '犹豫：拿不准、想先看看、有顾虑、想缓一缓或先放着。说出具体顾虑（"这家加班多吗""记不清，大概几十个人"），别只说"再想想"。',
  '纠正：小芽这句里真有猜错、说错、方向不是他要的地方——点出那一处、改成什么（"我是 27 届，不是 26""外包的不要"）。',
  '  小芽没说错什么时，纠正就是换个方向（"其实我想先看岗位"）或留空让他自己说（"不太对，其实是："）；绝不编一个他没说过的事实去反驳。',
  '【硬规矩】点到这一轮或状态里的真名字（公司、数字、经历、岗位、选项原文）；不编他没说过的事实；不替他答应没定的事；不复述他刚说的那句；示例里的句子不许原样或近似照抄；',
  '不以"发给我 / 告诉我"收尾；不出现 技能/工具/模型/会话/任务 这些词；不加表情；和"上一轮出过"的不重复。',
].join('\n');

const OUTPUT = '【输出】只输出 JSON，每条一个数组 [文字,intent,target]，say 只写 [文字]，没 target 不写：{"配合":[["…","open","live"],["…"]],"犹豫":[["…"],["…"]],"纠正":[["…：","fill"],["…"]]}';

/** 用户画像的固定部分：他是谁、怎么待他（世界模型 · 人群前提）。 */
const PERSONA = '大学生，在找工作；不爱打字、没耐心、不会自己探索、不太信 AI，希望被一步步领着走。';

export interface PromptInput {
  guide: SceneGuide;
  s: SuggestState;
  x: SuggestInput;
  thisTurn: SuggestThisTurn;
  /** 上一轮出过的文字。 */
  lastShown: readonly string[];
  /** 判出的幕名（"访谈·开放问"）；缺省不写。 */
  sceneName?: string;
}

export interface BuiltPrompt { system: string; user: string }

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);
const toolName = (t: string) => TOOL_LABELS[t] ?? t;

/** 画像里他自己的事：届别、想找的、城市、简历、经历（状态里有才写）。 */
function profileOf(s: SuggestState): string {
  const parts = [
    s.prefs.cohort ? `${s.prefs.cohort} 届` : null,
    s.prefs.keywords.length ? `想找 ${s.prefs.keywords.join('、')}` : null,
    s.prefs.cities.length ? `城市 ${s.prefs.cities.join('、')}` : null,
    s.resume.has ? `有简历${s.resume.name ? `（${s.resume.name}）` : ''}` : '还没有简历',
    s.resume.experiences ? `记下 ${s.resume.experiences} 段经历` : null,
  ];
  return parts.filter(Boolean).join('；');
}

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

/** 示例每组三行，按配合 / 犹豫 / 纠正标出来。 */
const STANCE_LABELS = ['配合', '犹豫', '纠正'];

function examplesOf(guide: SceneGuide): string {
  if (!guide.examples.length) return '';
  const rowText = (e: string) => e.split('|').map(p => p.trim()).filter(Boolean).join('｜');
  const rows = guide.examples.map((group, i) => `${i + 1}. ${group.map((e, j) => `${STANCE_LABELS[j] ?? ''}：${rowText(e)}`).join(' ／ ')}`);
  return `【示例，别照抄：只看思路，名字和数字必须换成下面状态和这一轮里的真东西】\n${rows.join('\n')}`;
}

export function systemOf(guide: SceneGuide): string {
  const intents = guide.intents.map(i => INTENT_HELP[i]).join('\n');
  return [ROLE, STANCES, `intent 只能用：\n${intents}`, `【这一幕的思路】${guide.text}`, examplesOf(guide), OUTPUT].filter(Boolean).join('\n');
}

function lastReplyText(t: SuggestThisTurn): string {
  const tools = t.tools.length ? t.tools.map(toolName).join('、') : '（没用）';
  const cards = t.cards.length ? t.cards.join('、') : '（没放）';
  return [
    `【最后一条回复】小芽说「${clip(t.assistant.trim(), THIS_ASSISTANT_CHARS)}」`,
    `（这之前他说「${clip(t.user.trim(), THIS_USER_CHARS)}」；小芽做了：${tools}；放了卡：${cards}）`,
  ].join('\n');
}

/** 一轮的摘要：第一句（到句号 / 问号 / 叹号 / 换行），再截短。 */
export function gistOf(text: string): string {
  const flat = text.trim();
  const end = flat.search(/[。！？!?\n]/);
  return clip(end > 0 ? flat.slice(0, end + 1) : flat, HISTORY_TURN_CHARS);
}

function historyLines(x: SuggestInput): string[] {
  return x.turns.map(t => `${t.role === 'user' ? '我' : '小芽'}: ${gistOf(t.text)}`);
}

/** 拼 system + user；超预算时先丢最早的历史轮。 */
export function buildPrompt({ guide, s, x, thisTurn, lastShown, sceneName }: PromptInput): BuiltPrompt {
  const system = systemOf(guide);
  const persona = `【我是谁】${PERSONA}${profileOf(s) ? `我的情况：${profileOf(s)}。` : ''}`;
  const scene = `【场景与状态】${sceneName ? `现在是「${sceneName}」。` : ''}状态：${JSON.stringify(compactState(s))}`;
  const tail = [lastReplyText(thisTurn), `上一轮出过：${JSON.stringify(lastShown)}`, '按配合、犹豫、纠正各写 2 条。'];
  let history = historyLines(x);
  const userOf = () => [persona, scene, `【最近对话（摘要）】\n${history.join('\n') || '（还没说话）'}`, ...tail].join('\n');
  let user = userOf();
  while (history.length && system.length + user.length > PROMPT_MAX_CHARS) {
    history = history.slice(1);
    user = userOf();
  }
  return { system, user };
}
