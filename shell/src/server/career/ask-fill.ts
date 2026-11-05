/**
 * 「缺信息」在等你条里填一次，挡住的那一批全部放行（世界模型 §3.3 一事多申；用户 2026-10-30：能做一次的事就不让人再做）。
 *
 * 服务端一步做完：值存进本机私密库（资料字段）或答案库（其余）——明文不进模型；然后关掉这批接管，交给后台批量
 * 运行器从各自的当前页接着填（和登录「交回」走同一条路：handoff.resumed_at + BatchRunner run）。
 * 不发话给助理，不要用户再点。只有页面上才能看的项（上传、读回不一致）还在时，那几份不放行，接管留着。
 */
import { rememberDialogChoice, vaultMarksToTokens, type Repos, type Vault } from '@career/core';

import { BatchRunner } from './batch-runner';
import { asksFor } from './delivery';

export interface AskFillResult { saved: string[]; resumed: string[]; still_waiting: number }

export class AskFillError extends Error {}

export function fillAsk(repos: Repos, vault: Vault, askId: string, values: Record<string, string>, nowIso = new Date().toISOString()): AskFillResult {
  const ask = asksFor(repos, nowIso).find(a => a.id === askId && a.kind === 'info');
  if (!ask) throw new AskFillError(`这件事已经不在了：${askId}`);
  const fields = ask.fields ?? [];
  const filled = fields.filter(f => f.fillable && values[f.label]?.trim());
  if (!filled.length) throw new AskFillError('没有填任何一项');
  for (const f of filled) {
    const value = vaultMarksToTokens(values[f.label].trim()); // 草稿里的「【毕业院校】」换回占位符，填表时本机替换
    if (f.vault_field) vault.set({ scope: 'profile', field: f.vault_field, value });
    else repos.saveAnswer({ question_key: f.label, question_text: f.label, answer: value, confirmed: true, source: 'user' });
  }
  const complete = fields.every(f => f.fillable && values[f.label]?.trim());
  if (!complete) return { saved: filled.map(f => f.label), resumed: [], still_waiting: ask.sources.length };
  for (const s of ask.sources) if (s.type === 'handoff') repos.closeHandoff(s.id, 'filled_in_dock');
  const actionIds = ask.action_ids ?? [];
  if (actionIds.length) BatchRunner.command(repos, 'run', 'dock', actionIds);
  console.log(`[career] ask-fill ${askId}: ${filled.length} 项已存，${actionIds.length} 份交给后台接着填`);
  return { saved: filled.map(f => f.label), resumed: actionIds, still_waiting: 0 };
}

/**
 * 网页弹窗的选择题在等你卡上选好了（2026-11-05 阿里「请选择意向部门」）：记在这个站点名下，
 * 关掉接管、交给后台从当前页接着填——引擎碰到同一个弹窗就替他点这个按钮。
 */
export function chooseAsk(repos: Repos, askId: string, choice: string, nowIso = new Date().toISOString()): AskFillResult {
  const ask = asksFor(repos, nowIso).find(a => a.id === askId && a.kind === 'choice');
  if (!ask?.choice) throw new AskFillError(`这件事已经不在了：${askId}`);
  if (!ask.choice.options.includes(choice)) throw new AskFillError(`「${choice}」不在这个弹窗的选项里`);
  const actionIds = ask.action_ids ?? [];
  for (const id of actionIds) {
    const action = repos.getAction(id);
    const host = siteOfAction(action?.result_json ?? null, action?.payload_json ?? null);
    if (host) rememberDialogChoice(repos, host, ask.choice.question, choice);
  }
  for (const s of ask.sources) if (s.type === 'handoff') repos.closeHandoff(s.id, 'chosen_in_dock');
  if (actionIds.length) BatchRunner.command(repos, 'run', 'dock', actionIds);
  console.log(`[career] ask-choose ${askId}: 选了「${choice}」，${actionIds.length} 份交给后台接着填`);
  return { saved: [choice], resumed: actionIds, still_waiting: 0 };
}

/** 弹窗出现在哪个站：优先停下时的页面，其次岗位网址。 */
function siteOfAction(resultJson: string | null, payloadJson: string | null): string | null {
  for (const [raw, key] of [[resultJson, 'finalUrl'], [payloadJson, 'url']] as const) {
    try {
      const v: unknown = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null;
      if (typeof v === 'string' && v) return v;
    } catch (e) { console.warn(`[career] ask-choose: ${key} 解析失败`, e instanceof Error ? e.message : e); }
  }
  return null;
}
