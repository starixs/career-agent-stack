import { randomBytes } from 'node:crypto'
/** 短 ID：前缀 + 12 位 base36，便于日志与 URL。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12)}`
}
