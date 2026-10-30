/**
 * 自主找路：从校招首页 / 合集页 / 任意中间页，一步一步走到「这家公司里和他方向对口的岗位」的网申表或登录页就停。
 *
 * 思路移植自 GenericAgent（https://github.com/lsdefine/GenericAgent ，MIT，Copyright (c) 2025 lsdefine）的自主执行循环：
 * 每回合「感知页面 → 推理 → 调一个工具 → 记一句工作记忆」，上下文只带工作记事板（key_info）+ 最近几步摘要，
 * 原地打转时提醒换策略。face-ga-port 已定：循环只负责找路和没见过的步骤；填表、核对、绝不点提交仍归填表引擎。
 *
 * 感知 / 操作复用 browse.ts 的 observe / act（观察编号、回执、提交闸），这里只注入：
 *  - 点击闸：只放行入口词（「申请职位」「立即申请」，以及该站适配器认可的「投递」），其余提交类按钮一律不点；
 *  - 站点做法（site-sop.ts）：上次在这个站走通的路径放进提示，先照着走。
 */
import { extractJson, type LLM } from '@career/core';

import type { ActRequest, Observation, Receipt } from './browse';

export type PathfinderState = 'form' | 'login' | 'no_position' | 'stuck';
export interface PathfinderGoal {
  company: string;
  /** 岗位库里的岗位名（常是「软件类 / 通信类 / IC类」这一层）。 */
  jobTitle: string;
  /** 他的方向、期望城市、学历。 */
  direction: string[]; cities: string[]; degree?: string | null;
  /** 这个站上次走通的做法（site-sop.ts），没有就空。 */
  sop?: string;
}
/** 走通的一步（记成站点做法用）。 */
export interface PathfinderStep { action: ActRequest['action']; target: string; url: string }
export interface PathfinderResult { state: PathfinderState; note: string; turns: number; steps: PathfinderStep[] }
export interface PathfinderDeps {
  llm: LLM;
  observe(): Promise<Observation>;
  act(req: ActRequest): Promise<Receipt>;
  maxTurns?: number;
  log?(msg: string): void;
}

/** 一趟最多走几步：首页 → 栏目 → 搜索 → 列表 → 详情 → 入口，十来步足够；再多就是在乱逛。 */
export const PATHFINDER_MAX_TURNS = 14;
/** 连续几步页面没变化就提醒换策略（GA：停止无效重试，换路子）。 */
const STALL_LIMIT = 3;
/** 每回合给模型看的元素 / 正文上限：控制上下文（GA 主张小上下文，噪声少、幻觉少）。 */
const MAX_ELEMENTS = 60;
const MAX_TEXT = 1200;
const RECENT_STEPS = 8;

const SYSTEM = [
  '你在替一名应届生找网申入口。目标：从当前页面走到【这家公司里和他方向对口的具体岗位】的网申填写页，或者网站要求登录的那一页，然后停下。',
  '规则：',
  '1. 只找路，不填表、不提交。岗位详情页上的「投递 / 申请职位 / 立即申请」入口可以点（工具会拦住真正的提交按钮）。',
  '2. 一次只做一步，看清页面再动；点不动或页面没变就换别的路（搜索框、「校园招聘」栏目、岗位列表、翻页、返回）。',
  '3. 选岗：方向对口最重要；其次城市；学历要求高于他的（他本科而岗位写「硕士及以上 / 博士」）不选；「海外留学生专项」「社招 / 有工作经验」不选；校招、应届优先。',
  '4. 判断停下：页面上出现姓名、手机、教育经历之类要填的格子 → done:form；出现登录框、扫码登录、手机验证码登录 → done:login；翻遍了也没有对口岗位 → done:no_position（note 里写这家有哪些岗位）。',
  '只输出 JSON：{"summary":"这一步看到了什么、做了什么（一句话）","key_info":"可选：要一直记住的事","action":{…}}。',
  'action 只能是其一：{"type":"click","ref":元素编号} | {"type":"type","ref":元素编号,"text":"…"} | {"type":"press","key":"Enter"} | {"type":"scroll","direction":"down"} | {"type":"back"} | {"type":"navigate","url":"https://…"} | {"type":"done","state":"form|login|no_position|stuck","note":"…"}',
].join('\n');

interface Decision { summary?: unknown; key_info?: unknown; action?: { type?: unknown; ref?: unknown; text?: unknown; key?: unknown; direction?: unknown; url?: unknown; state?: unknown; note?: unknown } }
interface Memory { keyInfo: string; history: string[]; stall: number }

const STATES: ReadonlySet<string> = new Set(['form', 'login', 'no_position', 'stuck']);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 这一页给模型看的样子：编号元素 + 一段正文 + 页面提示。 */
export function describePage(obs: Observation): string {
  const els = obs.elements.slice(0, MAX_ELEMENTS).map(e => {
    const extra = [e.href ? `→${clip(e.href, 60)}` : '', e.value ? `值=${clip(e.value, 20)}` : '', e.guarded ? `（${e.guarded === 'submit' ? '提交类，不能点' : '密码框'}）` : '', e.offscreen ? '（屏外）' : ''].filter(Boolean).join(' ');
    return `[${e.ref}] ${e.kind} ${clip(e.text, 60)}${extra ? ` ${extra}` : ''}`;
  });
  const more = obs.more_elements > 0 ? `\n（还有 ${obs.more_elements} 个元素，往下滚动能看到）` : '';
  const hints = obs.hints.length ? `\n页面提示：${obs.hints.join('、')}` : '';
  return `网址：${obs.url}\n标题：${obs.title}${hints}\n可操作元素：\n${els.join('\n')}${more}\n正文摘录：${clip(obs.text, MAX_TEXT)}`;
}

function turnPrompt(goal: PathfinderGoal, obs: Observation, mem: Memory, turn: number, maxTurns: number): string {
  const who = `公司：${goal.company}\n岗位库里的岗位：${goal.jobTitle}\n他的方向：${goal.direction.join('、') || '（没写）'}；期望城市：${goal.cities.join('、') || '不限'}；学历：${goal.degree ?? '本科'}`;
  const sop = goal.sop ? `\n这个网站上次走通的做法（先照着走，对不上再自己找）：\n${goal.sop}` : '';
  const recent = mem.history.length ? `\n已经走过的步骤：\n${mem.history.slice(-RECENT_STEPS).join('\n')}` : '';
  const key = mem.keyInfo ? `\n要记住的：${mem.keyInfo}` : '';
  const stall = mem.stall >= STALL_LIMIT ? `\n[注意] 已经连续 ${mem.stall} 步页面没变化：别再重复同一个操作，换一条路（搜索、栏目、列表、返回），实在没有就 done。` : '';
  return `${who}${sop}${key}${recent}${stall}\n\n第 ${turn} / ${maxTurns} 步。当前页面：\n${describePage(obs)}`;
}

function toRequest(action: NonNullable<Decision['action']>, obsId: string): ActRequest | null {
  const type = str(action.type);
  const ref = typeof action.ref === 'number' ? action.ref : Number(action.ref);
  switch (type) {
    case 'click': return Number.isFinite(ref) ? { action: 'click', observation_id: obsId, ref } : null;
    case 'type': return Number.isFinite(ref) ? { action: 'type', observation_id: obsId, ref, text: str(action.text), submit: false } : null;
    case 'press': return { action: 'press', key: str(action.key) || 'Enter' };
    case 'scroll': return { action: 'scroll', direction: str(action.direction) === 'up' ? 'up' : 'down' };
    case 'back': return { action: 'back' };
    case 'navigate': return /^https?:\/\//i.test(str(action.url)) ? { action: 'navigate', url: str(action.url) } : null;
    default: return null;
  }
}

async function decide(deps: PathfinderDeps, prompt: string): Promise<Decision | null> {
  try {
    const res = await deps.llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: prompt }], json: true, maxTokens: 600, temperature: 0 });
    return extractJson<Decision>(res.text);
  } catch (error) {
    deps.log?.(`找路：模型这一步没给出可用的决定（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}

function targetText(obs: Observation, req: ActRequest): string {
  if (req.ref !== undefined) return obs.elements.find(e => e.ref === req.ref)?.text ?? `#${req.ref}`;
  return req.url ?? req.text ?? req.key ?? req.direction ?? '';
}

/** 走一趟。永不抛错：读页面失败、模型失败都折算成 stuck，让调用方按「没找到」处理。 */
export async function findApplicationPage(deps: PathfinderDeps, goal: PathfinderGoal): Promise<PathfinderResult> {
  const maxTurns = deps.maxTurns ?? PATHFINDER_MAX_TURNS;
  const mem: Memory = { keyInfo: '', history: [], stall: 0 };
  const steps: PathfinderStep[] = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const obs = await deps.observe().catch((error: unknown) => { deps.log?.(`找路：读页面失败（${error instanceof Error ? error.message : String(error)}）`); return null; });
    if (!obs) return { state: 'stuck', note: '读不到页面', turns: turn, steps };
    const d = await decide(deps, turnPrompt(goal, obs, mem, turn, maxTurns));
    if (!d?.action) { mem.history.push(`${turn}. （模型没给出动作）`); mem.stall++; continue; }
    if (str(d.key_info)) mem.keyInfo = clip(str(d.key_info), 300);
    if (str(d.action.type) === 'done') {
      const state = STATES.has(str(d.action.state)) ? str(d.action.state) as PathfinderState : 'stuck';
      return { state, note: clip(str(d.action.note) || str(d.summary), 300), turns: turn, steps };
    }
    const req = toRequest(d.action, obs.observation_id);
    if (!req) { mem.history.push(`${turn}. 动作不合法（${clip(JSON.stringify(d.action), 80)}），没执行`); mem.stall++; continue; }
    const receipt = await deps.act(req);
    const effect = receipt.ok ? receipt.observed_effect : `没成：${clip(receipt.note, 60)}`;
    mem.history.push(`${turn}. ${clip(str(d.summary), 80)} → ${req.action} ${clip(targetText(obs, req), 40)}（${effect}）`);
    mem.stall = receipt.ok && receipt.observed_effect !== 'no_change' ? 0 : mem.stall + 1;
    if (receipt.ok && receipt.observed_effect !== 'no_change') steps.push({ action: req.action, target: clip(targetText(obs, req), 60), url: receipt.url_after });
    deps.log?.(`找路 ${turn}：${mem.history[mem.history.length - 1]}`);
  }
  return { state: 'stuck', note: `走了 ${maxTurns} 步还没到网申表`, turns: maxTurns, steps };
}
