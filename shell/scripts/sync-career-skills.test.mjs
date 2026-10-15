import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RETIRED_SKILLS, syncCareerSkills } from './sync-career-skills.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'career-skills-sync-'));
  try {
    run(join(root, 'skills'), join(root, 'dest'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function skill(dir, name, body = name) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), body);
}

test('copies skills and prunes retired leftovers, keeping hand-added dirs', () => fixture((src, dest) => {
  skill(src, 'greeting', 'new');
  mkdirSync(join(src, 'not-a-skill'), { recursive: true });
  skill(dest, 'greeting', 'old');
  skill(dest, 'memory-extract');
  skill(dest, 'memory-consolidate');
  skill(dest, 'hand-added');

  const result = syncCareerSkills(src, dest);

  assert.deepEqual(result, { synced: ['greeting'], pruned: ['memory-consolidate', 'memory-extract'] });
  assert.equal(readFileSync(join(dest, 'greeting', 'SKILL.md'), 'utf8'), 'new');
  assert.equal(existsSync(join(dest, 'memory-extract')), false);
  assert.equal(existsSync(join(dest, 'memory-consolidate')), false);
  assert.equal(existsSync(join(dest, 'hand-added', 'SKILL.md')), true);
  assert.equal(existsSync(join(dest, 'not-a-skill')), false);
}));

test('a retired name that comes back in the source is synced, not pruned', () => fixture((src, dest) => {
  skill(src, RETIRED_SKILLS[0], 'revived');
  const result = syncCareerSkills(src, dest);
  assert.deepEqual(result?.pruned, []);
  assert.equal(readFileSync(join(dest, RETIRED_SKILLS[0], 'SKILL.md'), 'utf8'), 'revived');
}));

test('missing source is a no-op', () => fixture((src, dest) => {
  assert.equal(syncCareerSkills(src, dest), null);
  assert.equal(existsSync(dest), false);
}));
