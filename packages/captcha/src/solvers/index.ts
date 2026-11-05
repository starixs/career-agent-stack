import type { CaptchaTarget, SolveResult, SolverDeps } from '../types.js'
import { solveBrowserCheck } from './browser-check.js'
import { solveImageClick } from './image-click.js'
import { solveImageText } from './image-text.js'
import { solveSlider } from './slider.js'
import { solveRotation } from './rotation.js'

/**
 * 求解调度：按验证码种类分流。
 * - slider / image_click / image_text / browser_check：AI 尝试（视觉 + 可信输入）
 * - sms：本包不读取用户消息；交由宿主已授权的短信/邮箱收码通道，未配置时人工
 * - unknown：留给人工，不盲试
 */
export async function solveCaptcha(deps: SolverDeps, target: Pick<CaptchaTarget, 'kind' | 'vendor'>): Promise<SolveResult> {
  switch (target.kind) {
    case 'slider': return solveSlider(deps)
    case 'rotation': return solveRotation(deps)
    case 'image_click': return solveImageClick(deps)
    case 'image_text': return solveImageText(deps)
    case 'browser_check': return solveBrowserCheck(deps)
    case 'sms': return { outcome: 'unsupported', detail: '短信/邮箱验证码需要宿主授权的收码通道，图形求解器不处理', attempts: 0 }
    default: return { outcome: 'unsupported', detail: `未知验证码种类（vendor=${target.vendor}），留给人工`, attempts: 0 }
  }
}
