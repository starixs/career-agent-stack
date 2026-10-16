/**
 * 我的资料 › 简历。经历库和常用表达不再让用户维护（2026-10-13 会议定）：经历从简历和对话追问里来，
 * 说法由助理在用到时起草并记录，数据和工具都还在，只是不再占一个页面。
 */
import { lazy, Suspense } from 'react';

import { LoadingRow } from '@/components/career/CareerPrimitives';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const CareerResume = lazy(() => import('@/pages/CareerResume'));

export default function CareerMaterial(_props: CareerPageProps) {
  // 简历自带汇总标题和编辑顶栏，不再加页头，免得挤掉预览的高度。
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--ink)]">
      <Suspense fallback={<div className="px-4"><LoadingRow /></div>}>
        <CareerResume embedded />
      </Suspense>
    </div>
  );
}
