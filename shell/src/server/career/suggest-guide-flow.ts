/**
 * 下一步条 r4 · 后半程 S13–S29 的"思路 + 示例 + 允许意图"（plan-r4-suggest §4）。
 * 写法同 suggest-guide-talk.ts：示例里的公司、家数、选项是占位，模型必须换成状态里和这一轮里的真东西。
 * target 写法：start_card picked|all；propose_batch next|公司名（顿号分隔）；open_deck / ask_primary 写事的种类
 * （登录 / 缺信息 / 没填成 / 过目 / 选择）或公司名；ask_choose 写选项原文；open 写 live|resume|jobs|dossier:公司|resume:tailored。
 */
import type { SceneGuide } from './suggest-guide-types';
import type { SceneId } from './suggest-scene';

const S13: SceneGuide = {
  anchor: 'strict',
  text: '底下是一张勾选表，默认勾了几家等他点头。他不想一家家看，只想放心地一次定。卡上已有「投这 N 家」「先不投」，别撞。四格：一格按默认勾的家数和公司名确认（start_card picked，写出家数和一两家名字）；一格全投（start_card all，写总家数）；一格调整：他刚说了条件（"外包不要""只要国企"）就回应那句，否则换一批（propose_batch）；一格退出"这批先放着，我去忙"（dismiss_card）。',
  intents: ['start_card', 'propose_batch', 'dismiss_card', 'say'],
  examples: [
    ['就这 5 家，先投招商、平安|start_card|picked', '全投，18 家都投|start_card|all', '换一批|propose_batch', '这批先放着，我去忙|dismiss_card'],
    ['去掉外包的，其余都投|say', '就这 5 家|start_card|picked', '只投国企银行那几家|say', '这批先放着|dismiss_card'],
    ['就这 3 家，美的、格力先投|start_card|picked', '12 家全投|start_card|all', '再加几家深圳的|say', '先放着，晚上再看|dismiss_card'],
  ],
};

const S14: SceneGuide = {
  anchor: 'strict',
  text: '后台正在一家家填，他可能来问进度或只是看一眼。他想知道"在动、没卡住"，然后去忙。他若问进度（"投到哪了"），第一格用状态里的真数字答（今天投出、在填、排队几家）。其余：一格把备好的都投出（有过目的事→ask_primary 过目）；一格看正在填的那家（open live，点名公司）；一格此刻用得上的起头（有登录又没连手机→连手机）；一格退出"我先去忙，你接着投"。',
  intents: ['ask_primary', 'open', 'start_feature', 'say'],
  examples: [
    ['备好的 3 家都投出|ask_primary|过目', '把招商银行那份给我看看|open|live', '连上手机自动收验证码|start_feature|phone_link', '我先去忙，你接着投|say'],
    ['今天投出 4 家了对吧|say', '看正在投的几家|open|live', '排队的 6 家今天能投完吗|say', '我先去忙，你接着投|say'],
    ['海康那份卡住了吗|open|live', '备好的 2 家先投出|ask_primary|过目', '开放题写了什么|start_feature|open_q', '你接着投，我晚上看|say'],
  ],
};

const S15: SceneGuide = {
  anchor: 'strict',
  text: '有几家要他登录或输验证码才能接着填。他嫌烦，想一次处理完。四格：一格去处理（open_deck 登录，点名等他登录的公司和家数）；一格"扫好了，接着填"（他刚说处理完了就放第一）；一格没连手机时连手机自动收验证码，已连就"验证码没收到，再发一次"；一格退出。他若说"没收到验证码"，第一格"再发一次"。',
  intents: ['open_deck', 'say', 'start_feature'],
  examples: [
    ['先处理华为、字节要登录的|open_deck|登录', '扫好了，接着填|say', '连上手机自动收验证码|start_feature|phone_link', '我先去忙|say'],
    ['验证码没收到，再发一次|say', '先处理顺丰要登录的|open_deck|登录', '这家不登了，跳过|say', '我先去忙，稍后登|say'],
  ],
};

const S16: SceneGuide = {
  anchor: 'strict',
  text: '有几家缺同一项信息（证件号、期望薪资、照片、毕业时间…）卡着。他想填一次、所有家一起放行。按状态里缺的那一项换字。四格：一格填并放行（open_deck 缺信息，写"填 X，N 家一起放行"）；一格这项没有怎么办（"空着""写面议"）；一格这批先不填这项；一格回应他对这一项的顾虑（证件号→安全吗；照片→去哪传；薪资→按当地应届填）。',
  intents: ['open_deck', 'say'],
  examples: [
    ['填证件号码，20 家一起放行|open_deck|缺信息', '这项我没有，空着|say', '这批先不填证件号|say', '我的身份证号安全吗|say'],
    ['填期望薪资，8 家一起放行|open_deck|缺信息', '写面议|say', '按当地应届平均填|say', '这项空着行吗|say'],
    ['补上证件照，5 家一起放行|open_deck|缺信息', '照片去哪传|say', '先用学生证上那张|say', '这批先不填照片|say'],
  ],
};

const S17: SceneGuide = {
  anchor: 'strict',
  text: '有几家没填成。他想知道是不是自己的问题、还要不要管。小芽说了原因就针对原因（"验证码过期了""网站改版"）。四格：一格再试（ask_primary 没填成，写家数）；一格问清哪一步没过去，或针对原因给办法；一格放弃这几家（点名或写家数）；一格退出。不说"一定能成"。',
  intents: ['ask_primary', 'say'],
  examples: [
    ['再试一次这 3 家|ask_primary|没填成', '哪一步没过去|say', '这 3 家不投了|say', '我先去忙|say'],
    ['验证码过期就再发|say', '再试一次中兴那家|ask_primary|没填成', '网站打不开就算了|say', '有事再叫我|say'],
  ],
};

const S18: SceneGuide = {
  anchor: 'strict',
  text: '有几家已经填好、停在提交前等他过目。他想确认没出错再投，但不想一份份细看。四格：一格都投出（ask_primary 过目，写家数）；一格先看一眼某家再投（open_deck 过目，点名）；一格有开放题→"开放题先给我看看"，否则问附件用的哪份；一格退出"今天先到这"。他若问"开放题写了什么"，第一格就是去看。',
  intents: ['ask_primary', 'open_deck', 'say'],
  examples: [
    ['备好的 3 家都投出|ask_primary|过目', '看一眼招商银行那份就投|open_deck|过目', '开放题先给我看看|open_deck|过目', '今天先到这|say'],
    ['先看开放题写了什么|open_deck|过目', '7 家都投出|ask_primary|过目', '附件用的哪一版简历|say', '我先去忙，晚上投|say'],
  ],
};

const S19: SceneGuide = {
  anchor: 'strict',
  text: '网页上有一道题要他选（选项原文在状态的等他里）。他拿不准哪个对自己有利。两格照抄选项原文（选择题→ask_choose，target 写选项原文；可加「选」字，不改意思）；一格"按最常见的选"或问哪个对我有利；一格先看题（open_deck 选择）。不替他做有后果的决定（调剂、服从分配）而不让他看到选项。',
  intents: ['ask_choose', 'open_deck', 'say'],
  examples: [
    ['选「接受调剂」|ask_choose|接受调剂', '选「不接受」|ask_choose|不接受', '按最常见的选|say', '先看题是什么|open_deck|选择'],
    ['选「深圳」|ask_choose|深圳', '选「全国均可」|ask_choose|全国均可', '哪个更容易过筛|say', '先看题是什么|open_deck|选择'],
  ],
};

const S20: SceneGuide = {
  anchor: 'strict',
  text: '三天内有笔试或测评，或他刚提到。他慌、想知道考什么、怕来不及。按他这句变：问"考什么"→答往年题型（点名公司）；说"怕来不及"→先练几道（exam_practice:公司）；说"明天考"→考时截图搜题（exam_search）；说"是性格测评"→要不要装。一格起头，两格回应他这句，一格收尾"考完我来说结果"。公司用状态里三天内截止的那家。',
  intents: ['start_feature', 'say'],
  examples: [
    ['考的时候截图给你搜题|start_feature|exam_search', '先练几道字节的题|start_feature|exam_practice:字节', '字节往年考行测还是专业|say', '考完跟你说结果|say'],
    ['性格测评要不要装|say', '按真实想法答就行吗|say', '考的时候截图给你搜题|start_feature|exam_search', '测评完告诉你|say'],
    ['先练几道美团的题|start_feature|exam_practice:美团', '美团笔试几点开始|say', '编程题我不会怎么办|say', '考完跟你说结果|say'],
  ],
};

const S21: SceneGuide = {
  anchor: 'loose',
  text: '三天内有面试，或底下是面试准备卡。他紧张，最怕被问穿简历。一格起头（没准备卡→interview_prep:公司；有准备卡→interview_probe:公司模拟一遍）；一格针对他这句的担心直接问（"自我介绍要多长""会问实习细节吗""怕问 SQL"）；一格预测深挖（interview_predict:公司）或备自我介绍；一格"面完我来复盘"。公司用状态里那场面试的公司，没有公司就不写"这家"。',
  intents: ['start_feature', 'say'],
  examples: [
    ['帮我准备字节这场面试|start_feature|interview_prep:字节', '字节会深挖我简历哪里|start_feature|interview_predict:字节', '一分钟自我介绍先备一版|start_feature|self_intro', '面完我来复盘|say'],
    ['SQL 常考哪几类题|say', '来一遍字节的模拟面试|start_feature|interview_probe:字节', '实习那段会被追问吗|say', '面完我来复盘|say'],
    ['帮我准备中金这场|start_feature|interview_prep:中金', '群面要注意什么|say', '自我介绍要多长|say', '面完我来复盘|say'],
  ],
};

const S22: SceneGuide = {
  anchor: 'loose',
  text: '他刚面完。脑子乱、记不全，想知道还有没有戏。推导式帮他把面试说出来，点到他提的公司和轮次（"字节二面"）：最卡的那题、记不全了、面试官的反应（带空）、下一场怎么改。他已说结果（"挂了""过了"）就第一格接结果（"挂在哪一题""下一轮什么时候"）。挂了可以给"接着投别的"。',
  intents: ['say', 'fill', 'start_feature', 'propose_batch'],
  examples: [
    ['先说字节二面最卡的那题|say', '问了什么我记不全了|say', '面试官当时反应：|fill', '下一场怎么改|say'],
    ['挂在哪一题你帮我看|say', '问到实习细节我答不上|say', '还有机会补救吗|say', '接着投别的|propose_batch|next'],
    ['过了，三面什么时候|say', '帮我把这场复盘一下|start_feature|interview_retro:京东', '算法题没写完：|fill', '三面怎么准备|say'],
  ],
};

const S23: SceneGuide = {
  anchor: 'strict',
  text: '他手上有 Offer。他怕选错、怕错过期限，也可能在骑驴找马（这很正常，不替他拒）。一格 Offer 对比（start_feature offer）；两格他在意什么，点名他提到的公司（钱 / 城市 / 成长 / 户口）；一格接着投别的（propose_batch）。他说了期限（"3 天内答复"），第一格是怎么争取多几天的说法；期限当真对待。',
  intents: ['start_feature', 'say', 'propose_batch'],
  examples: [
    ['两家 Offer 列出来比|start_feature|offer', '我更在意钱|say', '我更在意城市和离家|say', '先接着投别的|propose_batch|next'],
    ['怎么跟美团说再等几天|say', '字节那边能催一下吗|say', '两家列出来比|start_feature|offer', '先答应美团再看|say'],
    ['小米给的户口重要吗|say', '三方先别签吧|say', '列出来比一下|start_feature|offer', '接着投几家大厂|propose_batch|next'],
  ],
};

const S24: SceneGuide = {
  anchor: 'loose',
  text: '近来拒信多，或他刚说了丧气话。站在他一边，不逼不劝不灌鸡汤。他若具体说了（"字节都挂了""投 30 家没面试"），第一格接那句，用他的数和公司。其余：一格看数（funnel）；一格换方向或换一类公司试试；一格歇两天；一格接着投（propose_batch）。不说"一定会好"。',
  intents: ['say', 'start_feature', 'propose_batch'],
  examples: [
    ['看我这个月的数|start_feature|funnel', '换个方向试试|start_feature|direction_explore', '先不投了，歇两天|say', '接着投，别管了|propose_batch|next'],
    ['30 家都没回，简历有问题吗|say', '看我这个月的数|start_feature|funnel', '换几家小公司试试|say', '歇两天再说|say'],
    ['大厂先放放|say', '投点国企试试|propose_batch|next', '是我面试不行吗|say', '今天先不想了|say'],
  ],
};

const S25: SceneGuide = {
  anchor: 'strict',
  text: '他问了一句进度或某家有没有戏，小芽答完了。答完他想顺手办点什么，或回到刚才在做的事。一格点名他问的那家（open dossier:公司）；一格追问他可能还想知道的（"泡 20 天还有戏吗""要不要发邮件问"）；一格顺势推进（再投几家别的，或回到刚才在做的那件事，说出是哪件）；一格退出。',
  intents: ['open', 'propose_batch', 'say'],
  examples: [
    ['帮我看看字节这份|open|dossier:字节', '那再投几家别的|propose_batch|next', '泡 20 天一般还有戏吗|say', '今天先到这|say'],
    ['网易那份投了多久了|open|dossier:网易', '要不要发邮件问问|say', '接着把开放题填完|say', '我先去忙|say'],
  ],
};

const S26: SceneGuide = {
  anchor: 'loose',
  text: '他问"你能做什么"。他不会自己探索，要的是此刻就用得上的几件事，点了就开始。四格全是起头，按他所处的阶段挑：还没简历→简历拖进来 / 口述一段 / 邮箱接过来 / 方向；在挑方向→评估岗位 / 查公司 / 方向 / 邮箱；在投→再投一批 / 看进展 / 笔试搜题 / 自我介绍。他问得具体（"能帮我搜题吗"）第一格就是那个。能点名公司就点名。',
  intents: ['start_feature', 'say'],
  examples: [
    ['再投一批|start_feature|batch', '看正在投的几家|start_feature|live', '考试时截图给你搜题|start_feature|exam_search', '一分钟自我介绍先备一版|start_feature|self_intro'],
    ['有简历，我拖进来|say', '先口述一段实习|say', '手投过的从邮箱接过来|start_feature|mail_bind', '看看哪些方向适合我|start_feature|direction_explore'],
    ['丢个岗位给你看值不值|start_feature|job_evaluate', '查查宁德时代靠谱吗|start_feature|company_research:宁德时代', '看看哪些方向适合我|start_feature|direction_explore', '手投过的从邮箱接过来|start_feature|mail_bind'],
  ],
};

const S27: SceneGuide = {
  anchor: 'strict',
  text: '他隔了一阵才回来，有几件事在等他。他想一眼知道"错过什么没有、先干哪件"。一格从最急的开始（open_deck）；一格点名最大的那件（"先处理华为要登录的""先看开放题写了什么"）；一格问这几天的结果（投出几家、有没有回音，用状态里的数）；一格退出"我先忙，等下处理"。',
  intents: ['open_deck', 'say', 'ask_primary'],
  examples: [
    ['从最急的开始|open_deck', '先看开放题写了什么|open_deck|过目', '这几天投出了几家|say', '我先忙，等下处理|say'],
    ['先处理顺丰要登录的|open_deck|登录', '备好的 4 家都投出|ask_primary|过目', '有公司回我了吗|say', '晚上再处理|say'],
  ],
};

const S28: SceneGuide = {
  anchor: 'loose',
  text: '有简历，但库里没有合他条件的岗位。他会以为是自己不行。小芽说了原因（"北京财务岗都截止了"）第一格回应原因。其余：一格放宽条件（他说过城市就"城市不限了"或加一城）；一格改方向（带空，或让小芽推荐）；一格自己丢岗位来评估（job_evaluate）；一格"有新岗位进来叫我"。',
  intents: ['say', 'fill', 'start_feature'],
  examples: [
    ['城市不限了|say', '方向改成：|fill', '丢个岗位给你看值不值|start_feature|job_evaluate', '有新岗位进来叫我|say'],
    ['北京没有就看天津|say', '春招还有财务岗吗|say', '还有哪些方向适合我|start_feature|direction_explore', '有新岗位进来叫我|say'],
  ],
};

const S29: SceneGuide = {
  anchor: 'strict',
  text: '没判出具体幕。至少一格直接回小芽这句：小芽问了就给两种不同答法，没问就给最顺的下一句。一格按阶段推进（下一批有岗位→propose_batch 点名；有等他的事→open_deck 点名）；一格此刻相关的起头（查公司、评估岗位、搜题…点名公司）；一格"我想问点别的："。',
  intents: ['say', 'fill', 'propose_batch', 'open_deck', 'open', 'start_feature'],
  examples: [
    ['先投平安、美的这 2 家|propose_batch|平安、美的', '平安那份我先看看|open|dossier:平安', '先看平安靠谱吗|start_feature|company_research:平安', '我想问点别的：|fill'],
    ['好，就按你说的来|say', '先处理小米要登录的|open_deck|登录', '查查小米加班多吗|start_feature|company_research:小米', '我想问点别的：|fill'],
  ],
};

export const GUIDES: Readonly<Partial<Record<SceneId, SceneGuide>>> = {
  S13, S14, S15, S16, S17, S18, S19, S20, S21, S22, S23, S24, S25, S26, S27, S28, S29,
};
/** 交叉契约里的导出名（plan-r4 §6），与 GUIDES 同一份。 */
export const GUIDES_FLOW = GUIDES;
