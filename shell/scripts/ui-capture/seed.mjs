#!/usr/bin/env node
/**
 * UI 截图用的演示数据：一个秋招中段的学生（虚构「林同学」）。
 *
 * 只往 $CAREER_DATA_DIR/career.sqlite 里写（必须指向一个临时目录），不碰仓库。
 * 运行（在 app/shell 下）：CAREER_DATA_DIR=<fresh>/career node --import tsx/esm scripts/ui-capture/seed.mjs
 * 走的是侧车自己的路由（handleCareerRoute，进程内调用）和 @career/core 的 Repos，与产品写入路径一致。
 */
const DATA_DIR = process.env.CAREER_DATA_DIR ?? '';
if (!/tmp|ui-home|\/T\//.test(DATA_DIR)) {
  console.error(`[seed] 拒绝写入：CAREER_DATA_DIR=${DATA_DIR || '(未设)'} 必须指向一个临时目录`);
  process.exit(2);
}

const { handleCareerRoute } = await import('../../src/server/routes/career.ts');
const { getRepos } = await import('../../src/server/career/db.ts');
const { CareerStore } = await import('../../src/server/career/store.ts');
const { loadCore } = await import('../../src/server/career/core-module.ts');
const { setTargetJob } = await import('../../src/server/career/targets.ts');

const core = await loadCore();
const repos = await getRepos();
const store = new CareerStore(repos, core);

const DAY = 86400_000;
const NOW = Date.now();
const iso = (offsetDays, hour = 10) => { const d = new Date(NOW + offsetDays * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };

async function call(method, path, body) {
  const req = new Request(`http://local${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleCareerRoute(new URL(req.url).pathname, req, { llm: null, broadcast: () => undefined, sessionId: () => 'global', studioExport: false });
  const json = res ? await res.json() : null;
  if (!res || res.status >= 400) throw new Error(`${method} ${path} -> ${res?.status} ${JSON.stringify(json)}`);
  return json;
}

// ---------- 基本资料（私密库） ----------
const profile = {
  name: '林同学', gender: '女', birthday: '2003-04-18', phone: '13800001234', email: 'lin.tongxue@example.com', wechat: 'lin_tx_2026',
  politics: '共青团员', school: '华东示范大学', major: '计算机科学与技术', degree: '硕士', graduation: '2026-06', englishLevel: 'CET-6 586',
  city: '上海', availableDate: '2026-07', github: 'https://github.com/example-lin',
};
for (const [field, value] of Object.entries(profile)) await call('PUT', '/api/career/vault/items', { scope: 'profile', field, value });

// ---------- 经历库 ----------
const exps = [
  { title: '字节跳动 · 推荐算法实习', role: '算法实习生', org: '字节跳动', start_date: '2025-06', end_date: '2025-09', type: 'internship', summary: '抖音电商推荐召回',
    claims: ['负责双塔召回模型的负样本采样改造，离线 Recall@50 提升 3.2%', '搭建特征一致性校验脚本，每天自动比对线上线下 40+ 特征'] },
  { title: '校园二手交易小程序', role: '后端负责人', org: '校学生会', start_date: '2024-09', end_date: '2025-01', type: 'project', summary: '3 人小组，日活 800',
    claims: ['用 Go + MySQL 实现商品与订单服务，峰值 QPS 300', '设计举报审核流程，违规内容下降一半'] },
  { title: '多模态检索课题', role: '研究生', org: '华东示范大学 智能媒体实验室', start_date: '2024-03', end_date: null, type: 'research', summary: '图文检索与 RAG',
    claims: ['在 Flickr30k 上复现 CLIP 微调，R@1 提升 1.8', '一作投稿 CCF-B 会议 1 篇（在审）'] },
];
for (const e of exps) {
  const exp = repos.createExperience(e);
  for (const text of e.claims) { const c = repos.addClaim({ experience_id: exp.id, text, attribution: 'self', created_from: 'resume' }); repos.confirmClaim(c.id); }
}

// ---------- 主简历 ----------
const schema = {
  basics: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}', email: '{{vault:profile.email}}', city: '上海', target_cities: ['上海', '杭州', '北京'], objective: '算法工程师 / 后端开发', links: [{ label: 'GitHub', url: 'https://github.com/example-lin' }] },
  education: [
    { school: '华东示范大学', degree: '硕士', major: '计算机科学与技术', start: '2023.09', end: '2026.06', gpa: '3.8/4.0（前 10%）', courses: ['机器学习', '分布式系统', '信息检索'], bullets: [] },
    { school: '华东示范大学', degree: '本科', major: '软件工程', start: '2019.09', end: '2023.06', gpa: '3.7/4.0', courses: [], bullets: [] },
  ],
  experience: [{ org: '字节跳动', position: '推荐算法实习生', department: '抖音电商', location: '上海', start: '2025.06', end: '2025.09', bullets: exps[0].claims }],
  projects: [
    { name: '校园二手交易小程序', role: '后端负责人', start: '2024.09', end: '2025.01', bullets: exps[1].claims },
    { name: '多模态检索课题', role: '研究生', start: '2024.03', end: '至今', bullets: exps[2].claims },
  ],
  skills: [
    { name: '编程语言', level: '熟练', keywords: ['Python', 'Go', 'C++', 'SQL'] },
    { name: '机器学习', level: '掌握', keywords: ['PyTorch', '推荐召回', '对比学习', 'RAG'] },
  ],
  awards: [{ title: '全国大学生数学建模竞赛 省一等奖', issuer: '', date: '2022.11', description: '' }, { title: '研究生学业一等奖学金', issuer: '', date: '2024.10', description: '' }],
  certifications: [],
  custom_sections: [],
};
const master = store.createResumeMaster({ name: '算法 / 后端 通用版', direction: '算法工程师', schema_json: schema });

// ---------- 岗位库：走首次打开的自动导入（内置校招数据） ----------
const board = await call('GET', '/api/career/jobs/board?limit=500');
let jobs = repos.listJobs();
console.log(`[seed] 自动导入岗位 ${jobs.length} 个（岗位库展示 ${board.rows?.length ?? 0} 行）`);
// 补几家常见公司，保证投递记录里的公司名认得出（导入数据缺的时候兜底）
const EXTRA = [
  ['美团', '后端开发工程师-到店事业群', '上海'], ['京东', '推荐算法工程师', '北京'], ['阿里巴巴', 'Java 开发工程师', '杭州'], ['腾讯', '后台开发工程师', '深圳'],
  ['小红书', '搜索算法工程师', '上海'], ['拼多多', '服务端研发工程师', '上海'], ['网易', '游戏服务端开发', '杭州'], ['百度', '大模型应用工程师', '北京'],
  ['快手', '推荐算法工程师', '北京'], ['哔哩哔哩', '后端开发工程师', '上海'], ['米哈游', '服务器开发工程师', '上海'], ['蚂蚁集团', '数据研发工程师', '杭州'],
  ['携程', '后端开发工程师', '上海'], ['滴滴', '算法工程师-地图', '北京'], ['华为', '软件开发工程师', '深圳'], ['大疆', '嵌入式软件工程师', '深圳'],
  ['商汤科技', '计算机视觉算法工程师', '上海'], ['理想汽车', '自动驾驶算法工程师', '北京'], ['得物', 'Golang 开发工程师', '上海'], ['招商银行', '金融科技岗', '深圳'],
  ['中兴通讯', '软件开发工程师', '南京'], ['DeepSeek', 'AI 应用开发', '杭州'], ['蔚来', '数据开发工程师', '上海'], ['Shopee', 'Backend Engineer', '深圳'],
  ['字节跳动', '后端开发工程师-抖音', '上海'], ['vivo', '推荐算法工程师', '深圳'], ['OPPO', '后端开发工程师', '深圳'], ['科大讯飞', '大模型算法工程师', '合肥'],
];
for (const [company_name, title, location] of EXTRA) {
  repos.upsertJob({ source_platform: 'campus', source_job_id: `ui-${company_name}`, title, company_name, location, url: `https://campus.example.com/${encodeURIComponent(company_name)}/apply`,
    employment_type: 'campus', jd_raw: `${title}\n岗位职责：参与核心业务系统的设计与开发。\n任职要求：2026 届本科及以上，计算机相关专业；熟悉至少一门编程语言。`, deadline: iso(10 + (title.length % 20)).slice(0, 10) });
}
jobs = repos.listJobs();
const jobOf = name => jobs.find(j => j.source_job_id === `ui-${name}`);

// ---------- 两份定制简历 ----------
const tailorFor = (name, objective) => store.createTailored({ master_id: master.id, job_id: jobOf(name).id, schema_json: { ...schema, basics: { ...schema.basics, objective } }, strength: 'keywords' });
const tMeituan = tailorFor('美团', '后端开发工程师');
const tXhs = tailorFor('小红书', '搜索算法工程师');
store.confirmTailored(tXhs.id);

// ---------- 投递 ----------
const apps = {};
function apply(name, stage, daysAgo, note, resumeTailoredId = null) {
  const job = jobOf(name);
  const created = iso(-daysAgo);
  const app = repos.createApplication(job.id, resumeTailoredId, created);
  if (stage !== 'evaluated') repos.jumpTo(app.id, stage, note ?? '演示数据', {}, iso(-daysAgo + 0.2));
  apps[name] = repos.getApplication(app.id);
  return apps[name];
}
// 已投出
for (const [n, d] of [['阿里巴巴', 26], ['腾讯', 24], ['拼多多', 21], ['网易', 19], ['百度', 15], ['快手', 12], ['哔哩哔哩', 9], ['携程', 7], ['华为', 5], ['大疆', 4], ['得物', 2], ['招商银行', 1]]) apply(n, 'applied', d, '已投出');
// 不合适
for (const [n, d] of [['滴滴', 30], ['商汤科技', 28], ['理想汽车', 25], ['Shopee', 22], ['米哈游', 18]]) { apply(n, 'applied', d); repos.jumpTo(apps[n].id, 'rejected', '收到不合适邮件', {}, iso(-d + 6)); }
// 面试中
apply('美团', 'applied', 20, '已投出', tMeituan.id); repos.jumpTo(apps['美团'].id, 'interview', '一面通过', {}, iso(-10));
apply('小红书', 'applied', 17, '已投出', tXhs.id); repos.jumpTo(apps['小红书'].id, 'interview', '约了二面', {}, iso(-3));
// Offer
apply('蚂蚁集团', 'applied', 34); repos.jumpTo(apps['蚂蚁集团'].id, 'offer', '收到意向书', {}, iso(-2));

// 正在投：填好等过目（3）、要登录（2）、缺信息（1）、没填成（2）
const fill = (name, status, result) => {
  const job = jobOf(name);
  const a = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, resume_id: master.id }, apps[name].id, true);
  if (status !== 'approved') repos.setActionStatus(a.id, status, result);
  return a;
};
const review = rows => ({ review: { requiredFilled: rows, requiredTotal: rows, rows: [] } });
for (const n of ['京东', '科大讯飞', 'vivo']) { apply(n, 'pending', 0.3); fill(n, 'done', { summary: { status: 'stopped_before_submit' } }); repos.enqueueAction('submit', review(9), apps[n].id); }
for (const n of ['字节跳动', 'OPPO']) { apply(n, 'needs_user', 0.2); const a = fill(n, 'approved'); repos.openHandoff('login', { actionId: a.id, message: '网站要求登录' }); }
{
  apply('中兴通讯', 'needs_user', 0.2);
  const a = fill('中兴通讯', 'approved');
  repos.setActionStatus(a.id, 'executing', {
    gate: { gaps: [{ label: '身份证号', required: true, status: 'missing' }, { label: '紧急联系人', required: true, status: 'missing' }, { label: '期望薪资', required: true, status: 'missing' }] },
    needsUser: [{ label: '身份证号', key: 'idNumber' }, { label: '紧急联系人', key: 'emergencyContact' }, { label: '期望薪资', options: ['面议', '15-20K', '20-25K', '25K 以上'] }],
  });
  repos.openHandoff('missing_info', { actionId: a.id, message: '有几项信息要你补' });
}
for (const [n, err] of [['DeepSeek', 'navigation timeout of 30000 ms exceeded'], ['蔚来', 'locator.fill: 找不到输入控件 #school']]) {
  apply(n, 'blocked', 0.4); fill(n, 'failed', { error: err, summary: { status: 'failed' } });
}

// 目标星
for (const n of ['美团', '小红书', '字节跳动']) setTargetJob(repos, jobOf(n).id, true);

// ---------- 面试、笔试、Offer、截止 ----------
await call('POST', '/api/career/interviews/book', { company_name: '小红书', application_id: apps['小红书'].id, title: '搜索算法工程师', round: 'second', when: iso(2, 15), location: '线上 · 飞书会议', note: '二面，技术面 60 分钟' });
const past = store.createInterview({ application_id: apps['美团'].id, company_name: '美团', title: '后端开发工程师-到店事业群', round: 'first', date: iso(-10, 14),
  retro_json: { summary: '项目深挖为主，Redis 缓存一致性答得不够完整', strengths: ['项目讲得清楚'], gaps: ['缓存一致性', 'MySQL 索引下推'] } });
void past;
await call('POST', '/api/career/exams', { company_name: '网易', title: '网易 2026 校招笔试（服务端）', kind: 'written_test', due_at: iso(3, 19), url: 'https://exam.example.com/netease', note: '120 分钟，4 道编程题' });
await call('POST', '/api/career/exams', { company_name: '招商银行', title: '金融科技岗', kind: 'assessment', due_at: iso(5, 23), url: 'https://exam.example.com/cmb' });
await call('POST', '/api/career/offers', { application_id: apps['蚂蚁集团'].id, company_name: '蚂蚁集团', title: '数据研发工程师', location: '杭州',
  comp_json: { base_monthly: 26000, months: 16, sign_on: 30000, notes: '白菜价以上，含期权' }, deadline: iso(6, 18), risk_notes: '部门近期有调整' });
repos.createDeadline({ kind: 'application_deadline', title: '京东 网申截止', due_at: iso(4, 23), application_id: apps['京东'].id, source: 'manual' });

// ---------- 通知中心（收件箱） ----------
const inbox = [
  ['mail', '【小红书】二面邀请：搜索算法工程师，时间 ' + iso(2, 15).slice(0, 10) + ' 15:00，飞书会议链接见正文。', 'interview_invite', 'application', apps['小红书'].id],
  ['mail', '【网易】2026 校园招聘笔试通知：请于 ' + iso(3, 19).slice(0, 10) + ' 19:00 前完成在线笔试。', 'written_test', 'application', apps['网易'].id],
  ['mail', '【米哈游】感谢你投递服务器开发工程师，很遗憾这次没有合适的机会……', 'rejection', 'application', apps['米哈游'].id],
  ['mail', '【蚂蚁集团】录用意向书：数据研发工程师（杭州），请在 ' + iso(6).slice(0, 10) + ' 前答复。', 'offer', 'application', apps['蚂蚁集团'].id],
  ['mail', '【招商银行】已收到你的简历：金融科技岗，我们会在 2 周内反馈。', 'application_received', 'application', apps['招商银行'].id],
];
for (const [source, raw_text, kind, linked_type, linked_id] of inbox) {
  const item = repos.createInboxItem({ source, raw_text });
  repos.resolveInboxItem(item.id, { kind, linked_type, linked_id, parsed: { company: raw_text.match(/【(.+?)】/)?.[1] } });
}
repos.createInboxItem({ source: 'paste', raw_text: '内推码 NTAN2026，学长说投字节商业化后端，11 月底前有效。' });

const counts = {
  jobs: repos.listJobs().length, applications: repos.listApplications().length, asks: (await call('GET', '/api/career/asks')).asks?.length,
  deadlines: repos.listDeadlines({ status: 'open_or_missed' }).length, interviews: store.listInterviews().length, offers: store.listOffers().length, inbox: repos.listInbox().length,
};
console.log('[seed] done', JSON.stringify(counts));
repos.db.close?.();
process.exit(0);
