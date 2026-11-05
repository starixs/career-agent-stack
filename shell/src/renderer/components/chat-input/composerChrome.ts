/**
 * 求职助理输入框只留回形针（上传文件）、输入框、发送（beta-polish ③，内测前定）。
 *
 * keystone 通用控件的代码不删（face-slim：撤出不等于删代码），按这里的开关不渲染：
 * 学生不该看到「技能 / 定时任务 / 行动模式 / 工具 / token 用量 / 工作区文件」这些开发者概念。
 * 权限模式固定在产品默认（人审提交），auto 只在岗位库的开关里出现。
 *
 * 测试里 keystone 通用行为的用例通过 vi.mock 本模块把开关全部打开来覆盖。
 */
export interface ComposerChrome {
  /** ＋菜单（引用文件 / 使用技能 / 上传文件 / 定时任务）；关掉时只剩一个「上传文件」回形针。 */
  plusMenu: boolean;
  /** 权限模式按钮（会话模式 · 行动 / 规划 / 自主行动 · Agent 设置）。 */
  permissionMode: boolean;
  /** 工具 / MCP / 插件下拉（SimpleChatInput 里叫 TOOL_CONTROLS_VISIBLE，与 face-slim 同名）。 */
  tools: boolean;
  /** context / token 用量圆环。 */
  contextUsage: boolean;
  /** 输入 `/` 弹出命令、输入 `@` 弹出工作区文件。 */
  inlinePickers: boolean;
}

export const COMPOSER_CHROME: ComposerChrome = {
  plusMenu: false,
  permissionMode: false,
  tools: false,
  contextUsage: false,
  inlinePickers: false,
};
