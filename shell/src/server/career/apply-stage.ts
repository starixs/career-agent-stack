/**
 * 把填表引擎 / 备材料包发来的进度事件，换成界面画链路用的两样结构化数据：
 * 走到哪一环（stage）、这张表的格子填了多少（cells）。界面不再靠句子猜（shared/careerApplyStage.ts）。
 */
import { laterStage, type ApplyCells, type ApplyStage } from '../../shared/careerApplyStage';

type Ev = Record<string, unknown>;

/** 引擎进度的类别 → 链路上的一环。 */
const KIND_STAGE: Record<string, ApplyStage> = {
  resume: 'tailor', entry: 'open', jd: 'open', page: 'fill', field: 'fill', upload: 'fill', section: 'fill', blocker: 'fill', stop: 'review',
};

export function stageOfProgress(ev: Ev): ApplyStage | undefined {
  if (typeof ev.kind === 'string' && KIND_STAGE[ev.kind]) return KIND_STAGE[ev.kind];
  return ev.phase === 'navigate' ? 'open' : undefined;
}

/** 一趟填表里边填边数：每页找到几格（page 事件带 total）、动过哪几格（field 事件带 label）。 */
export class ApplyProgressTracker {
  stage: ApplyStage | undefined;
  private total = 0;
  private readonly touched = new Set<string>();
  /** 收尾时按引擎的逐格结果算出的准数；有了就以它为准。 */
  private final: ApplyCells | undefined;

  constructor(initial?: ApplyStage) { this.stage = initial; }

  add(ev: Ev): void {
    this.stage = laterStage(this.stage, stageOfProgress(ev));
    if (ev.kind === 'page' && typeof ev.total === 'number' && ev.total > 0) this.total += ev.total;
    if (ev.kind === 'field' && typeof ev.label === 'string' && ev.label) this.touched.add(ev.label);
  }

  /** 引擎收尾给的逐格结果：填好并核对过 / 页面原有值算填好，要他补的、草稿、没生效的算等他，选填留空和跳过的不算在内。 */
  settle(result: Ev | undefined): void {
    const fields = Array.isArray(result?.fields) ? result.fields.filter((f): f is Ev => !!f && typeof f === 'object') : [];
    if (!fields.length) return;
    const count = (...statuses: string[]) => fields.filter(f => statuses.includes(String(f.status))).length;
    const done = count('verified', 'unverified', 'prefilled');
    const you = count('needs_user', 'draft', 'mismatch');
    if (done + you > 0) this.final = { total: done + you, done, you };
  }

  cells(): ApplyCells | undefined {
    if (this.final) return this.final;
    return this.total > 0 ? { total: this.total, done: Math.min(this.touched.size, this.total), you: 0 } : undefined;
  }
}
