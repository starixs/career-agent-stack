import { describe, it, expect } from 'vitest'
import { FakePage, extractFields, radioOptionSelector, formFingerprint } from '../src/index.js'

describe('extract（FakePage）', () => {
  it('能从 FakePage 得到字段：label/type/options/required/value/文件/富文本', async () => {
    const page = new FakePage({
      url: 'https://x.com/apply', fields: [
        { label: '姓名', required: true },
        { label: '邮箱', type: 'email' },
        { label: '学历', type: 'select', options: ['本科', '硕士'] },
        { label: '性别', type: 'radio', options: ['男', '女'] },
        { label: '简历', type: 'file', required: true },
        { label: '自我评价', type: 'richtext', value: '已有内容' },
        { label: '同意协议', type: 'checkbox' },
      ],
    })
    const fields = await extractFields(page)
    expect(fields.map(f => f.type)).toEqual(['text', 'email', 'select', 'radio', 'file', 'richtext', 'checkbox'])
    expect(fields[0].required).toBe(true)
    expect(fields[2].options).toEqual(['本科', '硕士'])
    expect(fields[4].isFile).toBe(true)
    expect(fields[5].isRichText).toBe(true)
    expect(fields[5].value).toBe('已有内容')
    expect(fields[6].value).toBe('false')
    expect(fields[0].selector).toBe('[data-career-field="f0"]')
    expect(radioOptionSelector(fields[3], '男')).toBe('[data-career-field="f3"][data-career-option="男"]')
    expect(formFingerprint(page.url(), fields)).toContain('text:姓名')
  })
})
