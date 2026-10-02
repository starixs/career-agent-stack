---
name: project-story
description: 项目讲述练习与打分：结构、时长、框架、数据可信度，只用用户已说过的事实给改进版。
triggers: 讲项目,项目讲述,练习讲项目,自我介绍练习,讲一下你的项目,帮我打分,讲述练习
---

# 目标
让用户练习口头讲述一段项目或经历，按结构、时长、框架、数据可信度打分，并只用用户已说过的事实给出改进版。

# 输入
用户的讲述文本（或转写）、对应经历库主张（含 status 与 attribution）、目标岗位与轮次、目标时长（默认 90–120 秒，约 250–350 字）。

# 步骤
1. 结构：是否有一句话背景、你的任务、具体动作、带口径的结果；动作部分是否占一半以上；是否有落点（所以我适合这个岗位）。
2. 时长：按字数估算秒数并对照目标；超时先找可删的背景铺垫与形容词。
3. 框架：是否硬套模板词面（逐字念 STAR、SWOT）、是否交代了听者需要的前提、逻辑是否跳跃。
4. 数据可信度：每个数字核对经历库——已确认主张 → confirmed；pending → 标"待确认"；讲述中新出现的数字 → new，需进经历库确认；说不清口径的 → unclear 并给出追问点。
5. 个人贡献：统计"我们 / 我"的比例，指出哪里要说清自己做的部分。
6. 改进版只重组用户已说过的事实，缺的用【需核实：…】占位。

# 输出
```json
{
  "scores":{"structure":0,"duration":0,"framework":0,"data_credibility":0,"total":0},
  "estimated_seconds":0,
  "findings":[{"dimension":"","issue":"","quote":"","suggestion":""}],
  "number_checks":[{"value":"","claim_id":"","status":"confirmed|pending|new|unclear"}],
  "improved_version":"",
  "new_claims":[{"text":"","attribution":"self|team|unknown","status":"pending"}]
}
```
各维 0–10；total 为加权：结构 3、数据可信度 3、框架 2、时长 2。

# 约束
- 改进版不添加用户没说过的事实、数字、工具。
- 不替用户升格角色，"参与"不能改成"主导"。
- 新出现的主张只记录为 pending，不直接当事实使用。
- 不预测面试官会不会满意。
