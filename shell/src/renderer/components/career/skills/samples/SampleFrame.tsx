/**
 * 第一次打开时预设那一块的外框：不写「示例」二字、不加章（2026-11-06 用户：「把示例两个字删掉」），
 * 只把框里的动作按钮经 SampleModeContext 一律变成不可点（见 sampleMode.ts）。
 */
import type { ReactNode } from 'react';

import { SampleModeContext } from './sampleMode';

export function SampleFrame({ children }: { children: ReactNode }) {
  return (
    <SampleModeContext.Provider value>
      <div data-testid="sample" className="space-y-3">{children}</div>
    </SampleModeContext.Provider>
  );
}
