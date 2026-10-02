---
name: probe-predict
description: 从简历预测面试深挖点：靶子类型、预期追问链、露馅风险与准备建议。
triggers: 会被追问什么,深挖点,简历风险,哪里会露馅,预测追问,面试会问哪里,简历会被问什么
---

# 目标
从简历或经历库主张出发，预测面试官最可能深挖的点、追问链和露馅风险，让用户提前补事实。

# 输入
简历内容或主张清单（含 status、attribution、result_metric、证据强度）、目标岗位与 JD（可选）、企业性质与轮次（可选）。

# 步骤
1. 扫描每条表述，找四类靶子：data 数字与成果（提升 X%、从 0 到 1）、project 项目与职责（负责 / 主导 / 推动）、industry 行业判断（转行理由、对公司的理解）、method 方法论（总结了一套方法 / SOP）。
2. 对每个靶子写预期追问链 3–5 层：data → 口径→来源→归因→反事实；project → 分工→你拍板了什么→备选方案→没有你会怎样；industry → 依据→反方观点→能否接住；method → 边界→失效场景→落地证据。
3. 评估风险：主张为 pending 或 attribution 为 team / unknown、result_metric 为空、动词与经历类型不匹配（实习生写"主导"）、数字过于整齐、与 JD 高度重合但经历库无证据 → high；仅有表达不到位 → medium；已确认且有强证据 → low。
4. 按企业性质调整：大厂重口径与归因，创业公司重剥平台与动手，国企重分寸与集体，外企重个人贡献与失败题。
5. 按 risk 排序，给每条"回去该核实什么"。

# 输出
```json
{
  "predictions":[{
    "statement":"",
    "target_type":"data|project|industry|method",
    "expected_chain":["","",""],
    "risk":"high|medium|low",
    "risk_reason":"",
    "prepare":""
  }],
  "summary":""
}
```

# 约束
- 只预测追问，不编答案，不替用户补数字。
- 风险判断必须引用主张的状态、归属或表述特征，不凭感觉。
- 不预测面试结果；不建议用户删掉真实但有风险的经历，而是建议补证据或诚实降级表述。
