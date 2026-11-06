import { beforeEach, describe, expect, it } from 'vitest';

import { recordProgress, resetWorkSurfaces, useWorkSurfaces } from './workSurfaceStore';
import { renderHook } from '@testing-library/react';

const trail = () => renderHook(() => useWorkSurfaces()).result.current.runs[0]?.trail?.map(t => `${t.stage}:${t.kind}×${t.count}`);
const ev = (stage: string, kind: string | undefined, phase = 'apply_batch') => ({ runId: 'run_1', application_id: 'a1', phase, message: `${stage}-${kind}`, stage, ...(kind ? { kind } : {}) });

describe('每一环里做过哪几类事（链路往下分的那一小枝，2026-11-06）', () => {
  beforeEach(() => { resetWorkSurfaces(); });

  it('按第一次出现的先后记，同一环里同一类事只记一条、带次数；提交没报类别也算一类', () => {
    for (const e of [ev('tailor', 'resume'), ev('open', 'navigate'), ev('open', 'entry'), ev('fill', 'page'), ev('fill', 'field'), ev('fill', 'field'), ev('fill', 'field'), ev('send', undefined, 'submit')]) recordProgress(e);
    expect(trail()).toEqual(['tailor:resume×1', 'open:navigate×1', 'open:entry×1', 'fill:page×1', 'fill:field×3', 'send:submit×1']);
  });

  it('同一份重头再来（链路回到前面的环）：从头记，不把上一趟的留在枝上', () => {
    for (const e of [ev('open', 'navigate'), ev('fill', 'field'), ev('tailor', 'resume'), ev('open', 'navigate')]) recordProgress(e);
    expect(trail()).toEqual(['tailor:resume×1', 'open:navigate×1']);
  });
});
