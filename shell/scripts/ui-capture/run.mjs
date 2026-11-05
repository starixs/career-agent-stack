#!/usr/bin/env node
/**
 * 一条命令重截全部页面：新建临时数据目录 → 种演示数据 → 起 Global 侧车(:3000) 和 vite(:5175) → 截图 → 停掉两个服务。
 *
 *   node scripts/ui-capture/run.mjs [--data <临时目录>] [--out <截图目录>] [--only today,apply]
 *
 * 数据只进 --data（CAREER_DATA_DIR / KEYSTONE_CONFIG_DIR / KEYSTONE_REFS_DIR 都指过去），不写仓库。
 * 3000 / 5175 被占用时直接退出（vite 代理目标写死在 vite.config.ts 的 3000），不去杀别人的进程。
 */
import { spawn, spawnSync } from 'child_process';
import { mkdirSync, openSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = join(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const DATA = opt('data') ?? join(tmpdir(), 'career-ui-home');
const OUT = opt('out') ?? join(tmpdir(), 'career-ui-shots');
const PORTS = { sidecar: 3000, vite: 5175 };
/** 侧车冷启动（tsx 编译 + 读 PATH）实测十几秒，给足一分半。 */
const READY_TIMEOUT_MS = 90_000;

function portBusy(port) {
  return spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim().length > 0;
}

async function waitFor(url, label) {
  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* 还没起来，继续等 */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`[ui-capture] ${label} 在 ${READY_TIMEOUT_MS / 1000}s 内没起来（${url}），日志见 ${DATA}/*.log`);
}

function start(label, cmd, args, env) {
  const log = openSync(join(DATA, `${label}.log`), 'w');
  const child = spawn(cmd, args, { cwd: SHELL, env: { ...process.env, ...env }, stdio: ['ignore', log, log], detached: true });
  console.log(`[ui-capture] ${label} pid=${child.pid}`);
  return child;
}

function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { console.warn(`[ui-capture] 停止 pid=${child.pid} 失败：${error.message}`); }
}

for (const [label, port] of Object.entries(PORTS)) {
  if (portBusy(port)) { console.error(`[ui-capture] 端口 ${port}（${label}）已被占用，先停掉占用的进程再跑`); process.exit(2); }
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(join(DATA, 'agent'), { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.png') || f === 'index.md') rmSync(join(OUT, f));

const env = { CAREER_DATA_DIR: join(DATA, 'career'), KEYSTONE_CONFIG_DIR: join(DATA, 'keystone'), KEYSTONE_REFS_DIR: join(DATA, 'refs') };
const node = process.execPath;
const seeded = spawnSync(node, ['--import', 'tsx/esm', join(HERE, 'seed.mjs')], { cwd: SHELL, env: { ...process.env, ...env }, stdio: 'inherit' });
if (seeded.status !== 0) process.exit(seeded.status ?? 1);

const children = [];
const cleanup = () => children.forEach(stop);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
try {
  children.push(start('sidecar', node, ['--import', 'tsx/esm', 'src/server/index.ts', '--port', String(PORTS.sidecar), '--sidecar-role', 'global', '--agent-dir', join(DATA, 'agent')], env));
  children.push(start('vite', join(SHELL, 'node_modules', '.bin', 'vite'), ['--port', String(PORTS.vite), '--strictPort', '--force'], {}));
  await waitFor(`http://localhost:${PORTS.sidecar}/api/career/asks`, 'sidecar');
  await waitFor(`http://localhost:${PORTS.vite}/`, 'vite');
  const only = opt('only') ? ['--only', opt('only')] : [];
  const cap = spawnSync(node, [join(HERE, 'capture.mjs'), '--out', OUT, '--base', `http://localhost:${PORTS.vite}/`, ...only], { cwd: SHELL, stdio: 'inherit' });
  process.exitCode = cap.status ?? 1;
} finally {
  cleanup();
}
