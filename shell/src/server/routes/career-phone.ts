/**
 * 手机连接（蓝牙读短信收验证码）的接口，挂在 `/api/career/*` 下，由 career.ts 的路由表展开：
 * - GET    /api/career/phone              状态 + 已和这台电脑配对过的手机（可一键选用）+ 电脑在蓝牙里的名字
 * - POST   /api/career/phone/pair         开始引导配对（打开系统蓝牙设置，等手机端发起配对）
 * - POST   /api/career/phone/pair/cancel  取消等待
 * - POST   /api/career/phone/bind         选用一台已配对的手机 { address, name }
 * - POST   /api/career/phone/reconnect    重连已记住手机，不改绑定
 * - DELETE /api/career/phone              解除产品记忆（不删除系统配对）
 * 状态变化由服务自己广播 career:data-changed（表名 phone_link），这里不再重复广播。
 */
import type { PhoneLinkService } from '../career/phone/link-service';

import { fail, ok, str, type Json } from './career-http';

export interface PhoneRouteCtx { body: Json }
type Handler = (ctx: PhoneRouteCtx) => Promise<Response> | Response;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 路由定义（method, path, handler），由调用方套上自己的 route()；service 可注入便于测试。 */
export function phoneRoutes(service: () => Promise<PhoneLinkService>): Array<[string, string, Handler]> {
  return [
    ['GET', '/api/career/phone', async () => {
      const s = await service();
      const [phones, computer_name] = await Promise.all([s.binding() ? [] : s.pairedPhones(), s.computerName()]);
      return ok({ status: s.status(), phones, computer_name });
    }],
    ['POST', '/api/career/phone/pair', async () => {
      const s = await service();
      if (!s.status().platform_supported) return fail('手机连接暂只支持 Mac', 400);
      await s.startPairing();
      return ok({ status: s.status() });
    }],
    ['POST', '/api/career/phone/pair/cancel', async () => {
      const s = await service();
      s.cancelPairing();
      return ok({ status: s.status() });
    }],
    ['POST', '/api/career/phone/bind', async ({ body }) => {
      const address = str(body.address);
      if (!address) return fail('address 不能为空');
      const s = await service();
      try {
        await s.bind(address, str(body.name) ?? '');
      } catch (error) {
        console.warn(`[phone-link] 绑定 ${address} 失败:`, errorText(error));
        return fail(`绑定失败：${errorText(error)}`, 500);
      }
      return ok({ status: s.status() });
    }],
    ['POST', '/api/career/phone/reconnect', async () => {
      const s = await service();
      if (!s.binding()) return fail('尚未选择手机', 409);
      await s.reconnect();
      return ok({ status: s.status() });
    }],
    ['DELETE', '/api/career/phone', async () => {
      const s = await service();
      s.unbind();
      return ok({ status: s.status() });
    }],
  ];
}
