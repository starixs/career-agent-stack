#!/usr/bin/env node
/**
 * 从 hanzi-writer-data（Make Me a Hanzi 的笔画中轴线，Arphic Public License）里
 * 只抽出内置语句用到的汉字，把中轴折线平滑成钢笔笔迹曲线并算好长度，生成 renderer 用的 strokes.json。
 * 不带笔画轮廓：笔迹不按楷体字形裁剪，看起来是手写而不是字体。
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

// 平滑后的曲线按这个步数采样求长度，误差远小于一个像素。
const LENGTH_SAMPLES = 16;

/** 中轴线是折线，钢笔笔迹要顺：用 Catmull-Rom 转成三次贝塞尔，每段为 [起点, 控制点 1, 控制点 2, 终点]。 */
function smoothSegments(points) {
  return points.slice(0, -1).map((p1, i) => {
    const p0 = points[i - 1] ?? p1;
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    return [p1, c1, c2, p2];
  });
}

function bezierAt([a, b, c, d], t) {
  const u = 1 - t;
  return [0, 1].map(k => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]);
}

function segmentLength(seg) {
  let total = 0;
  let prev = seg[0];
  for (let i = 1; i <= LENGTH_SAMPLES; i += 1) {
    const next = bezierAt(seg, i / LENGTH_SAMPLES);
    total += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
    prev = next;
  }
  return total;
}

const r = n => Math.round(n);

function smoothMedian(points) {
  if (points.length < 2) return [`M${r(points[0][0])} ${r(points[0][1])}`, 0];
  const segs = smoothSegments(points);
  const d = `M${r(points[0][0])} ${r(points[0][1])}` + segs.map(([, c1, c2, p2]) => `C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`).join('');
  return [d, r(segs.reduce((sum, seg) => sum + segmentLength(seg), 0))];
}

function readChar(dataDir, ch) {
  const file = join(dataDir, `${ch}.json`);
  if (!existsSync(file)) throw new Error(`[handwriting] no stroke data for "${ch}" in ${dataDir}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return { m: raw.medians.map(smoothMedian) };
}

const dataDir = process.argv[2] ?? fetchDataDir();
const quotes = JSON.parse(readFileSync(join(DIR, 'quotes.json'), 'utf8'));
const chars = [...new Set(quotes.flatMap(q => [...q.text]).filter(ch => CJK.test(ch)))].sort();
const out = Object.fromEntries(chars.map(ch => [ch, readChar(dataDir, ch)]));
writeFileSync(join(DIR, 'strokes.json'), `${JSON.stringify(out)}\n`);
console.log(`[handwriting] wrote ${chars.length} characters from hanzi-writer-data@${HANZI_DATA_VERSION}`);
