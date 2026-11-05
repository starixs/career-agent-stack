/**
 * 求职壳里模型出错时给学生看的话（风险 E#15 / E#16），前后端共用一份。
 *
 * 产品用内置的模型额度，学生自己充不了值：额度用完不能让他「去充值」。
 * 网关不通（宿舍网络 / 代理）时如实说是我们这边连不上，他的记录都在。
 * 其余错误不在这里认，调用方照原样处理（求职壳前端统一说一句「这一步没做成」）。
 */
export const CAREER_QUOTA_COPY = '小芽这边的额度用完了，我们正在处理；你的投递和简历都在';
export const CAREER_GATEWAY_DOWN_COPY = '现在连不上我这边的服务，你的记录都在，稍后再试';

/** 连不上服务（不是对方返回的错误）：DNS、拒绝连接、超时、代理断了。 */
const UNREACHABLE_RX = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|Connection error|socket hang up|network error/i;
/** 额度 / 余额用完：HTTP 402、DeepSeek 的 insufficient balance、中文「余额不足」。 */
const QUOTA_RX = /\b402\b|insufficient[_ ]?balance|余额不足|quota.?exceeded/i;

/** 模型错误原文是「连不上服务」时给的第一句；不是返回 null。 */
export function gatewayDownCopy(rawError: string): string | null {
  return UNREACHABLE_RX.test(rawError) ? CAREER_GATEWAY_DOWN_COPY : null;
}

/** 求职壳里认得出的两类错误给专门的话；认不出返回 null。 */
export function careerErrorCopy(rawError: string): string | null {
  if (QUOTA_RX.test(rawError)) return CAREER_QUOTA_COPY;
  return gatewayDownCopy(rawError);
}
