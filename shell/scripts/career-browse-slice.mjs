// 浏览器面切面矩阵（2026-10-30）：一批真实网址，每个同时走两层——直取（career/web-fetch.ts）和托管浏览器（career/browse.ts）——
// 记下哪一层够用、卡在哪（登录 / 验证码 / 反爬）、是哪种验证码。外网，不进默认测试；站点会变，结果只当当天的切面。
// 运行：cd app/shell && node --import tsx/esm scripts/career-browse-slice.mjs [--headed] [--only=link,login,search,company,file] [--out=<dir>]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browse = await import('../src/server/career/browse.ts');
const { fetchPage } = await import('../src/server/career/web-fetch.ts');
const { isSubmitText, classifyCaptcha } = await import('@career/apply');

const q = encodeURIComponent;
/** [类别, 名字, 网址, 期待「读到」的字（可选；用来判断浏览器层是否真读到了主体）] */
const SCENARIOS = [
  ['link', '字节校招列表', 'https://jobs.bytedance.com/campus/position', '职位 ID'],
  ['link', '腾讯校招岗位', 'https://join.qq.com/post.html', '个岗位'],
  ['link', '美团校招', 'https://zhaopin.meituan.com/web/campus', '校招职位'],
  ['link', '阿里校招', 'https://talent.alibaba.com/campus/home', '校园'],
  ['link', '百度校招岗位', 'https://talent.baidu.com/jobs/list', '职位'],
  ['link', '华为校招', 'https://career.huawei.com/reccampportal/portal5/campus-recruitment.html', '华为'],
  ['link', '快手校招', 'https://campus.kuaishou.cn/', '快手'],
  ['link', '米哈游招聘', 'https://jobs.mihoyo.com/', '米哈游'],
  ['link', '牛客讨论区', 'https://www.nowcoder.com/discuss', ''],
  ['link', '北大就业网', 'https://scc.pku.edu.cn/', '就业'],
  ['link', '清华就业网', 'https://career.tsinghua.edu.cn/', '就业'],
  ['link', 'B 站搜面经', `https://search.bilibili.com/all?keyword=${q('秋招面经 后端')}`, '面经'],
  ['login', 'Boss 直聘搜岗位', `https://www.zhipin.com/web/geek/job?query=${q('后端开发')}&city=101010100`, '后端'],
  ['login', '猎聘', 'https://www.liepin.com/', ''],
  ['login', '脉脉', 'https://maimai.cn/', ''],
  ['login', '知乎搜索', `https://www.zhihu.com/search?type=content&q=${q('秋招 笔试')}`, ''],
  ['login', '牛客校招中心', 'https://www.nowcoder.com/jobs/school/center', ''],
  ['search', '必应', `https://cn.bing.com/search?q=${q('拼多多 2027 秋招 笔试时间')}`, '拼多多'],
  ['search', '百度', `https://www.baidu.com/s?wd=${q('拼多多 2027 秋招 笔试时间')}`, '拼多多'],
  ['search', '360 搜索', `https://www.so.com/s?q=${q('拼多多 2027 秋招 笔试时间')}`, '拼多多'],
  ['search', '搜狗', `https://www.sogou.com/web?query=${q('拼多多 2027 秋招 笔试时间')}`, '拼多多'],
  ['search', '搜狗微信', `https://weixin.sogou.com/weixin?type=2&query=${q('美团 校招 宣讲会')}`, '美团'],
  ['company', '百度百科·米哈游', `https://baike.baidu.com/item/${q('米哈游')}`, '上海'],
  ['company', '米哈游官网', 'https://www.mihoyo.com/', ''],
  ['company', '天眼查', `https://www.tianyancha.com/search?key=${q('米哈游')}`, '米哈游'],
  ['company', '企查查', `https://www.qcc.com/web/search?key=${q('米哈游')}`, '米哈游'],
  ['company', '36 氪搜索', `https://36kr.com/search/articles/${q('米哈游')}`, '米哈游'],
  ['company', '看准网', 'https://www.kanzhun.com/', ''],
  ['file', 'PDF 文件', 'https://arxiv.org/pdf/1706.03762', 'Attention'],
];

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only')?.split(',');
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed'), args: ['--disable-blink-features=AutomationControlled'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'zh-CN' });
const deps = { isSubmitText, pacingMs: [0, 0] };

async function viaBrowser(url, expect) {
  const page = await context.newPage();
  const t0 = Date.now();
  try {
    const rc = await browse.act(context, page, { action: 'navigate', url }, deps);
    const ob = await browse.observe(context, rc.page, deps, { textMax: 6000 });
    const read = await browse.read(rc.page, 0, 200_000);
    const captcha = ob.hints.includes('captcha') ? classifyCaptcha({ title: ob.title, text: read.text.slice(0, 3000) }) : null;
    return { ok: rc.ok, ms: Date.now() - t0, final_url: ob.url.slice(0, 120), text_total: ob.text_total, hints: ob.hints, captcha, hit: expect ? read.text.includes(expect) : null, head: read.text.replace(/\s+/g, ' ').slice(0, 160) };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, error: String(error).slice(0, 160) };
  } finally {
    await page.close().catch(e => console.warn(`[slice] close failed: ${e}`));
  }
}

const rows = [];
for (const [cat, name, url, expect] of SCENARIOS) {
  if (only && !only.includes(cat)) continue;
  const fetched = await fetchPage(url);
  const fetchHit = expect ? fetched.text.includes(expect) : null;
  const viaB = await viaBrowser(url, expect);
  // 哪一层够用：直取 ok 且读到期待的字 → 直取；否则浏览器读到 → 浏览器；浏览器标了登录 / 验证码 → 要人或要过验证码
  const tier = fetched.verdict === 'ok' && fetchHit !== false ? '直取'
    : viaB.hints?.includes('captcha') || viaB.hints?.includes('risk') ? `验证码:${viaB.captcha ?? '?'}`
      : viaB.hints?.includes('login') && !viaB.hit ? '登录'
        : viaB.ok && viaB.hit !== false && viaB.text_total > 300 ? '浏览器' : '没读到';
  const row = { cat, name, url, tier, fetch: { verdict: fetched.verdict, status: fetched.status, text_total: fetched.text_total, hit: fetchHit }, browser: viaB };
  rows.push(row);
  console.log(`${cat.padEnd(8)} ${name.padEnd(14)} ${tier.padEnd(14)} 直取=${fetched.verdict}/${fetched.status ?? '-'}/${fetched.text_total}字${fetchHit === null ? '' : fetchHit ? '✓' : '✗'}  浏览器=${viaB.text_total ?? '-'}字${viaB.hit === null || viaB.hit === undefined ? '' : viaB.hit ? '✓' : '✗'} ${viaB.hints?.join('|') ?? viaB.error ?? ''} ${viaB.ms}ms`);
}
await browser.close();
const outDir = arg('out') ?? tmpdir();
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `browse-slice-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(rows, null, 1));
const count = t => rows.filter(r => r.tier.startsWith(t)).length;
console.log(`\n合计 ${rows.length}：直取 ${count('直取')} · 浏览器 ${count('浏览器')} · 登录 ${count('登录')} · 验证码 ${count('验证码')} · 没读到 ${count('没读到')}\n结果：${file}`);
