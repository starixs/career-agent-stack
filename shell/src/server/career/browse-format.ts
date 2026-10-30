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
    if (rc.required_next === 'handoff') lines.push('下一步：请用户帮一下（browser_wait_user），他做完接着办。');
    if (rc.required_next === 'retry_or_observe') lines.push('下一步：导航失败但无副作用——先重试一次 browser_act navigate；仍失败用 browser_observe 看当前页再决定，不要直接告诉用户打不开。');
  }
  const ob = out.observation as Observation | undefined;
  if (ob) {
    lines.push('', `观察 ${ob.observation_id} · ${ob.title}`, ob.url, `滚动 ${ob.scroll.y}/${ob.scroll.max}（视口 ${ob.scroll.viewport}）`);
    if (ob.tabs.length > 1) lines.push(`标签页：${ob.tabs.map(t => `[${t.index}${t.active ? '*' : ''}] ${t.title}`).join('  ')}`);
    const hintText: Record<string, string> = {
      login: '需要登录：存了账号就用占位符代填；扫码 / 短信码请用户帮一下（browser_wait_user），登录完接着办',
      captcha: '有验证码 / 人机验证：先 browser_solve_captcha 自己过，过不了再请用户帮一下',
      risk: '疑似风控 / 访问受限：不要重复同一操作；有验证码先自己过，过不了请用户帮一下，或者换个来源（web_search、别的网站）',
      submit_page: '页面上有提交 / 投递类按钮（不能点，走投递流程）',
    };
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

const WAIT_NOTES: Record<string, string> = {
  done: '他处理好了，挡路的东西已经没了：接着做原来的事。',
  handed_back: '他点了「交还」：先看下面的观察确认处理好了，再接着做原来的事。',
  timeout: '还没处理完——这不是失败。回复一句告诉他：做完点浏览器现场的「交还给小芽」就行，不用回来打字；他交还后你会收到消息，再 browser_observe 接着办。不要反复调用等待。',
  page_closed: '页面被关掉了：browser_open 重新打开原来的网址再继续。',
};

/** browser_wait_user 的结果：等的结论 + 新观察。 */
export function formatWaitUser(out: Record<string, unknown>): string {
  const wait = out.wait as { status: string; waited_ms: number } | undefined;
  const head = wait ? `等待结果：${wait.status}（等了 ${Math.round(wait.waited_ms / 1000)} 秒）。${WAIT_NOTES[wait.status] ?? ''}` : '等待没有返回结果。';
  return [head, formatBrowse({ observation: out.observation })].join('\n');
}

const SOLVE_NOTES: Record<string, string> = {
  solved: '验证码过了：接着做原来的事。',
  needs_user: '这个验证要请用户帮一下：用 browser_wait_user（waiting_for=captcha），告诉他在右边浏览器里完成验证；他做完你接着办。',
};

/** browser_solve_captcha 的结果：过没过、试了什么 + 新观察。 */
export function formatSolveCaptcha(out: Record<string, unknown>): string {
  const c = out.captcha as { status: string; kind?: string; attempts?: number; steps?: string[] } | undefined;
  const head = c ? `验证码（${c.kind ?? '未知'}）：${c.status}，试了 ${c.attempts ?? 0} 次。${(c.steps ?? []).join('；')}\n${SOLVE_NOTES[c.status] ?? ''}` : '没有返回结果。';
  return [head, formatBrowse({ observation: out.observation })].join('\n');
}
