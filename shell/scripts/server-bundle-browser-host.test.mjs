import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`release Sidecar exited before health:\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The release Sidecar has not bound its loopback port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`release Sidecar did not become healthy:\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("the release Sidecar loads the extension host without any Playwright runtime", async () => {
  const build = spawnSync(
    process.execPath,
    ["scripts/esbuild-bundle.mjs", "server"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const releaseRoot = mkdtempSync(join(tmpdir(), "keystone-browser-release-"));
  const resourcesDir = join(releaseRoot, "Resources");
  const packagedNodeModules = join(resourcesDir, "node_modules");
  mkdirSync(resourcesDir, { recursive: true });
  cpSync(
    join(repoRoot, "src-tauri", "resources", "server-dist.js"),
    join(resourcesDir, "server-dist.js"),
  );

  // Stage the actual eager domain imports (no Playwright, no symlinks to it).
  for (const name of ['core', 'captcha']) {
    const from = resolve(repoRoot, '..', 'packages', name);
    const to = join(packagedNodeModules, '@career', name);
    mkdirSync(to, { recursive: true });
    cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true });
    cpSync(join(from, 'package.json'), join(to, 'package.json'));
  }
  cpSync(resolve(repoRoot, '..', 'packages/core/node_modules/zod'), join(packagedNodeModules, 'zod'), { recursive: true, dereference: true });
  const port = await reservePort();
  const homeDir = join(releaseRoot, "home");
  const agentDir = join(homeDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      join(resourcesDir, "server-dist.js"),
      "--agent-dir",
      agentDir,
      "--port",
      String(port),
      "--sidecar-role",
      "global",
      "--no-pre-warm",
    ],
    {
      cwd: resourcesDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        KEYSTONE_SIDECAR_ID: "__global__",
        CAREER_BROWSER_EXTENSION_BRIDGE: '0',
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const output = () => `${stdout}\n${stderr}`;

  try {
    await waitForHealth(port, child, output);
    const browser = await fetch(`http://127.0.0.1:${port}/api/career/browser/state`);
    assert.equal(browser.status, 401, output());
    assert.equal((await browser.json()).code, 'BROWSER_CAPABILITY_REQUIRED', output());
    const response = await fetch(`http://127.0.0.1:${port}/mcp/playwright`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(response.status, 410, output());
    const body = JSON.parse(await response.text());
    assert.equal(
      body.code,
      "BROWSER_MCP_RETIRED",
      output(),
    );
  } finally {
    await stopChild(child);
    rmSync(releaseRoot, { recursive: true, force: true });
  }
});
