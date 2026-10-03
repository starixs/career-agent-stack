/**
 * 聊天旁抽屉（浏览器现场 / 简历在线编辑）共用的约定：同一时间只开一个。
 * 任一抽屉打开时发 DRAWER_OPENED_EVENT {name}，其它抽屉收到不同 name 就收起。
 */
export const DRAWER_OPENED_EVENT = 'career:drawer-opened';
export type CareerDrawerName = 'live' | 'resume';
