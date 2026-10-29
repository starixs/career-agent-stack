/**
 * v5：参考那张人物卡——左边一张有分量的真实图，右边名字、一行身份、两三行关键信息。
 * 字尽量少；动作平时不出现，悬停或键盘聚焦到卡片里才浮出来。数据全部来自本机数据库。
 */
import { ME, pagePng, photoJpg } from './local';

export type ResumeImage = 'page' | 'photo';
export type ResumeGoal = 'apply' | 'tailor';

function Acts({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <div className="c5-acts">
      <button type="button" className="c5-act-main">{primary} →</button>
      <button type="button" className="c5-act">{secondary}</button>
    </div>
  );
}

export function ResumeCard({ image, goal }: { image: ResumeImage; goal: ResumeGoal }) {
  return (
    <article className="c5" aria-label={`主简历：${ME.name}`}>
      <figure className={`c5-img ${image === 'photo' ? 'c5-img-photo' : 'c5-img-page'}`}>
        <img src={image === 'photo' ? photoJpg : pagePng} alt={image === 'photo' ? '证件照' : '主简历第 1 页'} draggable={false} />
      </figure>
      <div className="c5-text">
        <h3 className="c5-title"><span className="font-human">{ME.name}</span><span className="c5-aside">主简历</span></h3>
        <p className="c5-over">AI 应用开发工程师 · 北京 / 上海</p>
        <p className="c5-lede">{ME.lede}</p>
        <dl className="c5-rows">
          <div><dt>实习</dt><dd>武汉XX科技 · 数据库直连请求 −80%</dd></div>
          <div><dt>项目</dt><dd>校园二手交易平台 · 3000+ 学生在用</dd></div>
        </dl>
        <Acts primary={goal === 'apply' ? '用它投递' : '为岗位定制'} secondary="打开简历" />
      </div>
    </article>
  );
}

/** 页边标记：真实页面不裁，只在右缘按区块标出改了几处。位置来自 PDF 里各区块标题的坐标。 */
const MARKS: Array<{ top: number; bottom: number; label: string }> = [
  { top: 0.03, bottom: 0.115, label: '1' },
  { top: 0.135, bottom: 0.255, label: '5' },
  { top: 0.26, bottom: 0.485, label: '+4' },
  { top: 0.49, bottom: 0.78, label: '5' },
  { top: 0.785, bottom: 0.95, label: '重排' },
];

export function TailorCard() {
  const covered = 10;
  const total = 17;
  return (
    <article className="c5" aria-label="美团定制版简历">
      <div className="c5-imgwrap">
        <figure className="c5-img c5-img-page">
          <img src={pagePng} alt="定制版第 1 页，右缘标出改动位置" draggable={false} />
        </figure>
        {MARKS.map(m => (
          <span key={m.top} className="c5-mark" style={{ top: `${m.top * 100}%`, height: `${(m.bottom - m.top) * 100}%` }}>
            <b>{m.label}</b>
          </span>
        ))}
      </div>
      <div className="c5-text">
        <h3 className="c5-title"><span className="font-human">美团</span><span className="c5-aside">定制版</span></h3>
        <p className="c5-over">AI 应用开发工程师 · 应届校招</p>
        <p className="c5-stat"><b>24</b><span>处改动，新增 8 处</span></p>
        <div className="c5-meter" aria-label={`JD 关键词覆盖 ${covered} / ${total}`}>
          <span className="c5-meter-cells">{Array.from({ length: total }, (_, i) => <i key={i} className={i < covered ? 'on' : ''} />)}</span>
          <span className="c5-meter-label">JD 关键词 {covered} / {total}</span>
        </div>
        <dl className="c5-rows">
          <div><dt>待补</dt><dd className="c5-need">4 项：两个量化数字、新项目的时间地点</dd></div>
        </dl>
        <Acts primary="采纳" secondary="看全部改动" />
      </div>
    </article>
  );
}

export function InterviewCard() {
  return (
    <article className="c5" aria-label="模拟面试第 1 题">
      <figure className="c5-img c5-img-quote">
        <span className="c5-q-mark font-human" aria-hidden="true">“</span>
        <span className="c5-q-text">借助 Redis 缓存活动规则与用户状态信息，配合分布式锁机制防范重复提交，<u>数据库直连请求削减 80%</u></span>
        <span className="c5-q-src">你的简历 · 武汉XX科技 · 实习</span>
      </figure>
      <div className="c5-text">
        <p className="c5-over">美团 · 大厂一面 · 第 1 / 8 题</p>
        <h3 className="c5-question font-human">这 80% 是怎么量出来的？缓存和数据库不一致的时候，你怎么处理？</h3>
        <dl className="c5-rows">
          <div><dt>考点</dt><dd>缓存一致性 · 分布式锁</dd></div>
        </dl>
        <Acts primary="开始回答" secondary="换一题" />
      </div>
    </article>
  );
}
