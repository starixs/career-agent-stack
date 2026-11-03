/**
 * 邮箱授权码的格式规则：渲染端就地提示与服务端校验共用这一份。
 * 长度 16：QQ / 163 / 126 / Gmail 应用专用密码都是 16 位。
 * 163 / 126 新版授权码字母数字混排（2026-10-31 实例测试里真实授权码含数字），所以不能只收字母。
 */
export const AUTH_CODE_LENGTH = 16;

const AUTH_CODE_RE = new RegExp(`^[A-Za-z0-9]{${AUTH_CODE_LENGTH}}$`);

/** 去掉复制时带进来的空格（Gmail 应用专用密码按 4 位一组显示）。 */
export function cleanAuthCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/** 格式不对时给出就地提示；对了返回 null。 */
export function authCodeProblem(raw: string): string | null {
  const code = cleanAuthCode(raw);
  if (code.length !== AUTH_CODE_LENGTH) return `授权码是 ${AUTH_CODE_LENGTH} 位，现在 ${code.length} 位`;
  return AUTH_CODE_RE.test(code) ? null : '授权码只有字母和数字，检查一下有没有多复制了符号';
}
