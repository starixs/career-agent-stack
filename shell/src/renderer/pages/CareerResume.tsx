/**
 * 简历：resume-studio 风格的简历工作台（内容编辑 / 实时排版预览 / 模板与设计 / 导出）。
 * 素材面「简历」视图与聊天旁的简历抽屉共用；版本（主简历 / 岗位版）在工作台顶栏切换。
 */
import { ResumeWorkbench } from '@/components/resume-workbench/ResumeWorkbench';

export default function CareerResume({ embedded = false, initialResumeId = null }: {
  embedded?: boolean;
  /** 打开时先选中的简历（聊天旁抽屉按助理给的 id 定位；换 id 时由调用方用 key 重挂）。 */
  initialResumeId?: string | null;
  /** 兼容旧调用：工作台自己按宽度切换三栏 / 标签页。 */
  compact?: boolean;
} = {}) {
  return (
    <div className={embedded ? 'h-[calc(100vh-11rem)] min-h-[560px]' : 'h-full'}>
      <ResumeWorkbench initialResumeId={initialResumeId} />
    </div>
  );
}
