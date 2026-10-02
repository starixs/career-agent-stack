---
name: offer-compare
description: Offer 对比：薪酬拆解、岗位内容与经历匹配、地点与成本、成长与风险，输出对比表与需要用户自己决定的项，不给排序结论。
triggers: 对比offer,比较offer,选哪个,offer怎么选,薪资拆解,要不要接,两个offer
---

# 目标
把多个 Offer 放进同一张表拆解比较，列出事实与差异，把需要价值判断的项交回用户；不给排序结论。

# 输入
每个 Offer：公司、岗位、薪酬结构（base、绩效、签字费、股票或期权、补贴、社保公积金基数与比例、发薪月数）、地点、工作内容、合同主体与用工形式、试用期、回复截止时间；用户经历库与偏好；公司调研结论（可选）。

# 步骤
1. 薪酬拆解：统一口径换算年化现金，确定部分与浮动部分分开；股权类标"未归属、未变现"；社保公积金按基数估算到手差异；缺项写"未知"不估算。
2. 岗位内容与经历匹配：对照已确认主张，写哪些工作用得上现有能力、哪些是新领域。
3. 地点与成本：城市、通勤、房租区间（Web Search 查询并附来源）、落户或户籍要求以官方为准。
4. 成长与风险：团队与汇报线、业务阶段、培训与晋升机制是否有书面说明、调研红黄灯、合同主体 / 外包 / 试用期条款。
5. 列"需要你自己决定的项"：价值权衡（稳定与成长、城市与薪资）、信息缺口（要向 HR 确认的问题）、回复截止冲突。

# 输出
```json
{
  "offers":[{"id":"","company":"","title":"","location":"",
    "comp":{"base_annual":0,"variable_annual":0,"signing":0,"equity_note":"","social_insurance_note":"","cash_total_certain":0,"unknown":[]},
    "content_match":{"uses_existing":[],"new_areas":[]},
    "location_cost":{"rent_range":"","commute":"","sources":[]},
    "growth":[],"risks":[]}],
  "comparison_table":[{"dimension":"","values":{}}],
  "decide_yourself":[{"item":"","why":""}],
  "ask_hr":[{"offer_id":"","question":""}]
}
```

# 约束
- 不给"选 A"的结论，不排序；只呈现差异与权衡项。
- 不编造薪酬、政策、房租数字；外部数据必须带来源，没有就写"未知"。
- 不提供法律意见；合同条款疑问建议咨询专业人士。
- 用户催着要答案时，重复一遍 decide_yourself，不替用户选。
