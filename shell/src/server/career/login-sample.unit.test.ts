// @vitest-environment jsdom
/**
 * 登录画面采样（2026-11-03 中国中车）：登上后登录框藏起来但还在页面里——藏着的密码框不算「还要登录」，
 * 看得见的「退出」是登上的证据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hintSampleInPage } from './browse-handoff';

/** jsdom 不排版：带 hidden 的那一支算看不见，其余给个尺寸。 */
function layout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const shown = !this.closest('[hidden]');
    return { width: shown ? 40 : 0, height: shown ? 20 : 0, top: 0, left: 0, right: shown ? 40 : 0, bottom: shown ? 20 : 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe('hintSampleInPage', () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('登上了：登录框藏着（里面有密码框），右上角「你好 xxx 退出」→ 没有密码框、已登录', () => {
    document.body.innerHTML = '<div id="nav"><span>你好，15500001234@163.com</span><a>退出</a></div><div hidden><span>密码登录</span><input type="password"></div><h1>园区智慧运营</h1>';
    layout();
    expect(hintSampleInPage()).toMatchObject({ hasPassword: false, loggedIn: true, loginForm: false });
  });

  it('登录框开着：看得见的密码框，没有「退出」', () => {
    document.body.innerHTML = '<div><span>密码登录</span><input type="password" placeholder="请输入密码"><button>登录</button></div>';
    layout();
    expect(hintSampleInPage()).toMatchObject({ hasPassword: true, loggedIn: false });
  });
});
