/**
 * 宠物身上挂着的截图：缩略图一排，可以去掉某张，截好了一口气发出去。
 * 主窗口和宠物的小面板共用。
 */
import { X } from 'lucide-react';

import { Button } from '../CareerPrimitives';
import type { TrayShot } from './examSearchApi';

export function ShotTray({ shots, busy, onRemove, onSend }: {
  shots: TrayShot[];
  busy: boolean;
  onRemove: (shot: TrayShot) => void;
  onSend: () => void;
}) {
  if (shots.length === 0) return <p className="text-xs text-[var(--muted)]">点一下宠物，框选题目截一张；几张连着的一起发，跨屏的题也能拼上。</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shots.map((shot, i) => (
        <div key={shot.id} className="group relative">
          <img src={shot.thumb} alt={`第 ${i + 1} 张截图`} className="h-14 w-20 rounded-md border border-[var(--line)] object-cover object-top" />
          <button
            type="button" aria-label={`去掉第 ${i + 1} 张`} onClick={() => onRemove(shot)}
            className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-[var(--ink)] p-0.5 text-[var(--paper)] group-hover:block"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ))}
      <Button variant="primary" size="sm" busy={busy} onClick={onSend}>发出去 · {shots.length} 张</Button>
    </div>
  );
}
