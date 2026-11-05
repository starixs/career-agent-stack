/**
 * 搜题里调模型的两步：
 *   1. recognizeQuestions：把截图或粘贴的文字拆成一道道题（只抄题，不作答）；
 *   2. answerQuestions：带着题库里检索到的参考题作答。参考题是让答案比「直接问大模型」更准的关键。
 * 模型输出一律过 parse* 校验，字段不对就丢掉那一项，整份不对就报错。
 */
import { extractJson, type LLM, type LlmImage } from '@career/core';

import { QUESTION_TYPES, type BankMatch, type QuestionType } from './bank';
import type { MatchTier, SearchContext } from './match';

export interface RecognizedQuestion { index: number; stem: string; options: string[]; qtype: QuestionType | null }
/** material：几道题共用的材料（阅读段落、资料分析的表格），Markdown；记录里就存这份文字，不存截图。 */
export interface Recognition { company_hint: string | null; role_hint: string | null; material: string | null; questions: RecognizedQuestion[] }

export type AnswerConfidence = 'high' | 'medium' | 'low';
export type AnswerSource = 'bank' | 'reference' | 'model';
export interface QuestionAnswer { index: number; answer: string; explanation: string; confidence: AnswerConfidence; source: AnswerSource; ref_item_id: string | null }

/** 识别只抄题，输出短；作答每题一两句解析。上限按一屏最多十来道题估。 */
const RECOGNIZE_MAX_TOKENS = 3000;
const ANSWER_MAX_TOKENS = 4000;
/** 每道题最多带几条参考题给模型，多了拖慢速度、稀释注意力。 */
const REFS_PER_QUESTION = 3;

const RECOGNIZE_SYSTEM = [
  '你在帮求职者读笔试、测评题。把输入（截图或文字）里的每一道题原样抄出来，只抄题，不作答。',
  '有好几张截图时，它们是按顺序连着截的：一道题被截成两半（题干在上一张、选项在下一张）就拼成一道；同一道题在两张图里重复出现只抄一次。',
  '每道题：stem 题干（不含题号）；options 选项数组，每项保留字母前缀如「A. xxx」，没有选项给 []；',
  'qtype 题型，取值 single 单选 / multi 多选 / judge 判断 / fill 填空 / short 简答 / personality 性格或情境测评（没有对错，问你更像哪种人、会怎么做）。',
  '题目共用的材料（阅读段落、资料分析的文字和表格、情境描述）原样抄进 material，表格写成 Markdown 表格；图形题的图用一句话描述；没有材料填 null。',
  '看不清的字用 □ 代替，不要猜。没有题就返回空数组。',
  '如果画面里能看到公司名或岗位名（试卷标题、页眉），填 company_hint / role_hint，看不到填 null。',
  '输出 JSON：{"company_hint":string|null,"role_hint":string|null,"material":string|null,"questions":[{"stem":"","options":[],"qtype":""}]}',
].join('\n');

const ANSWER_SYSTEM = [
  '你在帮求职者现场答笔试、测评题，要又快又准。',
  '开头可能有几道题共用的 <材料>，作答时以材料里的数据和内容为准。',
  '每道题后面可能附了题库里的参考题（带答案与解析，注明来源是同公司同岗位往年题、别家同岗位题还是通用题）。',
  '参考题和本题是同一道题时，以参考答案为准，除非它明显错了；只是类似时，借鉴其中的考点和思路。',
  '没有参考题就凭你自己的知识作答。',
  '性格、情境测评题没有标准答案：按这个岗位看重的特质，给出最稳妥的倾向选项，解析说明这个岗位看重什么。',
  'answer 只写最终答案（选择题写字母，如「C」「ABD」；判断题写「对」或「错」；填空、简答写要点）。',
  'explanation 一到两句，说清为什么，不要复述题干。',
  'confidence：确定 high / 比较有把握 medium / 拿不准 low。拿不准就如实标 low，不要装作确定。',
  '每道题都要答，一题一条；index 照抄 <题 index="…"> 里的数字，不要自己重新编号。',
  '输出 JSON：{"answers":[{"index":0,"answer":"","explanation":"","confidence":"high"}]}',
].join('\n');

export async function recognizeQuestions(llm: LLM, input: { images?: LlmImage[]; text?: string }): Promise<Recognition> {
  const images = input.images ?? [];
  const content = input.text?.trim() ? `题目文字如下：\n${input.text.trim()}` : images.length > 1 ? `题目在这 ${images.length} 张截图里，按顺序连着。` : '题目在截图里。';
  const response = await llm.complete({
    system: RECOGNIZE_SYSTEM,
    messages: [{ role: 'user', content, ...(images.length > 0 ? { images } : {}) }],
    json: true, maxTokens: RECOGNIZE_MAX_TOKENS, temperature: 0,
  });
  return parseRecognition(extractJson<unknown>(response.text));
}

const TIER_LABEL: Record<MatchTier, string> = { 'same-role-company': '同公司同岗位往年题', 'same-role': '别家公司同岗位题', 'same-company': '同公司其他岗位题', general: '通用题' };

function refBlock(match: BankMatch, n: number): string {
  const where = [match.company_name, match.role_title, match.year].filter(Boolean).join(' · ');
  return [
    `  参考 ${n}（${TIER_LABEL[match.tier]}${where ? `，${where}` : ''}，与本题相似度 ${match.similarity.toFixed(2)}）`,
    `  题干：${match.stem}`,
    ...(match.options.length ? [`  选项：${match.options.join(' / ')}`] : []),
    `  答案：${match.answer ?? '（题库没给）'}`,
    ...(match.explanation ? [`  解析：${match.explanation}`] : []),
  ].join('\n');
}

export function buildAnswerPrompt(questions: Array<RecognizedQuestion & { matches: BankMatch[] }>, ctx: SearchContext, material: string | null = null): string {
  const head = [`这场笔试：${ctx.companyName ?? '公司未知'} · ${ctx.roleTitle ?? '岗位未知'}`, ...(material ? [`<材料>\n${material}\n</材料>`] : [])].join('\n\n');
  const blocks = questions.map(q => [
    `<题 index="${q.index}" 题型="${q.qtype ?? '未知'}">`,
    `题干：${q.stem}`,
    ...(q.options.length ? [`选项：${q.options.join(' / ')}`] : []),
    ...q.matches.slice(0, REFS_PER_QUESTION).map((m, i) => refBlock(m, i + 1)),
    '</题>',
  ].join('\n'));
  return [head, ...blocks].join('\n\n');
}

export async function answerQuestions(llm: LLM, questions: Array<RecognizedQuestion & { matches: BankMatch[] }>, ctx: SearchContext, material: string | null = null): Promise<QuestionAnswer[]> {
  if (questions.length === 0) return [];
  const response = await llm.complete({
    system: ANSWER_SYSTEM,
    messages: [{ role: 'user', content: buildAnswerPrompt(questions, ctx, material) }],
    json: true, maxTokens: ANSWER_MAX_TOKENS, temperature: 0,
  });
  const byIndex = new Map(questions.map(q => [q.index, q]));
  return parseAnswers(extractJson<unknown>(response.text)).flatMap(a => {
    const q = byIndex.get(a.index);
    if (!q) return [];
    const top = q.matches[0];
    return [{ ...a, source: top ? 'reference' : 'model', ref_item_id: top?.item_id ?? null } satisfies QuestionAnswer];
  });
}

// ─── 模型输出校验 ───

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isQuestionType = (v: unknown): v is QuestionType => typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);

export function parseRecognition(raw: unknown): Recognition {
  const obj = isDict(raw) ? raw : { questions: raw };
  if (!Array.isArray(obj.questions)) throw new Error('识别结果缺少 questions 数组');
  const questions = obj.questions.filter(isDict).flatMap((q): Array<Omit<RecognizedQuestion, 'index'>> => {
    const stem = text(q.stem);
    if (!stem) return [];
    const options = Array.isArray(q.options) ? q.options.map(text).filter((o): o is string => o !== null) : [];
    return [{ stem, options, qtype: isQuestionType(q.qtype) ? q.qtype : null }];
  });
  return { company_hint: text(obj.company_hint), role_hint: text(obj.role_hint), material: text(obj.material), questions: questions.map((q, index) => ({ index, ...q })) };
}

const CONFIDENCES: readonly AnswerConfidence[] = ['high', 'medium', 'low'];

export function parseAnswers(raw: unknown): Array<Pick<QuestionAnswer, 'index' | 'answer' | 'explanation' | 'confidence'>> {
  const list = isDict(raw) ? raw.answers : raw;
  if (!Array.isArray(list)) throw new Error('作答结果缺少 answers 数组');
  return list.filter(isDict).flatMap(a => {
    const answer = text(a.answer);
    if (typeof a.index !== 'number' || !answer) return [];
    const confidence = CONFIDENCES.find(c => c === a.confidence) ?? 'low';
    return [{ index: a.index, answer, explanation: text(a.explanation) ?? '', confidence }];
  });
}
