/**
 * 用户上传题库：文件 → 文字（复用聊天附件的分层读取）→ 分段交给模型拆成一道道题 → 写进题库。
 *
 * 题库文件可能几十页，分段拆题要好几次模型调用，超过渲染层请求的 120 秒上限，
 * 所以 startImport 先建一条「导入中」的题库立即返回，拆题在后台跑，跑完广播数据变更。
 * JSON 文件（我们整理题库用的格式）不经模型，直接校验后写入。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { extractJson, type LLM } from '@career/core';

import { convertAttachment, defaultConvertDeps } from '../attachment-reader';
import { QUESTION_TYPES, type BankItemInput, type ExamBank, type ExamBankStore, type QuestionType } from './bank';

/** 每段交给模型的字数：一段大约二三十道题，输出不至于被截断。 */
const CHUNK_CHARS = 6000;
/** 同时拆几段：再多容易撞上模型的并发限流。 */
const SPLIT_CONCURRENCY = 3;
const SPLIT_MAX_TOKENS = 8000;

const SPLIT_SYSTEM = [
  '你在整理笔试题库。把下面这段文字里的每一道题拆出来，原样保留题干和选项。',
  '文字里给了答案、解析就照抄；没给就填 null，绝对不要自己编答案。',
  'qtype 取值 single / multi / judge / fill / short / personality（性格、情境测评）。',
  '如果某道题旁边写了公司、岗位、年份，填进 company_name / role_title / year，没写就填 null。',
  '这段文字可能从一道题中间开始或结束，不完整的题直接跳过。',
  '输出 JSON：{"items":[{"stem":"","options":["A. …"],"answer":null,"explanation":null,"qtype":"single","company_name":null,"role_title":null,"year":null}]}',
].join('\n');

export interface ImportInput { fileName: string; data: Buffer; name?: string | null; companyName?: string | null; roleTitle?: string | null; year?: number | null }
export interface ImportDeps { bank: ExamBankStore; llm: LLM; dataDir: string; onDone?: (bank: ExamBank) => void }

export function startImport(input: ImportInput, deps: ImportDeps): ExamBank {
  const bank = deps.bank.createBank({
    name: input.name?.trim() || basename(input.fileName, extname(input.fileName)),
    origin: 'user', company_name: input.companyName ?? null, role_title: input.roleTitle ?? null, year: input.year ?? null, source_file: input.fileName,
  });
  void runImport(bank.id, input, deps);
  return bank;
}

async function runImport(bankId: string, input: ImportInput, deps: ImportDeps): Promise<void> {
  try {
    const items = extname(input.fileName).toLowerCase() === '.json'
      ? parseBankItems(JSON.parse(input.data.toString('utf8')))
      : await splitWithModel(await fileText(input, deps.dataDir), deps.llm);
    if (items.length === 0) throw new Error('没有从文件里认出题目');
    deps.bank.addItems(bankId, items);
    deps.bank.finishImport(bankId, null);
    console.log(`[exam-search] imported bank ${bankId}: ${items.length} 题`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[exam-search] FAILED import ${bankId} (${input.fileName}): ${message}`);
    deps.bank.finishImport(bankId, message);
  }
  const bank = deps.bank.getBank(bankId);
  if (bank) deps.onDone?.(bank);
}

async function fileText(input: ImportInput, dataDir: string): Promise<string> {
  const ext = extname(input.fileName).toLowerCase();
  if (['.txt', '.md', '.csv'].includes(ext)) return input.data.toString('utf8');
  const cwd = join(dataDir, 'exam-banks');
  const dir = join(cwd, 'uploads');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${Date.now()}-${basename(input.fileName)}`);
  writeFileSync(abs, input.data);
  const converted = await convertAttachment(abs, cwd, defaultConvertDeps(cwd));
  if (!converted.ok) throw new Error(`读不出文件内容：${converted.attempts.join('；')}`);
  return converted.text;
}

/** 按空行切段，尽量不把一道题拆到两段里。 */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const para of text.split(/\n\s*\n/)) {
    if (current && current.length + para.length > size) { chunks.push(current); current = ''; }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > size * 2) { chunks.push(current.slice(0, size)); current = current.slice(size); }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function splitWithModel(text: string, llm: LLM): Promise<BankItemInput[]> {
  const chunks = chunkText(text);
  const results: BankItemInput[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const response = await llm.complete({ system: SPLIT_SYSTEM, messages: [{ role: 'user', content: chunks[i] }], json: true, maxTokens: SPLIT_MAX_TOKENS, temperature: 0 });
      results[i] = parseBankItems(extractJson<unknown>(response.text));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPLIT_CONCURRENCY, chunks.length) }, worker));
  return results.flat();
}

// ─── 题目校验（模型输出与 JSON 题库文件共用）───

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const isQuestionType = (v: unknown): v is QuestionType => typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);

function parseYear(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n > 1990 && n < 2100 ? n : null;
}

export function parseBankItems(raw: unknown): BankItemInput[] {
  const list = isDict(raw) ? raw.items : raw;
  if (!Array.isArray(list)) throw new Error('题库内容缺少 items 数组');
  return list.filter(isDict).flatMap((item): BankItemInput[] => {
    const stem = text(item.stem);
    if (!stem) return [];
    return [{
      stem,
      options: Array.isArray(item.options) ? item.options.map(text).filter((o): o is string => o !== null) : [],
      answer: text(item.answer), explanation: text(item.explanation),
      qtype: isQuestionType(item.qtype) ? item.qtype : null,
      company_name: text(item.company_name), role_title: text(item.role_title), year: parseYear(item.year),
    }];
  });
}
