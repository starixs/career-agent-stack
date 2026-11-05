/**
 * 邮件起草器：跑在 Global 侧车（和批量运行器同一个启动位置，见 batch-service.ts resumeBatchIfRunning）。
 * 从库里取 kind='draft_mail' AND status='approved' 逐个写，同时最多 MAIL_DRAFT_CONCURRENCY 封。
 *  - 不占批量运行器的浏览器槽位，两边互不等待（写邮件只调模型、导 PDF）。
 *  - 怎么叫醒：库就是命令——Session 侧批准了 draft_mail 写进库，Global 每 MAIL_DRAFT_POLL_MS 轮询一次就接走；
 *    同进程（Global 里的路由 / 批量投）批准时 kickMailDrafter() 当场踢一下，不等轮询。
 *  - 侧车重启：卡在 executing 的 draft_mail 放回 approved 重写（写邮件不发信，重跑安全）；
 *    发信动作的启动清扫也在这里做（recoverInterruptedSends，batch-service 的 sweepOrphanedActions 不管邮件）。
 */
import { MAIL_SEND_INTERRUPTED_REASON, type ActionQueueItem, type Repos } from '@career/core';

/** 同时写几封：模型网关并发够用；一批几十封也不会一下子全打出去被限流。 */
export const MAIL_DRAFT_CONCURRENCY = 2;
/** 空闲时多久看一次库里有没有要写的（和批量命令轮询同一个节奏，批准后几秒内开写）。 */
export const MAIL_DRAFT_POLL_MS = 2000;

export interface MailDrafterDeps {
  repos: Repos;
  /** 写一封（draftMailForAction）；出错由起草器记日志，不让一封拖垮整轮。 */
  draft: (action: ActionQueueItem) => Promise<unknown>;
  concurrency?: number;
}

/**
 * 多久没动静的发信动作才算进程中断留下的：发一封信（SMTP / 云端代发，含附件）最多几十秒，
 * 5 分钟和填表清扫同一个新鲜度保护——刚批准、正在别的侧车里发的那封不会被误扫。
 */
export const STALE_SEND_MS = 5 * 60_000;

/**
 * 进程中断留下的发信动作（启动时扫一次）。绝不自动重发：
 *  - executing（发到一半进程没了，不知道发没发出去）→ failed，原因照实说；等你里「没发出去」，他决定要不要再发；
 *  - approved 却没在执行（批准后进程没了）→ 放回待审，让他再点一次发出。
 * 返回 { failed, reopened } 个数。
 */
export function recoverInterruptedSends(repos: Repos, nowMs = Date.now()): { failed: number; reopened: number } {
  const stale = (a: ActionQueueItem) => a.kind === 'send_mail' && nowMs - Date.parse(a.updated_at) >= STALE_SEND_MS;
  const executing = repos.listActions('executing').filter(stale);
  for (const a of executing) repos.setActionStatus(a.id, 'failed', { error: MAIL_SEND_INTERRUPTED_REASON });
  const reopened = repos.listActions('approved').filter(stale).filter(a => repos.reopenAction(a.id)).length;
  if (executing.length || reopened) console.log(`[career] mail-send recover failed=${executing.length} reopened=${reopened}`);
  return { failed: executing.length, reopened };
}

export class MailDrafter {
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly d: MailDrafterDeps) {}

  /** 侧车重启后：卡在 executing 的写邮件放回队列。返回放回的个数。 */
  recover(): number {
    const stuck = this.d.repos.listActions('executing').filter(a => a.kind === 'draft_mail' && !this.inFlight.has(a.id));
    const n = stuck.filter(a => this.d.repos.requeueAction(a.id)).length;
    if (n) console.log(`[career] mail-apply recover requeued=${n}`);
    recoverInterruptedSends(this.d.repos);
    return n;
  }

  /** 有空位就从库里接几封开始写；每写完一封再看一次。 */
  tick(): void {
    const free = (this.d.concurrency ?? MAIL_DRAFT_CONCURRENCY) - this.inFlight.size;
    if (free <= 0) return;
    const next = this.d.repos.listActions('approved').filter(a => a.kind === 'draft_mail' && !this.inFlight.has(a.id)).slice(0, free);
    for (const action of next) {
      const run = this.d.draft(action)
        .then(() => undefined, (error: unknown) => { console.error(`[career] mail-apply draft CRASHED action=${action.id}`, error instanceof Error ? error.message : error); })
        .finally(() => { this.inFlight.delete(action.id); this.tick(); });
      this.inFlight.set(action.id, run);
    }
  }

  /** 写到队列空、手上也没有在写的为止（测试与一次性调用用）。 */
  async drain(): Promise<void> {
    this.tick();
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight.values()]);
      this.tick();
    }
  }

  start(intervalMs = MAIL_DRAFT_POLL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let installed: MailDrafter | null = null;

/** Global 侧车装好起草器后登记；测试可传 null 卸下。 */
export function installMailDrafter(drafter: MailDrafter | null): void {
  installed?.stop();
  installed = drafter;
}

/** 批准了 draft_mail：同进程有起草器就当场踢一下；没有（Session 侧车）就等 Global 的轮询接走。 */
export function kickMailDrafter(): void {
  installed?.tick();
}
