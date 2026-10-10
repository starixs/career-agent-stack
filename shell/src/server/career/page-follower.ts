/**
 * 现场画面该看哪一页：默认看选中页（引擎 / 用户的焦点页）；网申弹出新标签页（登录、扫码）时跟过去，
 * 直到那一页关掉，或者选中页被换成了别的（说明引擎 / 用户已经去处理别的页面了）。
 * 页面身份用 mainFrame（借用代理每次都是新的 Page 对象），没有 mainFrame 的测试替身用对象本身。
 */
export interface FollowablePage { isClosed(): boolean; mainFrame?(): object }

const identity = (page: FollowablePage): object => (typeof page.mainFrame === 'function' ? page.mainFrame() : page);

export function createPageFollower<P extends FollowablePage>(selected: () => Promise<P>) {
  let followed: P | null = null;
  let selectionAtFollow: object | null = null;
  return {
    /** 新开了一页：记下它和此刻的选中页。 */
    async follow(page: P): Promise<void> {
      followed = page;
      selectionAtFollow = identity(await selected());
    },
    /** 当前该看的页。 */
    async pick(): Promise<P> {
      const sel = await selected();
      if (followed && !followed.isClosed() && selectionAtFollow === identity(sel)) return followed;
      followed = null;
      return sel;
    },
  };
}
