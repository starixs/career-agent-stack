/**
 * 下一步条 · 自动质量线（plan-r3-suggest §3）：每格都要"接得上、具体、顺手种下、点了也不坏"。
 * 不过的丢弃并留日志 `[career-suggest] lint drop <rule> <text>`；条上不够时由配方兜底补（suggest.ts）。
 * L10（回应性）不是丢弃规则，是补格规则，在 suggest.ts 里做。
 */
import { SUGGEST_MAX_CHARS, type SuggestChip } from '../../shared/careerSuggest';
import { isFeatureStart } from './suggest-chip';
import type { SceneId } from './suggest-scene';
import { shortCompany } from './suggest-text';
import type { SuggestState } from './suggest-types';

export type LintRule = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';

/** 一格最少几个字：一个字点不出对象。 */
const MIN_CHARS = 2;
/** 从对话里抽的词最短几个字。 */
const ENTITY_MIN = 2;
const DEV_WORDS = /技能|工具|模型|会话|agent|任务|经历库|私密库|占位符|json|提示词|系统提示|调用/i;
const PUNCT = '，。、；：！？,.;:!?';
const LEADING_PUNCT = new RegExp(`^[${PUNCT}…]`);
const DOUBLE_PUNCT = new RegExp(`[${PUNCT}]{2}`);
const RESIDUE = /[{}<>[\]]|\.\.|。。/;
const PROMISES = /保证|放心|肯定能|一定会|没问题的|躺/;
const SEND_ME = /发给我|告诉我|粘贴|复制给/;

/** 底下那张卡自己的按钮（plan-r3 L5；renderer 组同步核对）。建议条不再重复这些话。 */
export const CARD_BUTTONS: Readonly<Record<string, readonly string[]>> = {
  batch_pick: ['先不投', '投这'],
  tailor_diff: ['打开整份'],
  claims_confirm: ['全部通过'],
  resume_intake: ['全部通过，生成主简历', '只用所选'],
};

/** 常见虚词二字组：不算"对象"。 */
const STOP = new Set(('我们 你们 他们 可以 什么 这个 那个 一个 没有 就是 还是 怎么 一下 现在 已经 如果 因为 所以 但是 然后 知道 觉得 时候 不是 这样 那样 '
  + '好的 可能 需要 帮我 给我 我想 我的 你的 一些 有点 这些 那些 比较 自己 其实 而且 或者 还有 一点 不过 先聊 接着 我先 是不 不是 有没 没什 么样 这次 '
  + '的话 了吗 一起 看看 看一 一眼 直接 下一 然后 东西 事情 不用 好吗 行吗 对吧 吧我 你看 是什 么时 我也 也不 不太 不知 道怎 清楚').split(' '));
/** 经历类型、求职里的固定对象：算"这一类的名字"。 */
const DOMAIN = ['实习', '课程', '项目', '比赛', '竞赛', '社团', '学生会', '班委', '家教', '兼职', '证书', '奖学金', '简历', '方向', '岗位', '笔试', '测评', '面试', '开放题', '城市', 'Offer', 'offer', '邮箱', '验证码', '外包'];

export interface LintCtx {
  scene: SceneId;
  /** 状态与最近几轮里出现过的对象（entitiesOf）。 */
  entities: readonly string[];
  /** 底下在等的卡种类。 */
  cardKind: string | null;
  /** 冷却中的 seed（功能起头）。 */
  recent: ReadonlySet<string>;
}

function stateEntities(s: SuggestState): string[] {
  const companies = [
    ...s.asks.flatMap(a => a.companies), ...s.nextJobs.map(j => j.company), ...s.held.companies, ...(s.batch?.running ?? []),
    ...(s.openCard?.picked ?? []), ...(s.lastTailor ? [s.lastTailor.company] : []), ...s.dueSoon.map(d => d.company),
  ];
  return [
    ...companies.map(shortCompany), ...s.prefs.cities, ...s.prefs.keywords, ...s.asks.map(a => a.title),
    ...(s.resume.name ? [s.resume.name] : []), ...(s.interview?.experienceTitle ? [s.interview.experienceTitle] : []),
    ...Object.values(s.askOptions).flat(),
  ];
}

/** 对话里的数字、英文词、中文二字组（去虚词）。 */
function talkEntities(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    out.push(...(t.match(/\d+(?:\.\d+)?/g) ?? []), ...(t.match(/[A-Za-z]{2,}/g) ?? []));
    for (const run of t.match(/[一-龥]{2,}/g) ?? []) {
      for (let i = 0; i + ENTITY_MIN <= run.length; i += 1) {
        const gram = run.slice(i, i + ENTITY_MIN);
        if (!STOP.has(gram)) out.push(gram);
      }
    }
  }
  return out;
}

/** L4 用的对象表：状态里的名字 + 最近几轮对话里的词 + 领域词。 */
export function entitiesOf(s: SuggestState, texts: readonly string[]): string[] {
  const thread = [s.interview?.experienceTitle ?? '', ...(s.interview?.followUps ?? [])];
  const all = [...stateEntities(s), ...talkEntities([...texts, ...thread]), ...DOMAIN].map(e => e.trim()).filter(e => e.length >= ENTITY_MIN);
  return [...new Set(all)];
}

const collides = (text: string, button: string) => text === button || text.startsWith(button) || button.startsWith(text);

/** 单格规则（L1–L7、L9）：返回第一条不过的规则，过了返回 null。 */
export function lintChip(chip: SuggestChip, ctx: LintCtx): LintRule | null {
  const t = chip.text.trim();
  if (t.length < MIN_CHARS || t.length > SUGGEST_MAX_CHARS) return 'L1';
  if (DEV_WORDS.test(t)) return 'L2';
  if (RESIDUE.test(t) || LEADING_PUNCT.test(t) || DOUBLE_PUNCT.test(t)) return 'L3';
  if (chip.seed_id === null && !ctx.entities.some(e => t.includes(e))) return 'L4';
  if ((CARD_BUTTONS[ctx.cardKind ?? ''] ?? []).some(b => collides(t, b))) return 'L5';
  if (PROMISES.test(t)) return 'L6';
  if (SEND_ME.test(t)) return 'L7';
  if (ctx.scene !== 'S26' && chip.seed_id !== null && ctx.recent.has(chip.seed_id)) return 'L9';
  return null;
}

/**
 * 落点相同的不同动作：开现场抽屉 = 起头「网申进展」；出勾选表 = 起头「批量投递」。
 * 同一条上两格点下去到同一处就是重复（verify-r3 P1-2）。
 */
const DEST_OF_FEATURE: Readonly<Partial<Record<string, string>>> = { live: 'dest:live', batch: 'dest:batch' };

const actionKey = (c: SuggestChip): string | null => {
  const a = c.action;
  if (!a) return null;
  if (a.type === 'start_feature') return DEST_OF_FEATURE[a.feature_id] ?? `start_feature:${a.feature_id}`;
  if (a.type === 'open' && a.surface === 'live') return 'dest:live';
  if (a.type === 'propose_batch') return 'dest:batch';
  if (a.type === 'ask_choose') return `ask_choose:${a.ask_id}:${a.choice}`;
  if (a.type === 'start_card') return `${a.type}:${(a.job_ids ?? []).join(',')}`;
  if (a.type === 'open') return `open:${a.surface}:${a.id ?? ''}`;
  return `${a.type}:${'ask_id' in a ? a.ask_id ?? '' : ''}${'card_id' in a ? a.card_id : ''}`;
};

/** L8 同轮去重：同字、同动作、两个退出口、两个起头（S26 除外）只留先来的。 */
function duplicateOf(chip: SuggestChip, kept: readonly SuggestChip[], scene: SceneId): boolean {
  const key = actionKey(chip);
  if (kept.some(k => k.text === chip.text || (key !== null && actionKey(k) === key))) return true;
  if (chip.mode === 'exit' && kept.some(k => k.mode === 'exit')) return true;
  return scene !== 'S26' && isFeatureStart(chip) && kept.some(isFeatureStart);
}

export interface LintResult { kept: SuggestChip[]; dropped: Array<{ chip: SuggestChip; rule: LintRule }> }

/** 整条过线：按传入顺序（规则格 → 模型格 → 兜底格）保留，不过的丢弃并记日志。 */
export function lintChips(chips: readonly SuggestChip[], ctx: LintCtx): LintResult {
  const kept: SuggestChip[] = [];
  const dropped: LintResult['dropped'] = [];
  for (const chip of chips) {
    const rule = lintChip(chip, ctx) ?? (duplicateOf(chip, kept, ctx.scene) ? 'L8' : null);
    if (!rule) { kept.push(chip); continue; }
    dropped.push({ chip, rule });
    if (rule !== 'L8') console.info(`[career-suggest] lint drop ${rule} ${chip.text}`);
  }
  return { kept, dropped };
}
