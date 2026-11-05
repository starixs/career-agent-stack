/**
 * 右栏读模型的形状（主线体验 §6.1a）：服务端 career/rail.ts 产出，渲染端 CompanionPanel 读。
 * 信任账本的条目形状也在这里，两边共用一份。
 */
export type TrustState = 'new' | 'shown' | 'delegated';
export type TrustKind = 'system' | 'target';
export interface TrustEntry { key: string; kind: TrustKind; label: string; state: TrustState; successes: number; updated_at: string }

export type MainlineStage = 'profile' | 'direction' | 'first' | 'batch' | 'released';
/** 主线的五步，按先后。 */
export const MAINLINE_STAGE_ORDER: readonly MainlineStage[] = ['profile', 'direction', 'first', 'batch', 'released'];

export type BlockId = 'resume' | 'tailor' | 'apply' | 'mail';
export type BlockStatus = 'working' | 'waiting' | 'done' | 'idle';
export interface RailBlock { id: BlockId; label: string; status: BlockStatus; line: string }
/**
 * 回执里这份交出去用的简历：resume 是主简历名（定制版也记它出自哪份主简历），resume_kind 说是不是按岗位改过的，
 * changes 是定制版相对主简历改了几处（主简历为 null）。
 */
export interface RailReceipt { application_id: string; company: string; title: string; at: string; resume: string | null; resume_kind?: 'tailored' | 'master' | null; changes?: number | null; filled: number | null }
export interface RailWaiting { count: number; first: { title: string; detail: string | null } | null }
/** 岗位池收窄（§6.5）：他说一句偏好，符合的数当场变；每个条件一枚小签。 */
export interface RailPool { total: number; fits: number; conditions: string[] }
export interface RailSnapshot {
  stage: MainlineStage;
  blocks: RailBlock[];
  waiting: RailWaiting;
  receipts: RailReceipt[];
  learned: Array<TrustEntry & { propose: boolean }>;
  today: { prepared: number; sent: number; waiting: number };
  pool: RailPool;
}


/**
 * 一个岗位投的时候用哪份简历（立场 3 说实话：没拿到岗位描述就用主简历，并如实标出，不做假定制）。
 *  - tailored：这个岗位已经有定制版（changes = 相对主简历改了几处）
 *  - will_tailor：有真的岗位描述、还没定制，投之前会按它改一版
 *  - no_jd：没拿到岗位描述，用主简历
 *  - master：本来要定制、但没定制成（超时 / 出错），退回主简历——只出现在材料包记录里
 * resume_id / name 是要用的那份（定制版的 name 是它出自的主简历名）；有好几份主简历又没选时为 null。
 */
export type ResumePlanKind = 'tailored' | 'master' | 'will_tailor' | 'no_jd';
export interface ResumePlan { kind: ResumePlanKind; resume_id: string | null; name: string | null; changes: number | null }
