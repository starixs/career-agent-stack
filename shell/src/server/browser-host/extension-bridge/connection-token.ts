import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** Installation-scoped secret, not a per-Sidecar token cached by an MV3 worker. */
export function productConnectionToken(dataDir: string): string {
  const dir = join(dataDir, 'browser-extension')
  const file = join(dir, 'connection-token')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    // Existing installation: reuse its secret; never print or silently rotate it.
  }
  chmodSync(file, 0o600)
  return z.string().regex(/^[a-f0-9]{64}$/).parse(readFileSync(file, 'utf8'))
}
