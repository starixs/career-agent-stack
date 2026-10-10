/**
 * 简历：先是汇总页（每一份简历的最新成品缩略图），点开一份进入编辑页（内容 / 版式，左改右看）。
 * 素材面「简历」视图与聊天旁的简历侧栏共用；侧栏按助理给的 id 直接打开那一份。
 */
import { useState } from 'react';

import { ResumeGallery } from '@/components/resume-workbench/ResumeGallery';
import { ResumeWorkbench } from '@/components/resume-workbench/ResumeWorkbench';

export default function CareerResume({ embedded = false, initialResumeId = null }: {
  embedded?: boolean;
  /** 打开时直接进入的简历（聊天旁侧栏按助理给的 id 定位；换 id 时由调用方用 key 重挂）。 */
  initialResumeId?: string | null;
  /** 兼容旧调用：编辑页始终双栏，按宽度收窄左栏。 */
  compact?: boolean;
} = {}) {
  const [openId, setOpenId] = useState<string | null>(initialResumeId);
  return (
    <div className={embedded ? 'h-full min-h-[560px]' : 'h-full'}>
      {openId
        ? <ResumeWorkbench resumeId={openId} onBack={() => setOpenId(null)} />
        : <ResumeGallery onOpen={setOpenId} />}
    </div>
  );
}
