---
name: interview-retro
description: 真实面试记录与复盘：题型诊断、轮次判定、受控标签、归档、跨场分析；证据与推断分开，不预测结果。
triggers: 面试复盘,面完了,今天面试了,这场面得怎么样,面经,复盘,面试记录
---

# 目标
把一场真实面试从面试官的位置重看一遍：逐题诊断、读信号、归档到面试库，样本足够时做跨场分析。区分证据与推断，不预测结果。

# 输入
面试记录（转录稿、笔记或口述回忆）、本场信息（公司代号、公司性质、岗位、轮次、面试官身份、校招 / 社招 / 实习、语言、时长）、结果状态、用户主观感受（单独一栏）、历史档案（可选）。

# 步骤
1. 取证：按材料完整度决定问多少；遇到"大概讲了下项目"这类概括追问一次原话，记不清的题标【材料不足，无法诊断】。不做录音转录。
2. 读参考：企业性质一本（references/企业-*）+ 岗位一本（references/岗位-*）+ 题型诊断 + 轮次判定。专业内容对错由岗位层定，过程信号由企业性质层定，考察深度由轮次层定；本场材料压过一切通例。
3. 逐题标注：题型（九类）→ 这一问要确认什么 → 用户原话 → 内容轨 / 表达轨问题；标签只能取自 references/标签词表，带命名空间前缀。项目深挖题写明卡在第几层。英文面把 language: 与 content: 分开记。
4. 读信号：先判追问性质（probe:clarify / verify / counterfactual / challenge / guide / routine），guide 与 routine 不计丢分；每条解读按"可观察事实 / 一种可能的解释 / 其他可能"三层写。
5. 归档：按 references/归档格式写入面试库；同一岗位方向满 3 场才做跨场归纳，不满写"样本不足，暂不归纳"。

# 结果状态规则
result 取 none | rejected | advanced | no_feedback_inferred；result_source 取 none | official | inferred。没有官方反馈时只能标 none 或 no_feedback_inferred（result_source 为 inferred），禁止编造拒绝原因。用户问"我过了吗"：只列明确加分项、明确问号和本技能观察不到的因素，不给概率。

# 输出
```json
{
  "session":{"company_code":"","company_type":"","role":"","round":"","interviewer_role_guess":"","track":"campus|social|intern","language":"","duration_min":0,"result":"none|rejected|advanced|no_feedback_inferred","result_source":"none|official|inferred"},
  "questions":[{"type":"","intent":"","quote":"","content_tags":[],"delivery_tags":[],"language_tags":[],"stuck_layer":0,"interviewer_doubt":{"evidence":"","alternative":""}}],
  "signals":[{"tag":"","fact":"","interpretation":"","alternative":""}],
  "focus_this_round":"",
  "next_round_probes":[],
  "retakes":[{"question":"","answer":"","needs_verification":[]}],
  "todo":{"facts":[],"delivery":[]},
  "unobservable":[],
  "cross_session":{"enabled":false,"note":""}
}
```

# 约束
- 证据与推断分开，每条推断附至少一种其他解释；不用"说明 / 一定 / 肯定"。
- 重答只用用户说过的事实，缺的标【需核实】。
- 感受栏只做对照，不推翻证据。
- 不做群面、不给法律意见；敏感提问（婚育、户籍等）只描述现状，不认可其正当性。
