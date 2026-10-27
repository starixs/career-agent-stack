#!/usr/bin/env node
/**
 * 从 hanzi-writer-data（Make Me a Hanzi 的楷体笔画轮廓 + 中轴线，Arphic Public License）里
 * 只抽出内置语句用到的汉字，生成 renderer 用的 strokes.json，让手写动画离线可用、体积可控。
 *
 * 用法：node scripts/build-handwriting-strokes.mjs [hanzi-writer-data 的 data 目录]
 * 不给目录时 npm pack 固定版本到临时目录再读。改了 quotes.json 后重跑一次。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 钉死版本：笔画数据换版本会改字形，要有意识地升级。
const HANZI_DATA_VERSION = '2.0.1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src/renderer/components/career/handwriting');
const CJK = /[㐀-鿿]/u;

function fetchDataDir() {
  const work = mkdtempSync(join(tmpdir(), 'hanzi-writer-data-'));
  execFileSync('npm', ['pack', `hanzi-writer-data@${HANZI_DATA_VERSION}`, '--silent'], { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
  execFileSync('tar', ['xzf', `hanzi-writer-data-${HANZI_DATA_VERSION}.tgz`], { cwd: work });
  return join(work, 'package');
}

function medianPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join('');
}

function medianLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return Math.round(total);
}

function readChar(dataDir, ch) {
  const file = join(dataDir, `${ch}.json`);
  if (!existsSync(file)) throw new Error(`[handwriting] no stroke data for "${ch}" in ${dataDir}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return { s: raw.strokes, m: raw.medians.map(points => [medianPath(points), medianLength(points)]) };
}

const dataDir = process.argv[2] ?? fetchDataDir();
const quotes = JSON.parse(readFileSync(join(DIR, 'quotes.json'), 'utf8'));
const chars = [...new Set(quotes.flatMap(q => [...q.text]).filter(ch => CJK.test(ch)))].sort();
const out = Object.fromEntries(chars.map(ch => [ch, readChar(dataDir, ch)]));
writeFileSync(join(DIR, 'strokes.json'), `${JSON.stringify(out)}\n`);
console.log(`[handwriting] wrote ${chars.length} characters from hanzi-writer-data@${HANZI_DATA_VERSION}`);
