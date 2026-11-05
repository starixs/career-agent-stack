/**
 * 网申页面上的选择题弹窗（阿里「请选择意向部门」）：学生在等你卡上选一次，记在站点名下，
 * 续跑时填表引擎碰到同一个弹窗直接替他点（2026-11-05：原来是「去浏览器里处理掉它」）。
 */
import { normalizeHost } from './vault.js'

export interface DialogChoiceStore { kvGet<T = unknown>(key: string): T | undefined; kvSet(key: string, value: unknown): void }

/** 键是站点，值是「弹窗文字键 → 按钮文字」。 */
export const dialogChoiceKey = (host: string) => `apply:dialog_choice:${normalizeHost(host)}`
/** 弹窗文字的比较键：去空白，取前 80 个字（同一个弹窗每次开头一样，后面的长列表可能变）。 */
export const dialogTextKey = (text: string) => text.replace(/\s+/g, '').slice(0, 80)

export function recallDialogChoice(store: DialogChoiceStore, host: string, text: string): string | undefined {
  return store.kvGet<Record<string, string>>(dialogChoiceKey(host))?.[dialogTextKey(text)]
}
export function rememberDialogChoice(store: DialogChoiceStore, host: string, text: string, choice: string): void {
  const key = dialogChoiceKey(host)
  store.kvSet(key, { ...(store.kvGet<Record<string, string>>(key) ?? {}), [dialogTextKey(text)]: choice })
}
