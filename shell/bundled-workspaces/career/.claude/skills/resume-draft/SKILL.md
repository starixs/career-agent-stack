---
name: resume-draft
description: 从经历库起草主简历：只用已确认主张与用户给出的基本信息，按简历 schema 输出完整 JSON，缺的信息列成待补清单。
triggers: 生成主简历,生成简历,写简历,做一份简历,起草简历,建简历,新建简历,简历底稿,主简历
---

# 目标
把经历库里已确认的主张整理成一份可编辑的主简历（母版），作为后续按岗位定制的底稿。主简历求全不求精：把能写的都写进去，取舍留给定制阶段。

# 输入
用户基本信息（姓名、电话、邮箱、城市、求职意向等，可能缺项）、用户口述的教育背景、经历库中 status 为 user_confirmed 或 verified 的主张（带经历标题、机构、角色、起止时间）、求职方向（可选）。

# 步骤
1. 基本信息只搬运，不补全：用户没给的字段留空字符串，不猜电话、邮箱、城市。输入里形如 `{{vault:profile.name}}` 的占位符是私密信息库的引用，原样放进对应字段，不要替换、不要拆开；经历里的 `{{vault:exp.xxx.yyy}}` 同理。
2. 教育背景只来自用户明确说过的学校、学历、专业、时间；GPA 与课程没说就不写。
3. 按经历类型分区：实习、全职进 experience；课程项目、竞赛、个人实践进 projects；学生工作、志愿经历进 custom_sections（标题按素材取名，如"校园与志愿"）。
4. 每条 bullet 由一条或几条主张改写而成，公式＝动作 + 落地方式 + 量化结果；数字只能来自主张的 result_metric 或正文，没有数字就不写数字。每条 bullet 所属条目的 claim_ids 必须填上来源主张 id。
5. 技能分组只收主张里实际出现过的工具与方法，按"熟练 / 掌握 / 了解"分级时没有依据就留空 level。
6. 排雷：不写"赋能、深耕、抓手"类虚词，不以"我"开头，不写备考中的证书，不拆开罗列 Office。
7. 时间统一写成"2024.07"格式，进行中的写"至今"。

# 输出
只输出一个 JSON 对象：
```json
{
  "resume": {
    "version": 1,
    "basics": {"name":"","phone":"","email":"","city":"","objective":"","target_cities":[],"expected_salary":"","links":[]},
    "education": [{"school":"","degree":"","major":"","start":"","end":"","gpa":"","courses":[],"bullets":[],"claim_ids":[]}],
    "experience": [{"org":"","position":"","department":"","location":"","start":"","end":"","bullets":[],"claim_ids":[]}],
    "projects": [{"name":"","role":"","org":"","start":"","end":"","link":"","bullets":[],"claim_ids":[]}],
    "skills": [{"name":"","level":"","keywords":[],"claim_ids":[]}],
    "awards": [],
    "certifications": [],
    "custom_sections": [{"title":"","items":[{"title":"","subtitle":"","date":"","bullets":[],"claim_ids":[]}]}]
  },
  "used_claim_ids": [],
  "missing": [{"field":"basics.phone","why":"用户未提供"}],
  "notes": ""
}
```
没有素材的分区输出空数组，不写"暂无"。missing 列出用户需要补的信息，供助理追问。

# 约束
- 只用已确认主张；pending 主张不进简历，哪怕用户刚口头提到也要先确认。
- 不编造公司、项目、工具、数据、名次；主张没有量化结果就写定性结果，不估一个数。
- 不改用户给出的姓名、学校、时间，不润色成更高的学历或职级。
- 经历库为空时仍输出结构完整的 JSON（分区为空数组），并在 notes 说明需要先补充经历。
