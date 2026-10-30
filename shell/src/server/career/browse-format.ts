/**
 * 浏览观察 / 回执排成给模型看的精简文字（编号清单比大段 JSON 好用）。
 * 产品工具（tools/career-tools.ts 的 browser_*）和模型在环冒烟（scripts/career-browse-agent-smoke.mjs）共用，保证两边模型看到的一样。
 */
import type { Observation } from './browse';

export function formatBrowse(out: Record<string, unknown>): string {
  const lines: string[] = [];
  const rc = out.receipt as Record<string, unknown> | undefined;
  if (rc) {
    lines.push(`回执：${rc.ok ? '成功' : '未执行 / 未确认'} · 效果 ${rc.observed_effect} · ${rc.retryable ? '可重试' : '不要重复这个操作'}${rc.code ? ` · ${rc.code}` : ''}`);
    lines.push(String(rc.note ?? ''));
    if (Array.isArray(rc.new_tabs) && rc.new_tabs.length) lines.push(`新标签页：${(rc.new_tabs as Array<{ title: string }>).map(t => t.title).join('、')}`);
    if (rc.required_next === 'apply_flow') lines.push('下一步：browser_capture_job 收录岗位 → apply_prepare（用户批准后由投递流程处理）。');
    if (rc.required_next === 'handoff') lines.push('下一步：请用户在现场处理（ui_open live），处理完再继续。');
    if (rc.required_next === 'retry_or_observe') lines.push('下一步：导航失败但无副作用——先重试一次 browser_act navigate；仍失败用 browser_observe 看当前页再决定，不要直接告诉用户打不开。');
  }
  const ob = out.observation as Observation | undefined;
  if (ob) {
    lines.push('', `观察 ${ob.observation_id} · ${ob.title}`, ob.url, `滚动 ${ob.scroll.y}/${ob.scroll.max}（视口 ${ob.scroll.viewport}）`);
    if (ob.tabs.length > 1) lines.push(`标签页：${ob.tabs.map(t => `[${t.index}${t.active ? '*' : ''}] ${t.title}`).join('  ')}`);
    const hintText: Record<string, string> = { login: '需要登录（请用户在现场登录，或用已存的账号占位符）', captcha: '有验证码 / 人机验证（必须请用户在现场处理）', risk: '疑似风控 / 访问过频（停下，请用户看一下）', submit_page: '页面上有提交 / 投递类按钮（不能点，走投递流程）' };
    if (ob.hints.length) lines.push(`提示：${ob.hints.map(h => hintText[h] ?? h).join('；')}`);
    lines.push('可操作元素（[编号] 类型 文字）：');
    for (const e of ob.elements) {
      const extra = [e.href ? `→ ${e.href}` : '', e.value ? `= ${e.value}` : '', e.checked !== undefined ? (e.checked ? '☑' : '☐') : '', e.options ? `选项：${e.options.slice(0, 8).join(' / ')}` : '', e.disabled ? '(不可用)' : '', e.offscreen ? '(在下方)' : '', e.guarded === 'submit' ? '⛔提交类，不能点' : e.guarded === 'password' ? '🔒密码框，只能填占位符' : ''].filter(Boolean).join(' ');
      lines.push(`[${e.ref}] ${e.kind} ${e.text}${extra ? ` ${extra}` : ''}`);
    }
    if (ob.more_elements > 0) lines.push(`（还有 ${ob.more_elements} 个元素没列出，滚动后再看）`);
    lines.push('', `正文摘要（共 ${ob.text_total} 字${ob.text_total > ob.text.length ? '，完整内容用 browser_read' : ''}）：`, ob.text);
  }
  return lines.join('\n');
}
