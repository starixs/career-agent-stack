---
name: interview-questions
description: 按岗位与 JD 出题：九类题型、追问点、难度、对应 JD 要求，不给标准答案。
triggers: 出题,面试题,高频问题,可能会问什么,面试准备,题库,给我出几道题
---

# 目标
按岗位与 JD 出一组带追问点的面试题，覆盖九类题型，每题标明考察的 JD 要求与追问点，供用户练习或交给模拟面试使用。

# 输入
JdParsed、岗位类别（加载 references 对应手册：开发 / 数据分析 / 产品 / 运营 / 设计 / 市场营销 / 销售 / HR / 财务 / 审计 / 法务 / 战略咨询）、企业性质、轮次、用户经历摘要（可选，用于把题目落到具体经历上）。

# 步骤
1. 从 hard_requirements、responsibilities、keywords 各挑出可被验证的能力点。
2. 按九类题型分配：opening 开场、motivation 动机、history 履历、project 项目深挖、behavioral 行为、business 业务认知、case 案例或半结构化、self 自我认知、reverse 反问。项目深挖与业务认知占比最高；HR 面偏动机、履历、自我认知；终面偏业务认知与案例。
3. 每题用手册里的"高频追问链"写 probe_points（2–4 层），用"专业性检验点"决定 difficulty。
4. 有用户经历时，题目指向具体经历（"你简历里 X 项目的留存口径是什么"）；没有时用通用表述。
5. 按企业性质微调：大厂追口径与归因，创业公司追动手与成本，国企银行追分寸与合规，外企追个人贡献与失败题。
6. 十二类之外的岗位按通用题型出题，并在 coverage_note 注明"无专用手册"。

# 输出
```json
{
  "questions":[{
    "type":"opening|motivation|history|project|behavioral|business|case|self|reverse",
    "question":"",
    "probe_points":["",""],
    "difficulty":"easy|medium|hard",
    "jd_requirement":""
  }],
  "coverage_note":""
}
```
一组 8–15 题；difficulty 分布大致 3:5:2。

# 约束
- 不提供标准答案；probe_points 写面试官要确认什么，不写该怎么答。
- 每道题必须能追溯到 jd_requirement 或用户经历，不出与岗位无关的通用题。
- 开发、法务类题目不判定技术或法律答案的正误。
- 不预测哪些题"一定会考"。
