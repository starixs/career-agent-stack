import type { PageLike } from './page.js'
import { extractFieldsScript, type FieldType, type RawField } from './scripts.js'

/** 抽取后的表单字段（引擎内部统一结构）。selector 指向被打了标记的真实控件。 */
export interface FormField {
  id: string
  label: string
  name?: string
  type: FieldType
  options: string[]
  required: boolean
  value?: string
  isFile: boolean
  isRichText: boolean
  /** 自定义下拉（选项要点开才出现），填写时用 点击+输入+回车。 */
  custom: boolean
  maxLength?: number
  placeholder?: string
  selector: string
  /** 字段来自哪一层：dom（默认）或 vision（截图感知配对出的伪字段，只能用坐标操作）。 */
  layer?: 'dom' | 'vision'
  /** vision 层：输入框在视口中的包围盒。 */
  box?: { x: number; y: number; w: number; h: number }
  /** 稳定定位键（站点记忆用）。 */
  xpath?: string
  /** UI 框架指纹（antd / element / … / native），决定页内执行器走哪个适配器。 */
  framework?: string
}

/** 确定性抽取：在页面里跑一段纯 DOM 脚本（FakePage 用内存模型回答）。 */
export async function extractFields(page: PageLike): Promise<FormField[]> {
  const raw = await page.evaluate(extractFieldsScript)
  return raw.map(normalizeField)
}

export function normalizeField(r: RawField): FormField {
  return {
    id: r.id,
    label: (r.label || r.placeholder || r.name || '').trim(),
    name: r.name,
    type: r.type,
    options: r.options ?? [],
    required: !!r.required,
    value: r.value,
    isFile: r.type === 'file',
    isRichText: r.type === 'richtext',
    custom: !!r.custom,
    maxLength: r.maxLength,
    placeholder: r.placeholder,
    selector: `[data-career-field="${r.id}"]`,
    xpath: r.xpath,
    framework: r.framework,
  }
}

/** 单选项的 selector（extract 脚本给每个 radio 打了 data-career-option）。 */
export function radioOptionSelector(field: FormField, option: string): string {
  return `${field.selector}[data-career-option="${option.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/** 页面指纹：url + 字段标签，用来判断"点了下一步但页面没变"。 */
export function formFingerprint(url: string, fields: FormField[]): string {
  return `${url}::${fields.map(f => `${f.type}:${f.label}`).join('|')}`
}
