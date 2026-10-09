/**
 * 答案库的敏感度分级与"不进记忆"规则。
 *
 *  - excluded：永远不存、不复用、不上传——证件号 / 银行卡 / 密码 / 验证码，
 *    以及"是否使用 AI 作答"、反机器人陷阱题（这类问题必须由本人当场如实回答）。
 *  - self_id：自我认同类（性别、民族、政治面貌、宗教、婚姻、健康 / 残疾）：可存本地复用，上传时只报"有改动"，不带值。
 *  - personal：个人联系方式与身份信息：同上，不上传值（明文本来就在私密库，答案库里通常是占位符）。
 *  - normal：其余网申问题。
 */
export const ANSWER_SENSITIVITIES = ['normal', 'personal', 'self_id', 'excluded'] as const
export type AnswerSensitivity = typeof ANSWER_SENSITIVITIES[number]
export const ANSWER_STATUSES = ['active', 'pinned', 'archived'] as const
export type AnswerStatus = typeof ANSWER_STATUSES[number]

const EXCLUDED: RegExp[] = [
  /身份证|证件号|护照号|通行证号|银行卡|卡号|开户行账号|密码|口令|验证码|校验码/,
  // 是否使用 AI 作答 / AI 辅助声明：必须本人如实回答
  /(是否|有没有|有无|请说明|声明).{0,12}(使用|借助|用了|利用|采用).{0,8}(AI|ＡＩ|人工智能|大模型|ChatGPT|GPT|生成式|智能写作|AIGC)/i,
  /(AI|人工智能|大模型|ChatGPT|AIGC).{0,8}(辅助|代写|生成|作答|撰写).{0,8}(声明|说明|是否|情况)/i,
  /\b(did|have) you (use|used) (ai|chatgpt|gpt|generative)/i,
  // 反机器人 / 诚信陷阱题
  /(机器人|自动化程序|爬虫).{0,6}(请勿|不要|切勿)填写|请勿填写此项|此项请留空|honeypot|leave (this|blank) (field )?empty/i,
]
const SELF_ID: RegExp[] = [/性别|民族|政治面貌|宗教|信仰|婚姻|婚育|生育|残疾|残障|健康状况|病史|性取向|gender|ethnicity|race|disability|veteran/i]
const PERSONAL: RegExp[] = [/姓名|手机|电话|邮箱|e-?mail|住址|家庭地址|通讯地址|出生日期|生日|籍贯|户口|户籍|紧急联系人|微信号|QQ号/i]

export function classifyAnswerSensitivity(questionText: string): AnswerSensitivity {
  const q = questionText.normalize('NFKC')
  if (EXCLUDED.some(r => r.test(q))) return 'excluded'
  if (SELF_ID.some(r => r.test(q))) return 'self_id'
  if (PERSONAL.some(r => r.test(q))) return 'personal'
  return 'normal'
}

/** 是否属于"不进答案记忆"的问题（证件 / 密码 / 是否使用 AI / 反机器人）。 */
export function isExcludedQuestion(questionText: string): boolean { return classifyAnswerSensitivity(questionText) === 'excluded' }

/**
 * 问题键归一化：NFKC → 去必填星号 / 冒号 / （必填）（选填）→ 合并空白 → 小写。
 * 同一问题在不同站点、不同写法下得到同一个键。
 */
export function normalizeQuestionKey(label: string): string {
  return label.normalize('NFKC')
    .replace(/[*＊✱]/g, '')
    .replace(/[（(]\s*(必填|选填|可选|required|optional)\s*[)）]/gi, '')
    .replace(/[：:？?。.!！]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 答案事件：答过 / 改过 / 用户在页面上纠正过；构成上传队列（answer_event）。 */
export const ANSWER_EVENT_KINDS = ['answered', 'edited', 'corrected', 'archived', 'deleted'] as const
export type AnswerEventKind = typeof ANSWER_EVENT_KINDS[number]
