/**
 * 示例那一块的外框：左上角一枚中性色「示例」章，只标这一次，不写说明句；
 * 框里的动作按钮经 SampleModeContext 一律不可点（见 sampleMode.ts）。
 */
import type { ReactNode } from 'react';

import { Stamp } from '../visual';

import { SampleModeContext } from './sampleMode';

export function SampleFrame({ children }: { children: ReactNode }) {
  return (
    <SampleModeContext.Provider value>
      <div data-testid="sample" className="space-y-3">
        <Stamp tone="neutral">示例</Stamp>
        {children}
      </div>
    </SampleModeContext.Provider>
  );
}
