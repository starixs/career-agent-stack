/**
 * 下一步条要的状态（plan-r2 §B.2）：全部本地查询，一个函数 `suggestStateOf` 读出（suggest-context.ts）。
 * 规则层（suggest-seeds.ts）只读这一份，模型看到的是它去掉 id 的精简版。
 */
import type { AskKind, AskMailFailed, AskMailPurpose, InterviewRound } from '@career/core';

import type { MainlineStage } from '../../shared/careerRail';
import type { BatchStatus } from './batch-runner';

export interface SuggestAsk {
  id: string;
  kind: AskKind;
  title: string;
  /** 涉及的公司（原名，最多 3 家）。 */
  companies: string[];
  /** 这件事挡住几份申请。 */
  count: number;
  /** 发邮件前过目那件：用途、几封、是不是退信重发（建议条只打开卡组，不从这里直接发）。 */
  mail?: { purpose: AskMailPurpose; count: number; bounced: boolean };
  /** 邮件没写成 / 没发出去那件。 */
  mail_failed?: AskMailFailed;
}

/** 对话底部还在等他的那张卡。 */
export interface SuggestCard {
  id: string;
  kind: string;
  /** 勾选表：默认勾上的公司（最多 3 家）与岗位 id。 */
  picked: string[];
  pickedIds: string[];
  /** 勾选表：表里所有岗位 id（"全投"用）。 */
  allIds: string[];
  /** 表外还能投的家数。 */
  more: number;
  /** 面试准备卡等带公司的卡：公司名。 */
  company: string | null;
}

export interface SuggestBatch {
  status: BatchStatus;
  /** 正在填的公司。 */
  running: string[];
  /** 正在填的第一份对应的申请 id（"把它给我看看"用）。 */
  runningAppId: string | null;
  done: number;
  queued: number;
}

export interface SuggestHeld {
  /** 填好了停在提交前的份数。 */
  count: number;
  companies: string[];
  /** 一键投出那件事的 id（等你卡组的主动作）。 */
  askId: string | null;
}

export interface SuggestJob {
  job_id: string;
  company: string;
  known: boolean;
  /** 岗位名（给模型点名用；旧夹具可缺）。 */
  title?: string;
}

export interface SuggestPool {
  /** 现在就能开始投的家数（表内 + 表外）。 */
  fits: number;
  /** 没截止的岗位总数。 */
  total: number;
  /** 能投的里面是外包 / 派遣的家数。 */
  outsourced: number;
}

export interface SuggestPrefs { keywords: string[]; cities: string[]; cohort: string | null }

export interface SuggestResume { has: boolean; name: string | null; tailored: number; experiences: number }

export interface SuggestTailor { card_id: string; company: string; job_id: string; tailored_id: string; changes: number }

export interface SuggestState {
  stage: MainlineStage;
  asks: SuggestAsk[];
  openCard: SuggestCard | null;
  batch: SuggestBatch | null;
  held: SuggestHeld;
  /** 方向内现在就能投的前几家。 */
  nextJobs: SuggestJob[];
  pool: SuggestPool;
  prefs: SuggestPrefs;
  resume: SuggestResume;
  mailConnected: boolean;
  phoneLinked: boolean;
  lastTailor: SuggestTailor | null;
  /** 今天投出几份。 */
  todaySent: number;
  /** 离他上一次说话过了几小时；没说过为 null。 */
  awayHours: number | null;
  /** 本地钟点（0–23）。 */
  hour: number;
  interview: SuggestInterview | null;
  dueSoon: SuggestDue[];
  /** 近 7 天拒信数。 */
  rejections7d: number;
  /** choice / unsure / confirm 等你事的选项原文（askId → 选项）。 */
  askOptions: Record<string, string[]>;
  /** 猜他是哪一届（下半年按明年届，上半年按今年届；只用在可改的填空里）。 */
  cohortGuess: number;
}

/** 经历访谈进度（kv `experience:interview`）。只有 rounds[current_round] 是 in_progress 才算在访谈里（旧 kv 可能残留）。 */
export interface SuggestInterview {
  round: InterviewRound | null;
  inProgress: boolean;
  experienceTitle: string | null;
  followUps: string[];
  roundsTodo: InterviewRound[];
}

/** 3 天内的截止（笔试 / 测评 / 面试 …）。 */
export interface SuggestDue {
  kind: string;
  company: string;
  at: string;
  /** 离截止还有几天（按自然日，今天 = 0；给模型说"后天笔试"用）。 */
  daysLeft?: number;
}

/** 旧名：路由里按这个名字传进 buildSuggestions。 */
export type SuggestContext = SuggestState;
