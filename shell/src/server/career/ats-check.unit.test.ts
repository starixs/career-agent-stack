import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAtsCheck } from './ats-check';
import { loadCore } from './core-module';
import { isAtsMode, setAtsMode } from './export';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

// 过机筛：ATS 版真实渲染 → pdf.js 抽文字 → 对照内容。

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-ats-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('过机筛自检', () => {
  it('ATS 版 PDF 能抽出姓名、联系方式与经历，顺序正确', async () => {
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, await loadCore());
    const schema = {
      basics: { name: '李四', phone: '{{vault:profile.phone}}', email: 'lisi@example.com', city: '北京' },
      experience: [{ org: '某咨询公司', position: '分析实习生', start: '2025.07', end: '2025.09', bullets: ['完成 3 份行业研究报告，覆盖 40 家公司', '搭建 Excel 估值模型'] }],
      projects: [{ name: '校园二手平台调研', bullets: ['访谈 30 名用户并整理需求'] }],
    };
    const m = store.createResumeMaster({ name: '通用版', schema_json: schema });
    setAtsMode(repos, m.id, true);
    expect(isAtsMode(repos, m.id)).toBe(true);
    const mod = await import('@career/resume');
    const resolve = (s: unknown) => JSON.parse(JSON.stringify(s).replace('{{vault:profile.phone}}', '13900000000'));
    const exportPdf = async (id: string) => {
      const r = mod.parseResume(resolve(JSON.parse(store.getResume(id)!.row.schema_json)));
      const p = join(dir, `${id}.pdf`);
      writeFileSync(p, await mod.renderPdf(r, { ats: true }));
      return p;
    };
    const report = await runAtsCheck({ store, exportPdf, resolve }, m.id);
    expect(report.extracted_chars).toBeGreaterThan(30);
    expect(report.issues.filter(i => i.level === 'error')).toEqual([]);
    expect(report.issues.map(i => i.code)).not.toContain('phone');
    expect(report.issues.map(i => i.code)).not.toContain('order');
    expect(report.ok).toBe(true);
  }, 60_000);
});
