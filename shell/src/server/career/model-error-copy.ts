/**
 * 求职壳里模型出错时给学生看的话（风险 E#15 / E#16）。
 *
 * 产品用内置的模型额度（构建常量 CAREER_LLM_API_KEY），学生自己充不了值：额度用完不能让他「去充值」。
 * 网关不通（宿舍网络 / 代理）时如实说是我们这边连不上，他的记录都在。
 */
import { getCareerBuildConstants } from '../../shared/career-build-constants';

import { CAREER_QUOTA_COPY } from '../../shared/careerErrorCopy';

export { CAREER_GATEWAY_DOWN_COPY, CAREER_QUOTA_COPY, gatewayDownCopy } from '../../shared/careerErrorCopy';

/** 用的是产品内置的模型额度（求职壳）：这时额度问题学生自己解决不了。 */
export function usesBuiltinCareerKey(): boolean {
  return !!getCareerBuildConstants().llmApiKey;
}

/** 额度用完时的话：求职壳里不提充值；用户自己配的 Key 维持原话。 */
export function quotaCopy(builtin = usesBuiltinCareerKey()): string {
  return builtin ? CAREER_QUOTA_COPY : 'API 余额不足，请充值后重试';
}
