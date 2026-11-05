/**
 * 下一步条 r4 · 前半程 29 幕之 S1–S12 的"思路 + 示例 + 允许意图"（plan-r4-suggest §4）。
 * 思路告诉模型：他此刻想说 / 想办什么、从这一轮和状态里取哪些真名字、四格各自干什么（回应 / 推进 / 起头 / 退出）。
 * 示例只是思路的样子：公司、数字、经历名都是占位，模型必须换成状态里和这一轮里的真东西。
 * 示例一行 'text|intent|target'（target 可省）；start_feature 的 target 写 'feature_id' 或 'feature_id:公司'。
 */
import type { SceneGuide } from './suggest-guide-types';
import type { SceneId } from './suggest-scene';

const S1: SceneGuide = {
  anchor: 'loose',
  text: '第一次打开，他还什么都没交，小芽多半在问"手上有什么 / 想找什么"。他要的是被领着走一步，不是填表。按小芽这句的问法变：问简历→两格直接答有 / 没有；问方向→给两个他专业说得出口的方向或"按我经历推荐"；问届别、城市→给带空的半句（状态里条件已有的不再问）。另两格：一格把他已有的接进来（邮箱没连→手投过的从邮箱接过来；他提到岗位→丢给你看值不值得投），一格替他说出常见处境（"之前投过都没回""还没想好方向"）。',
  intents: ['say', 'fill', 'start_feature'],
  examples: [
    ['有简历，我拖进来|say', '还没有，先聊聊|say', '我是 ＿＿ 届，找校招|fill', '手投过的从邮箱接过来|start_feature|mail_bind'],
    ['还没想好，按我经历推荐|say', '想做财务或审计|say', '只看上海、杭州|say', '先把简历给你看|say'],
    ['投过的从邮箱接过来|start_feature|mail_bind', '大概投了 ＿＿ 家：|fill', '都是网申，没找人内推|say', '先看简历哪里有问题|say'],
  ],
};

const S2: SceneGuide = {
  anchor: 'strict',
  text: '简历刚读进来，小芽在核对识别结果或问一处冲突。他只想确认完赶紧往下走。两格照抄小芽给的两个候选各答一条（"用 2023.09""是大二，不是大三"），用小芽这句里的原词；一格"其余都对"或"有一处不对："（带空）；一格推进：按经历推荐方向，或邮箱没连时把手投过的接过来，或简历要自己改。不要重复卡上「全部通过」「只用所选」。不编他没说的时间和名字。',
  intents: ['say', 'fill', 'start_feature'],
  examples: [
    ['用 2023.09|say', '用 2023.08|say', '其余都对|say', '按我的经历推荐方向|say'],
    ['对，大三暑假两个月|say', '是大二，时间识别错了|say', '有一处不对：|fill', '手投过的从邮箱接过来|start_feature|mail_bind'],
    ['手机号用 138 那个|say', '学校写全称|say', '其余都对，接着来|say', '简历我自己再改改|start_feature|resume_editor'],
  ],
};

const S3: SceneGuide = {
  anchor: 'strict',
  text: '访谈中，小芽问"这段做的是什么 / 你负责什么"。他多半知道却不会组织。看状态里访谈的这一轮类型和在聊的经历名，按这一类常见的三种情况各写一条他直接选的陈述（课程项目：几人一组的大作业 / 自己做的小东西 / 实习里的活；实习：跟过的项目 / 日常一个活 / 主要打杂；比赛：报名的 / 得奖的 / 做着玩的；社团：组织活动 / 班委 / 帮老师做课题），必须用小芽这句和经历名里的词（"数据库"就写"数据库课设，三人一组"）。第四格"这段先跳过"。不编数字、名次、公司名。',
  intents: ['say', 'fill'],
  examples: [
    ['是三人一组的数据库课设|say', '老师布置的期末大作业|say', '自己做着玩的小程序|say', '这段先跳过，聊别的|say'],
    ['跟了一个报表自动化项目|say', '日常帮带教做数据整理|say', '主要打杂，没完整项目|say', '这段先跳过|say'],
    ['报了名，没进决赛|say', '拿了校级三等奖|say', '团队里我做 PPT 和答辩|say', '这段先跳过|say'],
  ],
};

const S4: SceneGuide = {
  anchor: 'strict',
  text: '访谈中，小芽在追一个数（人数 / 规模 / 时长 / 名次 / 占比 / 金额）。他多半只记得个大概。两格带单位的半句，他只补一个数，单位必须对上小芽问的那个量（问人数给"＿＿ 人"，问时长给"＿＿ 周 / 个月"，问名次给"第 ＿＿ 名"，问占比给"＿＿%"），第二格换一个相关的量而不是固定写时长；一格替他给量级（小芽给了参照就用参照："十几个人吧"）；一格"记不清，先跳过"。不替他编具体数。',
  intents: ['say', 'fill'],
  examples: [
    ['大概 ＿＿ 人用过|fill', '上线了 ＿＿ 周|fill', '没统计，几十个人吧|say', '这个数记不清，先跳过|say'],
    ['提升了大约 ＿＿%|fill', '从 ＿＿ 小时缩到 ＿＿ 小时|fill', '没量化过，只知道快了|say', '先跳过这个数|say'],
    ['排在第 ＿＿ 名|fill', '一共 ＿＿ 支队伍参加|fill', '没排名，拿了参与奖|say', '名次记不清，先跳过|say'],
  ],
};

const S5: SceneGuide = {
  anchor: 'loose',
  text: '他刚说"没有 / 没做过"，小芽换了更小的场景再问。他怕自己太空、不好意思说小事。替他写三条"更小、他很可能有"的经历，按状态里这一轮类型变（实习轮：家教、兼职、假期在店里帮忙；比赛轮：报名没进、院里小赛、建模选拔；社团轮：班里活动、勤工俭学、帮辅导员做事），用"算吗"的口气也行。最后一格"真没有，换下一类"。不替他编奖项和公司。',
  intents: ['say'],
  examples: [
    ['做过家教，算吗|say', '假期在亲戚店里帮忙|say', '线上兼职做过客服|say', '真没有，换下一类|say'],
    ['报过数学建模，没进|say', '参加过院里的案例赛|say', '做过创新创业项目申报|say', '真没有，换下一类|say'],
    ['帮辅导员整理过材料|say', '在图书馆勤工俭学过|say', '班里活动出过几次力|say', '真没有，换下一类|say'],
  ],
};

const S6: SceneGuide = {
  anchor: 'strict',
  text: '访谈里一段经历聊完了，小芽在小结或说"接着聊 X"。他想知道"够了没、下一步是什么"。四格：一格接下一类，点名状态里"还没聊"的第一类，最好带上刚聊完的经历名（"美团实习说完了，接着说社团"）；一格补刚那段漏的（带空）；一格推进：经历 ≥2 段且没简历→"直接出一版简历看看"，有简历→"把这段加进简历"或看简历；一格退出"今天先聊到这"。',
  intents: ['say', 'fill', 'open'],
  examples: [
    ['接着说实习|say', '课设还有一点没说：|fill', '直接出一版简历看看|say', '今天先聊到这，明天接着|say'],
    ['把这段加进简历|say', '接着说社团的事|say', '刚那段还有一点：|fill', '先看一眼现在的简历|open|resume'],
    ['美团实习说完了，接着说比赛|say', '实习还有个小项目：|fill', '三段够了，先出简历看看|say', '今天先聊到这|say'],
  ],
};

const S7: SceneGuide = {
  anchor: 'strict',
  text: '小芽列了几条从他话里抽出的说法等他认（底下有确认卡）。他怕写夸了被面试官戳穿，也怕漏了亮点。不要写卡上的「全部通过」。四格：一格点名改哪一条（引用那条里的数字或词："第 3 条人数写多了"，或"有一句不对："带空）；一格问出处（"「提升 30%」是我说的吗"）；一格看成品（有简历→先看一眼这份简历）；一格推进（推荐方向 / 自己改简历）。',
  intents: ['say', 'fill', 'open', 'start_feature'],
  examples: [
    ['有一句不对：|fill', '「提升 30%」是我说的吗|say', '先看一眼这份简历|open|resume', '按我的经历推荐方向|say'],
    ['第 3 条人数写多了|say', '「主导」改成「参与」|say', '奖学金那条漏了：|fill', '看看哪些方向适合我|start_feature|direction_explore'],
  ],
};

const S8: SceneGuide = {
  anchor: 'strict',
  text: '小芽按他的经历提了 2–3 类方向，问行不行。他多半没主意，想要"有人替我挑、我点头"。四格：一格同意并点名小芽说的方向名；一格只要其中一类或去掉一类（点名）；一格补条件（他说过城市就"只看 X、Y"，没说就"再加一类："带空，或想多看几种方向）；一格直接按这几类挑几家（propose_batch next）。不替他编没提过的方向。',
  intents: ['say', 'fill', 'propose_batch', 'start_feature'],
  examples: [
    ['行，财务和运营都投|say', '只投财务|say', '再加一类：|fill', '先按这几类挑几家看看|propose_batch|next'],
    ['这两类行，只看北京、上海|say', '运营不要，换成审计|say', '还有哪些方向适合我|start_feature|direction_explore', '先挑几家看看|propose_batch|next'],
    ['行，产品和用户研究都看|say', '只要产品，研究太卷了|say', '只看杭州、深圳|say', '先按这两类挑几家|propose_batch|next'],
  ],
};

const S9: SceneGuide = {
  anchor: 'loose',
  text: '他自己来问方向（"A 好还是 B 好 / 我适合什么"），小芽在答。他其实没想清自己在意什么。替他说出他可能在意的（稳定、钱、能跨行、好进、离家近、不加班），每条点到他问的那几个方向名；一格"按我的经历哪个更容易进"；一格两类都先投几家试试（propose_batch next）。不替他下结论，不说哪个一定好。',
  intents: ['say', 'propose_batch', 'start_feature'],
  examples: [
    ['我更想稳定一点|say', '想要以后能跨行的|say', '按我经历财务和运营哪个好进|say', '两类都先投几家看看|propose_batch|next'],
    ['银行稳定，我更看重这个|say', '券商钱多，但我怕加班|say', '按我经历哪个更好进|say', '两边各投几家试试|propose_batch|next'],
    ['我不想天天对着表格|say', '想离家近，回成都|say', '按经历列几个方向给我|start_feature|direction_explore', '先挑几家看看反应|propose_batch|next'],
  ],
};

const S10: SceneGuide = {
  anchor: 'strict',
  text: '他丢了一个岗位，小芽刚给了评估（合不合适、缺哪几条、建议投不投）。他想要一句话决定投不投。四格：一格"投这家"（propose_batch，target 写公司名）；一格针对小芽点出的那条缺口替他说实话（"SQL 我其实会一点""没 CPA 要紧吗"）；一格查这家公司（company_research:公司）或再丢一个；一格"不投了，看下一个"。评估说不匹配时，第一格换成接受结论。',
  intents: ['say', 'propose_batch', 'start_feature'],
  examples: [
    ['投平安这家，按它改简历|propose_batch|平安', 'SQL 这条我其实会一点|say', '先看平安靠谱吗|start_feature|company_research:平安', '不投了，看下一个|say'],
    ['差得多就不投了|say', '学历那条是硬要求吗|say', '再丢一个岗位看看|start_feature|job_evaluate', '还是投，试试|propose_batch|美的'],
    ['投比亚迪这家|propose_batch|比亚迪', '六级没过，算硬伤吗|say', '比亚迪加班多吗|start_feature|company_research:比亚迪', '先看我差在哪几条|say'],
  ],
};

const S11: SceneGuide = {
  anchor: 'strict',
  text: '小芽按某家岗位改了简历，底下是改动对比卡。他担心改得不像自己、被问穿。卡上已有「打开整份」，别重复。四格：一格点名改动的那一处表态（"项目那段别改，原来更真""技能别加 Power BI，我不会"）；一格轻重（"改得太多了，轻一点"）；一格投出这家（propose_batch 公司名）；一格其余几家也这么改（propose_batch next，有家数就写家数）。',
  intents: ['say', 'propose_batch', 'open'],
  examples: [
    ['可以，就这样投美团|propose_batch|美团', 'Power BI 别加，我不会|say', '改得太多了，轻一点|say', '其余几家也这么改|propose_batch|next'],
    ['就这样投京东|propose_batch|京东', '项目那段别改，原来更真|say', '「主导」改回「参与」|say', '其余 6 家也这么改|propose_batch|next'],
  ],
};

const S12: SceneGuide = {
  anchor: 'strict',
  text: '第一份正在当面填，他在看小芽怎么填。他想放心又不想一直盯着。按小芽这句说到的步骤变：到开放题→"开放题我自己写 / 就按你写的"；到证件、验证码→"验证码我来输"，没连手机给连手机；到附件→"用财务版那份"。一格看现场（open live，点名在填的公司）；一格"停在提交前叫我"；一格退出"我先去忙，填好叫我"。',
  intents: ['say', 'open', 'start_feature'],
  examples: [
    ['开放题我自己写|say', '就按你填的|say', '看招商银行填到哪了|open|live', '我先去忙，填好叫我|say'],
    ['验证码我来输|say', '连上手机自动收验证码|start_feature|phone_link', '停在提交前叫我|say', '我先去忙|say'],
    ['开放题给我看一眼再填|say', '附件用财务版那份|say', '看宁德时代填到哪了|open|live', '停在提交前叫我|say'],
  ],
};

export const GUIDES: Readonly<Partial<Record<SceneId, SceneGuide>>> = {
  S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12,
};
/** 交叉契约里的导出名（plan-r4 §6），与 GUIDES 同一份。 */
export const GUIDES_TALK = GUIDES;
