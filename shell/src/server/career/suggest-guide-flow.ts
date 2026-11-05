/**
 * 下一步条 r4 · 后半程 S13–S29 的"思路 + 示例 + 允许意图"（plan-r4-suggest §4）。
 * 写法同 suggest-guide-talk.ts：条上固定三格，依次是配合 / 犹豫 / 纠正，每组示例三行按这个顺序；
 * 示例里的公司、家数、选项是占位，模型必须换成状态里和这一轮里的真东西。
 * target 写法：start_card picked|all；propose_batch next|公司名（顿号分隔）；open_deck / ask_primary 写事的种类
 * （登录 / 缺信息 / 没填成 / 过目 / 选择）或公司名；ask_choose 写选项原文；open 写 live|resume|jobs|dossier:公司|resume:tailored。
 */
import type { SceneGuide } from './suggest-guide-types';
import type { SceneId } from './suggest-scene';

const S13: SceneGuide = {
  anchor: 'strict',
  text: '底下是一张勾选表，默认勾了几家等他点头。他不想一家家看，只想一次定。卡上已有「投这 N 家」「先不投」，别撞。配合：按默认勾的确认（start_card picked，写家数和一两家名字），或全投（start_card all，写总家数）。犹豫：这批先放着（dismiss_card），或拿不准某家（"平安那家靠谱吗"）。纠正：他刚说的条件没照办或想改（"去掉外包的""只要国企"），否则换一批（propose_batch）。',
  intents: ['start_card', 'propose_batch', 'dismiss_card', 'say'],
  examples: [
    ['就这 5 家，先投招商、平安|start_card|picked', '这批先放着，我去忙|dismiss_card', '去掉外包的，其余都投|say'],
    ['全投，18 家都投|start_card|all', '平安那家靠谱吗|say', '不要外包，换一批|propose_batch'],
    ['就这 3 家，美的、格力先投|start_card|picked', '先放着，晚上再看|dismiss_card', '只投国企银行那几家|say'],
  ],
};

const S14: SceneGuide = {
  anchor: 'strict',
  text: '后台正在一家家填，他可能来问进度或只是看一眼。他想知道"在动、没卡住"，然后去忙。他问进度就用状态里的真数字答（投出、在填、排队几家）。配合：你接着投、我先去忙，或把备好的都投出（ask_primary 过目）；有登录又没连手机就连手机。犹豫：看一眼正在填的那家（open live，点名），或担心某家卡住、今天投不完。纠正：有家不该投或条件变了（"海康那家别投了""附件换成财务版"）。',
  intents: ['ask_primary', 'open', 'start_feature', 'say'],
  examples: [
    ['备好的 3 家都投出|ask_primary|过目', '招商银行那份卡住了吗|open|live', '海康那家别投了|say'],
    ['你接着投，我先去忙|say', '排队的 6 家今天能投完吗|say', '附件换成财务版那份|say'],
    ['连上手机自动收验证码|start_feature|phone_link', '看正在投的几家|open|live', '深圳那几家先别投|say'],
  ],
};

const S15: SceneGuide = {
  anchor: 'strict',
  text: '有几家要他登录或输验证码才能接着填。他嫌烦，想一次处理完。配合：去处理（open_deck 登录，点名公司和家数）；他刚说处理完了就"扫好了，接着填"；没连手机就连手机自动收验证码。犹豫：稍后再登、我先去忙，或担心登录出问题。纠正：某家不想登了要跳过、账号不是这个，或验证码没收到要再发一次。',
  intents: ['open_deck', 'say', 'start_feature'],
  examples: [
    ['先处理华为、字节要登录的|open_deck|登录', '我先去忙，稍后再登|say', '字节不登了，跳过|say'],
    ['扫好了，接着填|say', '登录会不会被封号|say', '验证码没收到，再发一次|say'],
    ['连上手机自动收验证码|start_feature|phone_link', '顺丰晚点再登|say', '顺丰账号不是这个手机号|say'],
  ],
};

const S16: SceneGuide = {
  anchor: 'strict',
  text: '有几家缺同一项信息（证件号、期望薪资、照片、毕业时间…）卡着。他想填一次、所有家一起放行。按状态里缺的那一项换字。配合：填并放行（open_deck 缺信息，写"填 X，N 家一起放行"）。犹豫：对这一项的顾虑（证件号→安全吗；薪资→填多少合适；照片→先用哪张），或这批先不填。纠正：这项他没有或不该这么填（"这项我没有，空着""不填数，写面议"），或小芽记错了他的信息。',
  intents: ['open_deck', 'say'],
  examples: [
    ['填证件号码，20 家一起放行|open_deck|缺信息', '我的身份证号安全吗|say', '这项我没有，空着|say'],
    ['填期望薪资，8 家一起放行|open_deck|缺信息', '薪资填多少合适|say', '不填数，写面议|say'],
    ['补上证件照，5 家一起放行|open_deck|缺信息', '这批先不填照片|say', '毕业时间是 27 年 6 月|say'],
  ],
};

const S17: SceneGuide = {
  anchor: 'strict',
  text: '有几家没填成。他想知道是不是自己的问题、还要不要管。小芽说了原因就针对原因（"验证码过期了""网站改版"）。配合：再试一次（ask_primary 没填成，写家数或点名）。犹豫：问清哪一步没过去、是不是他的问题，或先放着去忙。纠正：这几家不投了（点名或写家数），或小芽说的原因不对（"中兴我投过了"）。不说"一定能成"。',
  intents: ['ask_primary', 'say'],
  examples: [
    ['再试一次这 3 家|ask_primary|没填成', '哪一步没过去，是我的问题吗|say', '这 3 家不投了|say'],
    ['再试一次中兴那家|ask_primary|没填成', '先放着，我去忙|say', '中兴我投过了，别再投|say'],
  ],
};

const S18: SceneGuide = {
  anchor: 'strict',
  text: '有几家已经填好、停在提交前等他过目。他想确认没出错再投，但不想一份份细看。配合：都投出（ask_primary 过目，写家数）。犹豫：先看一眼某家或开放题再投（open_deck 过目，点名）；他问"开放题写了什么"就是去看。纠正：某处填错了要改，点名公司和那一项（"附件换成财务版""平安那份城市填错了"）。',
  intents: ['ask_primary', 'open_deck', 'say'],
  examples: [
    ['备好的 3 家都投出|ask_primary|过目', '看一眼招商银行那份再投|open_deck|过目', '附件换成财务版那份|say'],
    ['7 家都投出|ask_primary|过目', '开放题先给我看看|open_deck|过目', '平安那份城市填错了|say'],
  ],
};

const S19: SceneGuide = {
  anchor: 'strict',
  text: '网页上有一道题要他选（选项原文在状态的等他里）。他拿不准哪个对自己有利。配合：选最常见或小芽建议的那个（ask_choose，target 写选项原文，可加「选」字，不改意思）。犹豫：先看题（open_deck 选择），或问哪个更有利。纠正：不认小芽的建议，选另一个选项（ask_choose 原文）。不替他做有后果的决定（调剂、服从分配）而不让他看到选项。',
  intents: ['ask_choose', 'open_deck', 'say'],
  examples: [
    ['选「接受调剂」|ask_choose|接受调剂', '先看题是什么|open_deck|选择', '选「不接受」|ask_choose|不接受'],
    ['选「全国均可」|ask_choose|全国均可', '哪个更容易过筛|say', '选「深圳」|ask_choose|深圳'],
  ],
};

const S20: SceneGuide = {
  anchor: 'strict',
  text: '三天内有笔试或测评，或他刚提到。他慌、想知道考什么、怕来不及。公司用状态里三天内截止的那家。配合：先练几道（exam_practice:公司），或考时截图搜题（exam_search）。犹豫：问往年考什么、几点开始、性格测评要不要装、编程题不会怎么办。纠正：小芽把类型或时间搞错了（"是性格测评，不是笔试""笔试是后天"），或他根本没收到。',
  intents: ['start_feature', 'say'],
  examples: [
    ['先练几道字节的题|start_feature|exam_practice:字节', '字节往年考行测还是专业|say', '是性格测评，不是笔试|say'],
    ['考的时候截图给你搜题|start_feature|exam_search', '性格测评要不要装|say', '笔试是后天，不是明天|say'],
    ['先练几道美团的题|start_feature|exam_practice:美团', '编程题我不会怎么办|say', '美团我没收到笔试|say'],
  ],
};

const S21: SceneGuide = {
  anchor: 'loose',
  text: '三天内有面试，或底下是面试准备卡。他紧张，最怕被问穿简历。公司用状态里那场面试的公司，没有就不写"这家"。配合：起头准备（没准备卡→interview_prep:公司；有→interview_probe:公司模拟一遍），或预测深挖（interview_predict:公司）。犹豫：针对他的担心直接问（"自我介绍要多长""实习会被追问吗"）。纠正：轮次、形式或时间搞错了（"是群面，不是单面""是二面，不是一面"）。',
  intents: ['start_feature', 'say'],
  examples: [
    ['帮我准备字节这场面试|start_feature|interview_prep:字节', '实习那段会被追问吗|say', '是二面，不是一面|say'],
    ['来一遍字节的模拟面试|start_feature|interview_probe:字节', '自我介绍要多长|say', '是群面，不是单面|say'],
    ['字节会深挖我简历哪里|start_feature|interview_predict:字节', 'SQL 常考哪几类题|say', '面试改到周五了|say'],
  ],
};

const S22: SceneGuide = {
  anchor: 'loose',
  text: '他刚面完。脑子乱、记不全，想知道还有没有戏。点到他提的公司和轮次（"字节二面"）；他已说结果就接结果。配合：复盘这场（interview_retro:公司），或先说最卡的那题；挂了可以接着投别的。犹豫：问了什么记不全、这样还有没有戏。纠正：小芽理解错了结果或细节（"不是挂了，是让等通知""不是技术面，是 HR 面"），或带空"面试官当时反应："。',
  intents: ['say', 'fill', 'start_feature', 'propose_batch'],
  examples: [
    ['帮我把京东这场复盘一下|start_feature|interview_retro:京东', '问了什么我记不全了|say', '不是挂了，是让等通知|say'],
    ['先说字节二面最卡的那题|say', '这样还有戏吗|say', '面试官当时反应：|fill'],
    ['接着投别的|propose_batch|next', '挂在哪一题你帮我看|say', '不是技术面，是 HR 面|say'],
  ],
};

const S23: SceneGuide = {
  anchor: 'strict',
  text: '他手上有 Offer。他怕选错、怕错过期限，也可能在骑驴找马（这很正常，不替他拒）；期限当真对待。点名他提到的公司。配合：Offer 列出来对比（start_feature offer），或接着投别的（propose_batch）。犹豫：怎么跟某家说再等几天、三方要不要先签、户口重不重要。纠正：小芽把他在意的说错了（"我更在意城市，不是钱"），或期限、薪资记错了。',
  intents: ['start_feature', 'say', 'propose_batch'],
  examples: [
    ['两家 Offer 列出来比|start_feature|offer', '怎么跟美团说再等几天|say', '我更在意城市，不是钱|say'],
    ['先接着投别的|propose_batch|next', '三方先别签吧|say', '美团是周五截止，不是周三|say'],
    ['列出来比一下|start_feature|offer', '小米给的户口重要吗|say', '小米给的是 22k，不是 20k|say'],
  ],
};

const S24: SceneGuide = {
  anchor: 'loose',
  text: '近来拒信多，或他刚说了丧气话。站在他一边，不逼不劝不灌鸡汤；他具体说了（"字节都挂了""投 30 家没面试"）就用他的数和公司。配合：接着投（propose_batch），或看看这个月的数（funnel）。犹豫：歇两天、今天先不想了、是不是自己不行。纠正：方向或目标定错了，换方向或换一类公司（"大厂先放放，投点国企"），或问题不在他以为的地方。不说"一定会好"。',
  intents: ['say', 'start_feature', 'propose_batch'],
  examples: [
    ['接着投，别管了|propose_batch|next', '先不投了，歇两天|say', '换个方向试试|start_feature|direction_explore'],
    ['看我这个月的数|start_feature|funnel', '30 家都没回，是我不行吗|say', '大厂先放放，投点国企|say'],
    ['再投一批中小公司|propose_batch|next', '今天先不想了|say', '不是面试不行，是简历没过|say'],
  ],
};

const S25: SceneGuide = {
  anchor: 'strict',
  text: '他问了一句进度或某家有没有戏，小芽答完了。答完他想顺手办点什么，或回到刚才在做的事。配合：点名他问的那家去看（open dossier:公司），或再投几家别的、回到刚才那件事（说出是哪件）。犹豫：追问还有没有戏（"泡 20 天还有戏吗""要不要发邮件问"）。纠正：小芽答的不对或答错了家（"我问的是字节，不是抖音""网易我是 10 号投的"）。',
  intents: ['open', 'propose_batch', 'say'],
  examples: [
    ['帮我看看字节这份|open|dossier:字节', '泡 20 天一般还有戏吗|say', '我问的是字节，不是抖音|say'],
    ['那再投几家别的|propose_batch|next', '要不要发邮件问问|say', '网易我是 10 号投的|say'],
  ],
};

const S26: SceneGuide = {
  anchor: 'loose',
  text: '他问"你能做什么"。他不会自己探索，要的是此刻就用得上的事，点了就开始。按阶段挑：没简历→简历拖进来 / 邮箱接过来；在挑方向→评估岗位 / 查公司 / 方向；在投→再投一批 / 看进展 / 搜题 / 自我介绍。配合：此刻最该做的那件，他问得具体就是那个。犹豫：另一件不那么急的，或先口述一段。纠正：他问的其实是别的（"我是想问能帮我搜题吗"）。能点名公司就点名。',
  intents: ['start_feature', 'say'],
  examples: [
    ['再投一批|start_feature|batch', '看正在投的几家|start_feature|live', '我是想问能帮我搜题吗|start_feature|exam_search'],
    ['有简历，我拖进来|say', '先口述一段实习|say', '我想问投过的怎么管|start_feature|mail_bind'],
    ['丢个岗位给你看值不值|start_feature|job_evaluate', '看看哪些方向适合我|start_feature|direction_explore', '我是想查宁德时代靠谱吗|start_feature|company_research:宁德时代'],
  ],
};

const S27: SceneGuide = {
  anchor: 'strict',
  text: '他隔了一阵才回来，有几件事在等他。他想一眼知道"错过什么没有、先干哪件"。配合：从最急的开始（open_deck），或点名最大的那件（"先处理顺丰要登录的"），备好的就投出（ask_primary 过目）。犹豫：先问这几天的结果（投出几家、有没有回音，用状态里的数），或我先忙、晚点处理。纠正：某件已经不用办了（"华为我在官网投过了""小米登录已经弄好了"）。',
  intents: ['open_deck', 'say', 'ask_primary'],
  examples: [
    ['从最急的开始|open_deck', '这几天投出了几家|say', '华为我在官网投过了|say'],
    ['备好的 4 家都投出|ask_primary|过目', '有公司回我了吗|say', '顺丰那家不投了|say'],
    ['先处理顺丰要登录的|open_deck|登录', '我先忙，晚上处理|say', '小米登录我已经弄好了|say'],
  ],
};

const S28: SceneGuide = {
  anchor: 'loose',
  text: '有简历，但库里没有合他条件的岗位。他会以为是自己不行。小芽说了原因（"北京财务岗都截止了"）就接原因。配合：放宽条件（城市不限 / 加一城），或自己丢岗位来评估（job_evaluate）。犹豫：先等等，有新岗位进来叫我，或问春招还有没有。纠正：条件本身记错了或太窄（"我不只要财务，审计也行"，或带空"方向改成："）。',
  intents: ['say', 'fill', 'start_feature'],
  examples: [
    ['城市不限了|say', '有新岗位进来叫我|say', '方向改成：|fill'],
    ['丢个岗位给你看值不值|start_feature|job_evaluate', '春招还有财务岗吗|say', '我不只看北京，天津也行|say'],
    ['北京没有就看天津|say', '先等等，不急|say', '我不只要财务，审计也行|say'],
  ],
};

const S29: SceneGuide = {
  anchor: 'strict',
  text: '没判出具体幕。配合：直接回小芽这句，问了就给最顺的答法，没问就按阶段推进（下一批有岗位→propose_batch 点名；有等他的事→open_deck 点名）。犹豫：先看看再说（查公司、看那家的进展，点名公司）。纠正：小芽理解错了（"不对，我说的是美的"，或带空"不是这个意思："），或"我想问点别的："。',
  intents: ['say', 'fill', 'propose_batch', 'open_deck', 'open', 'start_feature'],
  examples: [
    ['先投平安、美的这 2 家|propose_batch|平安、美的', '先看平安靠谱吗|start_feature|company_research:平安', '不是这个意思：|fill'],
    ['先处理小米要登录的|open_deck|登录', '小米那份我先看看|open|dossier:小米', '我想问点别的：|fill'],
    ['好，就按你说的来|say', '查查小米加班多吗|start_feature|company_research:小米', '不对，我说的是美的|say'],
  ],
};

export const GUIDES: Readonly<Partial<Record<SceneId, SceneGuide>>> = {
  S13, S14, S15, S16, S17, S18, S19, S20, S21, S22, S23, S24, S25, S26, S27, S28, S29,
};
/** 交叉契约里的导出名（plan-r4 §6），与 GUIDES 同一份。 */
export const GUIDES_FLOW = GUIDES;
