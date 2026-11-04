// 只校验配置，不启动浏览器、不连接手机/邮箱、不发码。
// node --import tsx/esm scripts/career-verification-check.mjs [verification.json]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { careerDataDir } from '../src/server/career/db.ts';
import { verificationConfigSchema } from '../src/server/career/verification-config.ts';

const file = process.argv[2] ?? join(careerDataDir(), 'verification.json');
try {
  const parsed = verificationConfigSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) {
    console.error('配置无效：', parsed.error.issues.map(i => ({ field: i.path.join('.'), code: i.code })));
    process.exitCode = 1;
  } else {
    const config = parsed.data;
    const overlapping = config.templates.some((a, i) => config.templates.some((b, j) => j > i && a.origin === b.origin && (a.pathPrefix.startsWith(b.pathPrefix) || b.pathPrefix.startsWith(a.pathPrefix))));
    console.log({ enabled: config.enabled, captcha: config.captcha, templates: config.templates.map(t => ({ id: t.id, origin: t.origin, channel: t.channel })), overlapping });
    if (overlapping) { console.error('同一 origin 的模板路径有重叠，运行时会交回人工；请收窄 pathPrefix。'); process.exitCode = 1; }
    else console.log('配置格式通过；这不代表手机/邮箱连接或站点端到端验收通过。');
  }
} catch {
  console.error(`无法读取或解析配置：${file}`);
  process.exitCode = 1;
}
