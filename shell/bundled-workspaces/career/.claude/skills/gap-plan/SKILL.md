---
name: gap-plan
description: 岗位要求对照经历库分为已具备/尚缺证据/确实欠缺，用逆向课程设计给出可验收的小任务。
triggers: 差距,补什么,学习计划,提升计划,我还缺什么,怎么补,备战计划,能力差距
---

# 目标
把岗位要求对照经历库，分成 have 已具备 / need_evidence 尚缺证据 / missing 确实欠缺三类，并用逆向课程设计给出可验收的小任务：先定"什么成果能证明掌握"，再排练习。

# 输入
JdParsed（或方向探索给出的典型 JD）、经历库主张与证据、用户每周可投入小时数、截止时间（投递或面试日期）。

# 步骤
1. 逐条对照 hard_requirements 与 keywords：有已确认主张且有证据 → have；做过但主张 pending、无证据或表达不到位 → need_evidence；没做过 → missing。
2. need_evidence 的动作是"补证据"：找回仓库、文档、数据截图，请用户确认主张，把经历改写到位；不是重新学。
3. missing 用逆向设计：先写 deliverable（可展示的成果，如一份带数据的分析报告、一个能跑的小工具、一次完整的活动复盘）和 acceptance（可被第三方检查的验收标准），再拆 steps 与估时。
4. 排优先级：硬性门槛相关 > 高频关键词 > 加分项；受时间约束时先保能在截止前完成的。
5. est_hours 按用户时间预算核算，总量超出预算的任务标 priority 为 low 并在 budget.fits 写 false，让用户取舍。

# 输出
```json
{
  "gaps":{
    "have":[{"requirement":"","claim_id":"","evidence":""}],
    "need_evidence":[{"requirement":"","claim_id":"","what_to_collect":""}],
    "missing":[{"requirement":"","note":""}]
  },
  "actions":[{"title":"","deliverable":"","acceptance":"","est_hours":0,"priority":"high|medium|low","for_requirement":"","steps":[]}],
  "budget":{"weekly_hours":0,"total_hours":0,"deadline":"","fits":true}
}
```

# 约束
- 不把 missing 伪装成 have；真缺失的要求不进简历，只进计划。
- 每个任务必须有可验收的交付物，不写"多了解一下""加强学习"这类无法检查的动作。
- 不承诺完成任务就能通过面试或录用；估时标"估算"。
