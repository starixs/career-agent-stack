/**
 * 求职壳的标题栏不放 keystone 的「恢复上次标签页」胶囊（beta-polish ②）：单一对话产品没有多标签页，
 * 异常退出后对话本来就会接上，这个胶囊只会让学生困惑。keystone 代码保留，按开关不渲染。
 */
export interface TitleBarChrome {
  restorePill: boolean;
}

export const TITLE_BAR_CHROME: TitleBarChrome = {
  restorePill: false,
};
