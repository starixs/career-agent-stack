import '@/index.css';
import '@/theme/themes/career';
import './page.css';
import './cards.css';
import './flow.css';
import './a3.css';
import './b.css';

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { InterviewCard, ResumeCard, TailorCard, type ResumeGoal, type ResumeImage } from './cards';
import { Flow } from './flow';
import { UiPage, UxPage } from './a3page';
import { UiPageB, UxPageB } from './bpage';

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; name: string }>; onChange: (v: T) => void }) {
  return (
    <div className="pv-seg" role="group" aria-label={label}>
      {options.map(o => <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.name}</button>)}
    </div>
  );
}

function User({ children }: { children: string }) {
  return (
    <div className="flex justify-end px-1 py-2 select-none">
      <div className="relative w-fit max-w-[85%] rounded-2xl bg-[var(--note)] p-4 text-base text-[var(--ink)] select-text">{children}</div>
    </div>
  );
}

function App() {
  const q = new URLSearchParams(location.search);
  const [scheme, setScheme] = useState<'light' | 'dark'>(q.get('scheme') === 'dark' ? 'dark' : 'light');
  const [image, setImage] = useState<ResumeImage>(q.get('image') === 'photo' ? 'photo' : 'page');
  const [goal, setGoal] = useState<ResumeGoal>(q.get('goal') === 'tailor' ? 'tailor' : 'apply');
  const [width, setWidth] = useState<'wide' | 'narrow'>(q.get('width') === 'narrow' ? 'narrow' : 'wide');
  const [acts, setActs] = useState(q.get('acts') === '1');
  const [view, setView] = useState<'bx' | 'bi' | 'ux' | 'ui' | 'flow' | 'cards'>((q.get('view') as 'bx' | 'bi' | 'ux' | 'ui' | 'flow' | 'cards') || 'bx');
  const [all, setAll] = useState(q.get('all') === '1');
  const [run, setRun] = useState(0);
  const [mono, setMono] = useState(q.get('logo') === 'mono');
  useEffect(() => { document.documentElement.classList.toggle('b-mono', mono); }, [mono]);
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-theme-id', 'keystone-default');
    html.setAttribute('data-color-scheme', scheme);
    html.classList.toggle('dark', scheme === 'dark');
  }, [scheme]);
  return (
    <div className="pv-page">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <filter id="b-mono" colorInterpolationFilters="sRGB">
          <feFlood floodColor="#fff" result="w" />
          <feComposite in="SourceGraphic" in2="w" operator="over" result="flat" />
          <feColorMatrix in="flat" type="matrix" values="0 0 0 0 0.11  0 0 0 0 0.10  0 0 0 0 0.09  -0.3 -0.59 -0.11 0 1" />
          <feComponentTransfer><feFuncA type="linear" slope="2.6" /></feComponentTransfer>
        </filter>
      </svg>
      <div className="pv-controls">
        <Seg label="看什么" value={view} options={[{ id: 'bx', name: '做法三 · UX' }, { id: 'bi', name: '做法三 · UI' }, { id: 'ux', name: '旧 · 方案三 UX' }, { id: 'ui', name: '旧 · 方案三 UI' }, { id: 'flow', name: '上一版流程' }, { id: 'cards', name: '简历卡（已过）' }]} onChange={setView} />
        {view === 'flow' && <Seg label="展开" value={all ? 'all' : 'step'} options={[{ id: 'step', name: '一步步点' }, { id: 'all', name: '全部展开' }]} onChange={v => setAll(v === 'all')} />}
        {view === 'flow' && <button type="button" className="pv-reset" onClick={() => { setAll(false); setRun(r => r + 1); }}>重来</button>}
        {(view === 'cards' || view === 'flow') && <Seg label="简历卡的图" value={image} options={[{ id: 'page', name: '简历真实预览' }, { id: 'photo', name: '证件照' }]} onChange={setImage} />}
        {(view === 'cards' || view === 'flow') && <Seg label="简历卡悬停动作" value={goal} options={[{ id: 'apply', name: 'A 用它投递' }, { id: 'tailor', name: 'B 为岗位定制' }]} onChange={setGoal} />}
        {(view === 'cards' || view === 'flow') && <Seg label="动作显示" value={acts ? 'on' : 'off'} options={[{ id: 'off', name: '平时' }, { id: 'on', name: '悬停时' }]} onChange={v => setActs(v === 'on')} />}
        {(view === 'cards' || view === 'flow') && <Seg label="对话栏" value={width} options={[{ id: 'wide', name: '宽窗口' }, { id: 'narrow', name: '窄栏' }]} onChange={setWidth} />}
        {(view === 'bx' || view === 'bi') && <Seg label="公司标志" value={mono ? 'mono' : 'color'} options={[{ id: 'color', name: '标志原色' }, { id: 'mono', name: '标志单色' }]} onChange={v => setMono(v === 'mono')} />}
        <Seg label="外观" value={scheme} options={[{ id: 'light', name: '浅色' }, { id: 'dark', name: '深色' }]} onChange={setScheme} />
      </div>
      {view === 'bx' && <UxPageB />}
      {view === 'bi' && <UiPageB />}
      {view === 'ux' && <UxPage />}
      {view === 'ui' && <UiPage />}
      {(view === 'flow' || view === 'cards') && <div className={`pv-chat ${acts ? 'pv-acts' : ''}`} data-width={width}>
        {view === 'flow' ? <div className="chat-reading mx-auto max-w-[820px] px-3"><Flow key={run} all={all} /></div> : <div className="chat-reading mx-auto max-w-[820px] px-3">
          <User>帮我把经历库里 A 套的内容整理成一份主简历，数字别改。</User>
          <div className="ai-message-content px-3 py-2 text-[var(--ink)]">
            <p>好了，内容原样搬进了主简历，日期也修正了。</p>
            <ResumeCard image={image} goal={goal} />
            <p>接着按美团这个岗位的 JD 做了定制提案。</p>
            <TailorCard />
            <p>有 4 处信息经历库里没有，我没敢写，需要你补。补完我们来一轮模拟面试，先从你最硬的那个数字问起。</p>
            <InterviewCard />
          </div>
        </div>}
      </div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
