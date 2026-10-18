---
name: resume-tailor
description: 按 JD 定制简历：三铁律、价值翻译、三档强度，只用已确认主张，输出 JSON Patch 与逐条理由。
triggers: 改简历,定制简历,按JD改,优化简历,简历,一页简历,简历润色
---

# 目标
用经历库里已确认的主张，按目标岗位生成简历修改方案：输出 JSON Patch 与逐条理由，产品会直接应用，不再等用户逐条确认。

# 输入
母版简历 schema、JdParsed、经历库中 status 为 user_confirmed 或 verified 的主张、强度 strength（nudge / keywords / full）、公司性质与岗位类别（按需加载 references：风格库、岗位速查、版式规范）。

# 三条铁律
1. 保真：每个字经得起追问三层；数字只来自已确认主张；职责可重组语言，不能升格。
2. 一页 A4：超页先删弱相关内容（弱相关竞赛 → 校园工作 → 爱好 → 压缩第二行），不缩字号到 10pt 以下。
3. 价值翻译：每条回答"我为什么对你有用"，公式＝动作 + 落地方式 + 量化结果。

# 步骤
1. 排雷：清掉模糊量词（很多 / 大量）、虚词（赋能 / 深耕 / 抓手）、"我"字开头、备考中的证书、拆开罗列的 Office。
2. 价值翻译：动作→业务意义；量化维度任选数量 / 频率 / 规模 / 结果 / 名次 / 覆盖面；一条 bullet 最多命中 1–2 个 JD 关键词。
3. 叠加顺序固定：保真 > 价值翻译 > 岗位能力 > 行业语境 > 公司性质 > JD 关键词 > 版面。
4. 按强度：nudge 只调经历顺序和少量措辞；keywords 在不改事实的前提下对齐 JD 用词并重排；full 重写 bullet、增删区块、按一页预算取舍。
5. 零实习：区块按素材改名，课程项目按实习规格写，不留空区块、不写"暂无"。

# 输出
```json
{
  "strength":"nudge|keywords|full",
  "patch":[{"op":"replace|add|remove|move","path":"/experiences/0/bullets/1","value":"","from":""}],
  "reasons":[{"path":"","reason":"","claim_ids":[],"jd_keywords":[]}],
  "unresolved":[{"need":"","why":""}]
}
```
每条 patch 都要有对应 reasons 并引用 claim_ids；没有已确认主张支撑的改动放 unresolved，提示用户先去经历库补充。

# 约束
- 只用已确认主张，pending 主张不进简历；缺数据标"未知"而不是估一个。
- 不为贴 JD 虚构工具、访谈、项目、实盘业绩；keywords.missing 里的词不写进简历。
- 不改用户基本信息（姓名、学校、时间）；不生成与简历无关的内容。
