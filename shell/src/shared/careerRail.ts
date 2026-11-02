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
export interface RailBlock { id: BlockId; label: string; status: BlockStatus; line: string; done?: number; total?: number }
export interface RailReceipt { application_id: string; company: string; title: string; at: string; resume: string | null; filled: number | null }
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

