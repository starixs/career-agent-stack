/**
 * 字段级失败原因码与人话说明。原因码进结果与遥测（供迭代统计），说明给用户看；
 * Playwright 的英文报错原文只进遥测，不进审阅清单、不进进度文案。
 */
export type FieldReasonCode =
  | 'blocked_by_overlay'     // 被弹窗 / 遮罩挡住，点不到
  | 'timeout'                // 动作超时（看门狗或 Playwright）
  | 'element_missing'        // 控件不见了（页面重渲染）
  | 'not_editable'           // 只读 / 禁用 / 自定义控件，不能直接写值
  | 'field_disabled'         // 控件是灰的（禁用）：联动没解锁，或网站锁定了（如账号绑定的手机号）
  | 'options_not_found'      // 自定义下拉点开后没看到选项
  | 'no_matching_option'     // 选项里没有对得上的
  | 'option_not_selected'    // 点了选项，显示值没变
  | 'date_unparseable'       // 资料里的日期看不懂
  | 'date_panel_unsupported' // 日期面板认不出 / 导航不到
  | 'readback_mismatch'      // 写了，读回来对不上
  | 'label_uncertain'        // 标签可疑（导航栏文字 / 太长 / 认不出），不敢填
  | 'duplicate_write'        // 另一阶段已写过不同的值
  | 'vision_failed'          // 视觉层也没填进去
  | 'fill_error'             // 其他填写异常
  | 'empty_after_rollback'   // 核验不过，已清空回原值
  | 'rollback_failed'        // 核验不过，且没能清空（页面上可能留着错值）

export const REASON_TEXT: Record<FieldReasonCode, string> = {
  blocked_by_overlay: '被页面弹窗挡住了，没点到这一格',
  timeout: '操作超时，页面没有响应',
  element_missing: '这一格在页面上找不到了（页面可能刷新过）',
  not_editable: '这一格不能直接输入（只读或自定义控件），没敢硬写',
  field_disabled: '这一格是灰的（禁用），可能要先填前面的格子，或网站锁定了不让改',
  options_not_found: '点开下拉后没看到可选项',
  no_matching_option: '下拉选项里没有和你的资料对得上的',
  option_not_selected: '点了选项，但页面上显示的值没变',
  date_unparseable: '资料里的日期格式看不懂',
  date_panel_unsupported: '日期选择面板认不出来，没能选到对应年月',
  readback_mismatch: '填进去后读回来对不上',
  label_uncertain: '没认准这一格是什么（标签可疑），宁可留空',
  duplicate_write: '这一格已经由别的步骤填过',
  vision_failed: '截图方式也没能填进去',
  fill_error: '填写时出错了',
  empty_after_rollback: '没核验通过，已经清空，需要你来补',
  rollback_failed: '没核验通过，也没能清空，请你检查这一格',
}

export function reasonText(code: FieldReasonCode | undefined, fallback = '需要你来填'): string {
  return code ? REASON_TEXT[code] ?? fallback : fallback
}

/** 把异常（多为 Playwright 英文报错）归到原因码；原文截断后只给遥测。 */
export function classifyError(e: unknown): { code: FieldReasonCode; text: string; raw: string } {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000)
  let code: FieldReasonCode = 'fill_error'
  if (/intercepts pointer events|is not visible because|obscured|遮挡/i.test(raw)) code = 'blocked_by_overlay'
  else if (/Timeout \d+ms exceeded|timed? ?out|看门狗|超时/i.test(raw)) code = 'timeout'
  else if (/not editable|readonly|read-only|is disabled|element is not enabled/i.test(raw)) code = 'not_editable'
  else if (/resolved to 0 elements|detached|not attached|no element|找不到|不存在/i.test(raw)) code = 'element_missing'
  return { code, text: REASON_TEXT[code], raw }
}

/** 看门狗：超时抛出带 code 的错误（原动作可能仍在后台跑完，调用方按失败处理并核验）。 */
export class WatchdogTimeout extends Error {
  constructor(public readonly step: string, public readonly ms: number) { super(`看门狗超时：${step}（${ms}ms）`); this.name = 'WatchdogTimeout' }
}
export async function withWatchdog<T>(step: string, ms: number, work: () => Promise<T>): Promise<T> {
  if (!ms || ms <= 0) return work()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WatchdogTimeout(step, ms)), ms) })])
  } finally { if (timer) clearTimeout(timer) }
}
