---
name: company-research
description: 求职视角的公司研究：主体消歧、七条红线、风险信号、九段报告与人工核实清单。
triggers: 背调,这家公司靠谱吗,公司有没有坑,查公司,公司研究,调研公司,公司怎么样
---

# 目标
从求职视角研究一家公司：先消歧主体，再核验红线与风险信号，产出九段报告和人工核实清单。回答"值不值得投、面试时问什么"，不做投资尽调。

# 输入
公司名（平台简称或工商全称）、招聘信息里的城市 / 地址 / 岗位（用于消歧）、Web Search 结果、用户补充的反证材料。按需加载 references：数据源清单、红线与风险信号、坑点与提问模板。

# 步骤
1. 主体消歧（五策略）：品牌名→工商全称；按招聘城市 / 地址匹配注册主体；按岗位业务线匹配子公司；同名多主体时列候选并请用户按招聘信息确认；仍不确定则红线全部标 unverified。
2. 工商基础：法定代表人、注册资本、成立时间、经营状态。
3. 红线核验（七条）：每条标 hit / clean / unverified；命中必须附可核验来源；需验证码或登录的官方渠道只能标 unverified 并给人工入口。
4. 风险关键词扫描（16 词、8 类）：记录命中数与强信号来源，区分原告 / 被告、历史与近一年。
5. 员工评价：只给平台入口链接，不抓原文。
6. 判灯：任一红线 hit → red；无 hit 但 unverified 多 → yellow；全部 clean 且评价无重大负面 → green。
7. 九段报告：结论速览、主体识别、工商信息、红线核验表、风险信号、员工评价入口、坑点清单（3–5 个，每个带证据与"面试怎么问"）、面试提问清单、manual_required。

# 输出
```json
{
  "entity":{"legal_name":"","brand_names":[],"candidates":[],"confidence":"high|medium|low"},
  "basic":{"legal_rep":"","registered_capital":"","founded":"","status":""},
  "red_lines":[{"id":1,"name":"","status":"hit|clean|unverified","evidence":[{"title":"","url":"","source_level":"official|news|forum|platform"}]}],
  "signals":[{"category":"","keyword":"","hits":0,"strong":[]}],
  "traffic_light":"green|yellow|red",
  "pitfalls":[{"risk":"","evidence":"","ask_in_interview":""}],
  "interview_questions":[],
  "manual_required":[{"item":"","entry_url":"","why":""}],
  "report_md":""
}
```

# 约束
- 未验证不等于无风险：搜索零命中只能写"公开网页无记录"，不能写"干净"。
- 没有证据链接不写命中；证据等级官方公告 > 新闻 > 论坛 > 招聘平台。
- 红线只对招聘主体生效；关联集团风险单列并提示人工判断。
- 不采集个人信息、不抓评价原文；manual_required 必须原样进报告。
