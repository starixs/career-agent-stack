import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The `career` builtin MCP is context-injected into every Session, so any
// unit test that builds the SDK MCP map lazily opens the career SQLite via
// `careerDataDir()`. Without this, parallel vitest forks would all open (and
// migrate) the developer's real `~/.keystone/career/career.sqlite`, racing on
// WAL locks and polluting user data. Give each test file its own scratch dir.
if (!process.env.CAREER_DATA_DIR?.trim()) {
  process.env.CAREER_DATA_DIR = mkdtempSync(join(tmpdir(), 'keystone-career-unit-'));
}
