/**
 * 主线进度一行（每轮用户说话时注入，UserPromptSubmit）。
 *
 * 为什么：小芽不知道主线（建档 → 方向 → 定制 → 投出 → 等你）走到哪，每轮要先调两三个读工具摸底，
 * 或者干脆反问他（10-10 实例：「生成简历」先出两问）；上下文被压缩后连"刚开始在填哪几家"都会忘。
 * 一行事实就够它决定下一步：缺简历就去收简历，有方向没投就去投，在填就报进度。
 * 这一行只给模型做判断，不让它复述给用户；放在消息尾部，不影响系统提示的缓存前缀。
 */
import type { Repos } from '@career/core';
import { buildAsks } from '@career/core';

import { BATCH_STATE_KEY, type BatchState } from './batch-runner';
import { getJobPrefs } from './job-board';
import { receipts } from './rail';

/** 「近期投出」的窗口：和 today_queue 的 sent_recent 一致。 */
const SENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 投出公司名最多列几家，多了只报数。 */
const SENT_NAMES_MAX = 3;

export interface MainlineFacts {
  experiences: number;
  masterResumes: number;
  direction: string | null;
  sentCompanies: string[];
  filling: number;
  queued: number;
  asks: number;
}

/** 纯函数：把事实拼成一行。 */
export function formatMainlineState(f: MainlineFacts): string {
  const sent = f.sentCompanies.length
    ? `近24小时投出 ${f.sentCompanies.length} 家（${f.sentCompanies.slice(0, SENT_NAMES_MAX).join('、')}${f.sentCompanies.length > SENT_NAMES_MAX ? '等' : ''}）`
    : '近24小时没有投出';
  const background = f.filling || f.queued ? `后台在填 ${f.filling} 家、排队 ${f.queued} 家` : '后台没有在填';
  const parts = [
    `经历 ${f.experiences} 段`,
    `主简历 ${f.masterResumes} 份`,
    f.direction ? `方向 ${f.direction}` : '方向未定',
    sent,
    background,
    `等他处理 ${f.asks} 件`,
  ];
  return `〔现在的进度〕${parts.join(' · ')}。只用来决定下一步，不要复述给他。`;
}

function directionOf(repos: Repos): string | null {
  const prefs = getJobPrefs(repos);
  const words = [...(prefs.keywords ?? []), ...(prefs.cities ?? [])].filter(Boolean);
  return words.length ? words.slice(0, 4).join('/') : null;
}

/** 从库里读事实。 */
export function readMainlineFacts(repos: Repos, nowIso: string): MainlineFacts {
  const since = new Date(Date.parse(nowIso) - SENT_WINDOW_MS).toISOString();
  const batch = repos.kvGet<BatchState>(BATCH_STATE_KEY);
  const masters = repos.db.get<{ n: number }>('SELECT count(*) AS n FROM resume_master')?.n ?? 0;
  return {
    experiences: repos.listExperiences().length,
    masterResumes: masters,
    direction: directionOf(repos),
    sentCompanies: [...new Set(receipts(repos).filter(r => r.at >= since).map(r => r.company))],
    filling: batch?.running?.length ?? (batch?.currentActionId ? 1 : 0),
    queued: batch?.queued ?? 0,
    asks: buildAsks(repos, nowIso).length,
  };
}
