/**
 * 配方 · 前半程（plan-r3-suggest §2 S1–S12）：冷启动、简历、访谈四种问法、主张、方向、JD 评估、定制、第一份。
 * 访谈里的推导选项按经历类型换词（experience-interview 步骤 1 的追问清单是候选来源）。
 */
import type { InterviewRound } from '@career/core';

import type { SuggestChip } from '../../shared/careerSuggest';
import { doChip, featureChip, fillChip, sayChip, withMode } from './suggest-chip';
import {
  cityText, companyIn, exitSay, fit, ORDER_DO, ORDER_TALK, type Recipe,
} from './suggest-recipe-kit';
import { nextRound, roundLabel, starterVisible, type SceneId } from './suggest-scene';
import { cardActs } from './suggest-seeds';
import { shortCompany } from './suggest-text';

/** 访谈·开放问：按这一类经历常见的几种情况，替他组织好说法。 */
const ROUND_OPTIONS: Readonly<Record<InterviewRound, readonly string[]>> = {
  education: ['专业课成绩还不错', '拿过奖学金可以说', '成绩一般，没啥亮点'],
  course_project: ['是几个人一组的课程作业', '老师布置的期末大作业', '自己做的小东西，没人布置'],
  internship: ['实习里跟过的一个项目', '实习里做的日常一个活', '实习主要打杂，没项目'],
  campus: ['在社团里组织过活动', '班委或学生会的事', '帮老师做过课题'],
  competition_personal: ['报名参加的比赛', '得过奖的比赛', '自己做着玩的小东西'],
  skills: ['考过的证书可以说', '会用 Excel 和 Python', '会点软件，没证'],
};
const OPEN_DEFAULT = ['是几个人一组的课程作业', '实习里做的一个活', '自己做的小东西，没人布置'];

/** 访谈·降级问：换更小的场景。 */
const DOWNGRADE: readonly string[] = ['家教、兼职算吗', '帮社团或家里做过事', '报过名没获奖的比赛'];

const options = (texts: readonly string[], seed: string): SuggestChip[] => texts.map((t, i) => sayChip(t, 'option', `${seed}_${i}`));

/** 追数字：按问的是什么给带单位的半句（他只补一个数）。 */
const NUMBER_FILLS: ReadonlyArray<{ test: RegExp; text: string; id: string }> = [
  { test: /名次|排名|第几/, text: '排在第 ＿＿ 名：', id: 'rank' },
  { test: /占比|百分|提升|增长|降低|减少/, text: '提升了大约 ＿＿%：', id: 'pct' },
  { test: /团队|几个人一起/, text: '团队大概 ＿＿ 人：', id: 'team' },
  { test: /人|规模|参加|用户/, text: '大概 ＿＿ 人参加：', id: 'people' },
  // 「多久以前」问的是哪年的事，不是时长（verify-r3 P2-10）。
  { test: /多久(?!以前|之前)|几周|几天|几个月|多长|时长/, text: '做了约 ＿＿ 周：', id: 'weeks' },
];
const TIME_FILL = NUMBER_FILLS[NUMBER_FILLS.length - 1];
const PEOPLE_FILL = NUMBER_FILLS[NUMBER_FILLS.length - 2];

/** 两个半句都按问句挑：第一个命中的、第二个命中的；只命中一个时再退到时长 / 人数（verify-r3 P2-10）。 */
export function numberFills(question: string): SuggestChip[] {
  const hits = NUMBER_FILLS.filter(f => f.test.test(question));
  const first = hits[0] ?? PEOPLE_FILL;
  const second = hits[1] ?? (first === TIME_FILL ? PEOPLE_FILL : TIME_FILL);
  return [first, second].map(f => fillChip(f.text, 'option', `s4_${f.id}`));
}

/** 届别是真填空：猜的届别写进去他点了还得按 Enter，猜错还得删（verify-r3 P2-18）。 */
export const COHORT_FILL = '我是 ＿＿ 届，找校招';

const PROMPT_S2 = '简历刚读进来，小芽在核对识别结果或问一处冲突（如入学时间写哪个）。替他写 2 条直接回答：照抄小芽给的两个选项各一条（如「用 2023.09」），或「都对」「有一处不对：」。';
const PROMPT_S3 = '小芽在访谈他的经历，这一轮聊的是「{round}」{title}。他可能知道该说什么但不会组织。按这一类经历常见的几种情况，各写一条他可以直接选的说法（如课程项目：几人一组的大作业 / 自己做的小东西 / 实习里的一个活），不要问他问题，要替他答；不编具体数字和名字。';
const PROMPT_S5 = '他刚说"没有 / 没做过"，小芽在换更小的场景再问。替他写几条"更小的、他可能有的"经历说法（如家教兼职、帮社团做事、报过名没获奖的比赛），用他会说的话，以问句或陈述都可以。';
const PROMPT_S8 = '小芽刚提了 2–3 类方向并问他行不行。替他写 2 条回答：一条同意（点到小芽说的方向名），一条只要其中一类（点名）。';
const PROMPT_S9 = '他在问方向怎么选（A 好还是 B 好 / 我适合什么）。替他写几条"他其实在意什么"的说法，选了就等于说清了（如更想稳定、想以后能跨行、按经历哪个更容易进），要点到他问的那几个方向名。';

/** 门还在时替"有 / 没有简历"的两格：门管不了的事（先说一段经历、还没想好方向）。 */
const S1_BESIDE_DOORS: readonly SuggestChip[] = [
  fillChip('我做过的一件事是：', 'answer', 's1_story'),
  sayChip('还没想好投什么方向', 'answer', 's1_lost'),
];

const S1: Recipe = {
  order: ORDER_TALK,
  prompt: null,
  rules: ({ s, x, scene }) => [
    // 开场两扇门还在底下时，条上不再重复门上的话（L5），换成门给不了的。
    ...(starterVisible(scene, x) ? S1_BESIDE_DOORS : [
      sayChip('有简历，我拖进来', 'answer', 's1_has'),
      sayChip('还没有，先聊聊', 'answer', 's1_none'),
    ]),
    s.mailConnected ? featureChip('job_evaluate') : featureChip('mail_bind'),
    s.prefs.cohort ? sayChip('提交前我能先看吗', 'option', 's1_trust') : fillChip(COHORT_FILL, 'option', 's1_cohort'),
  ],
  fallback: c => S1.rules(c),
};

const S2: Recipe = {
  order: ['answer', 'advance', 'start', 'option', 'exit'],
  prompt: PROMPT_S2,
  rules: ({ s }) => [
    sayChip('按我的经历推荐方向', 'advance', 's2_direction'),
    s.mailConnected ? (s.resume.has ? featureChip('resume_editor') : null) : featureChip('mail_bind'),
  ],
  fallback: () => [sayChip('都对，接着来', 'answer', 's2_ok'), fillChip('有一处识别错了：', 'answer', 's2_wrong')],
};

const S3: Recipe = {
  order: ['option', 'answer', 'advance', 'start', 'exit'],
  prompt: PROMPT_S3,
  rules: () => [exitSay('这段先跳过，聊别的', 's3_skip')],
  fallback: ({ s }) => options(s.interview?.round ? ROUND_OPTIONS[s.interview.round] : OPEN_DEFAULT, 's3_opt'),
};

const S4: Recipe = {
  order: ['option', 'answer', 'advance', 'start', 'exit'],
  prompt: null,
  rules: ({ x }) => [
    ...numberFills(x.lastAssistant),
    sayChip('没统计过，只能估个大概', 'option', 's4_estimate'),
    exitSay('这个数记不清了，先跳过', 's4_skip'),
  ],
  fallback: c => S4.rules(c),
};

const S5: Recipe = {
  order: ['option', 'answer', 'advance', 'start', 'exit'],
  prompt: PROMPT_S5,
  rules: () => [sayChip('真没有，换下一类', 'option', 's5_none')],
  fallback: () => options(DOWNGRADE, 's5_opt'),
};

const S6: Recipe = {
  order: ['advance', 'option', 'answer', 'start', 'exit'],
  prompt: null,
  rules: ({ s }) => {
    const label = roundLabel(nextRound(s));
    return [
      label ? sayChip(`接着说${label}`, 'advance', 's6_next') : null,
      fillChip('刚那段还有一点：', 'option', 's6_more'),
      s.resume.experiences >= 2 && !s.resume.has ? sayChip('直接出一版简历看看', 'advance', 's6_resume') : null,
      exitSay('今天先聊到这，明天接着', 's6_pause'),
    ];
  },
  fallback: c => [...S6.rules(c), c.s.resume.has ? null : sayChip('直接出一版简历看看', 'advance', 's6_resume')],
};

const S7: Recipe = {
  order: ['advance', 'answer', 'start', 'option', 'exit'],
  prompt: null,
  rules: ({ s }) => [
    sayChip('都对，就按这些写', 'answer', 's7_ok'),
    fillChip('有一句不对：', 'answer', 's7_wrong'),
    s.resume.has ? doChip('先看一眼这份简历', 'advance', { type: 'open', surface: 'resume' }, 's7_open') : null,
    s.stage !== 'profile' ? featureChip('direction_explore') : sayChip('按我的经历推荐方向', 'advance', 's7_direction'),
  ],
  fallback: c => S7.rules(c),
};

const S8: Recipe = {
  order: ['answer', 'option', 'advance', 'start', 'exit'],
  prompt: PROMPT_S8,
  rules: ({ s }) => {
    const city = cityText(s);
    return [fillChip('再加一类：', 'option', 's8_more'), city ? sayChip(city, 'option', 's8_city') : fillChip('我对城市有要求：', 'option', 's8_city')];
  },
  fallback: () => [
    sayChip('行，就按这几类', 'answer', 's8_ok'),
    doChip('先按这几类挑几家看看', 'advance', { type: 'propose_batch' }, 's8_batch'),
  ],
};

const S9: Recipe = {
  order: ['option', 'answer', 'advance', 'start', 'exit'],
  prompt: PROMPT_S9,
  rules: ({ s }) => {
    const [a, b] = s.prefs.keywords;
    const text = a && b ? fit(`${a}、${b}都先投几家看看`, '两类都先投几家看看') : '两类都先投几家看看';
    return [doChip(text, 'advance', { type: 'propose_batch' }, 's9_both')];
  },
  fallback: () => options(['我更想稳定一点', '想以后能跨行', '按我的经历哪个更容易进'], 's9_opt'),
};

const S10: Recipe = {
  order: ORDER_DO,
  prompt: null,
  rules: ({ s, x }) => [
    sayChip('投这家，按它改简历', 'advance', 's10_apply'),
    featureChip('company_research', companyIn(`${x.lastAssistant}${x.lastUser}`, s)),
    sayChip('先看我差在哪几条', 'advance', 's10_gap'),
    sayChip('不投了，看下一个', 'answer', 's10_skip'),
  ],
  fallback: c => S10.rules(c),
};

const S11: Recipe = {
  order: ['advance', 'answer', 'option', 'start', 'exit'],
  prompt: null,
  rules: ({ s }) => {
    const [go, lighter] = cardActs(s) ?? [];
    const t = s.lastTailor;
    return [
      go ? withMode(go, 'advance') : null,
      lighter ? withMode(lighter, 'answer') : null,
      t ? doChip('整份看一眼再说', 'advance', { type: 'open', surface: 'resume', id: t.tailored_id }, 's11_open') : null,
      sayChip('其他的也这么改', 'option', 's11_rest'),
    ];
  },
  fallback: c => S11.rules(c),
};

const S12: Recipe = {
  order: ['answer', 'advance', 'option', 'start', 'exit'],
  prompt: null,
  rules: ({ s }) => {
    const b = s.batch;
    const peek = b?.runningAppId && b.running[0]
      ? doChip(fit(`看${shortCompany(b.running[0])}填到哪了`, '看看填到哪了'), 'advance', { type: 'open', surface: 'live', id: b.runningAppId }, 's12_peek')
      : sayChip('停在提交前叫我', 'advance', 's12_hold');
    return [sayChip('开放题我自己写', 'answer', 's12_openq'), sayChip('就按你填的', 'answer', 's12_ok'), peek, exitSay('我先去忙，填好叫我', 's12_exit')];
  },
  fallback: c => S12.rules(c),
};

export const TALK_RECIPES: Readonly<Partial<Record<SceneId, Recipe>>> = { S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12 };
