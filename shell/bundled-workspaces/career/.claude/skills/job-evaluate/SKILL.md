---
name: job-evaluate
description: 岗位硬约束预筛 + 五维评分 + 临界分复核，输出可解释的投递建议，用户决定投不投。
triggers: 值不值得投,评估岗位,匹配度,打分,这个岗位适合我吗,筛岗位,岗位评估
---

# 目标
对一个岗位做硬约束预筛与五维评分，给出可解释的投递建议；投不投由用户决定。

# 输入
JdParsed、求职偏好（目标城市、方向、可到岗时间、每周天数、薪资底线、明确排除的行业或公司类型）、经历库已确认主张、可选的公司调研结论（traffic_light）。

# 步骤
1. 硬约束预筛（任一 fail 即停止评分）：学历 / 专业 / 届别、地点、到岗时间与每周天数、证书或必备工具、用户排除项、公司调研红灯。JD 未写明的项标 unverified，不当作通过。
2. 五维评分（0–100）：技能匹配 30%、经历匹配 25%（按工作性质而非职位名）、方向契合 20%、公司与文化适配 15%（含调研信号）、成长与可达性 10%（竞争强度、是否明显越级）。
3. 加权总分 → verdict：75 以上 strong、60–74 good、45–59 moderate、30–44 weak、30 以下 poor。
4. 临界分复核：总分落在阈值 ±5 内，或某一维低于 40 但总分不低于 60 时，重新逐条核对 keywords.missing 与硬性门槛是否被低估，写明复核后是否改判及原因。
5. 列出投递前需要用户确认的事项（如"JD 未写工作地点""每周天数待确认"）。

# 输出
```json
{
  "prefilter":{"pass":true,"checks":[{"item":"","status":"pass|fail|unverified","evidence":""}]},
  "score":{"skills":0,"experience":0,"direction":0,"culture":0,"growth":0,"total":0},
  "reasons":[{"dimension":"","reason":"","evidence":""}],
  "verdict":"strong|good|moderate|weak|poor|prefilter_fail",
  "review":{"triggered":false,"note":""},
  "ask_user":[]
}
```

# 约束
- 每个分数都要有 reasons 里可追溯的依据；没有证据的维度给 50 并写"资料不足"。
- 不预测录用概率；verdict 是建议，不替用户决定。
- 经历库为空时，技能与经历两维标"资料不足"，不给高分；不因 JD 写得好就加分。
