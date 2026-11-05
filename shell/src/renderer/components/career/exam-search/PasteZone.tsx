/**
 * 粘贴区：一个输入框 + 搜 / 选图片。⌘V 截图、拖进图片、粘贴文字，进来就搜，不用再点按钮（现场答题要快）；
 * 拖图时整页出一层提示，不给输入框再套一层框。
 * 页面在时整页监听粘贴；焦点在输入框里粘贴文字不拦（那是在填公司 / 岗位），粘贴图片照样接住。
 */
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';

import { Button, TextArea } from '../CareerPrimitives';
import type { ScreenshotInput } from './examSearchApi';

/** Retina 截图常有四五千像素宽，缩到这个长边再传，题目文字依然清楚，上传和模型都更快。 */
const MAX_IMAGE_SIDE = 2000;

export async function normalizeScreenshot(blob: Blob): Promise<{ input: ScreenshotInput; preview: string }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持处理图片');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const preview = canvas.toDataURL('image/png');
  return { input: { mediaType: 'image/png', data: preview.slice(preview.indexOf(',') + 1) }, preview };
}

function imageFrom(items: DataTransferItemList | null | undefined): File | null {
  for (const item of Array.from(items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

export function PasteZone({ busy, preview, onImage, onText, onError }: {
  busy: boolean;
  preview: string | null;
  onImage: (file: Blob) => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const handlers = useRef({ onImage, onText });
  useEffect(() => { handlers.current = { onImage, onText }; });

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const image = imageFrom(event.clipboardData?.items);
      if (image) { event.preventDefault(); handlers.current.onImage(image); return; }
      if (isTypingTarget(event.target)) return;
      const pasted = event.clipboardData?.getData('text/plain')?.trim();
      if (pasted) { event.preventDefault(); handlers.current.onText(pasted); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = Array.from(event.dataTransfer.files).find(f => f.type.startsWith('image/'));
    if (file) onImage(file);
    else onError('只能拖图片进来；文字直接粘贴就行');
  };

  const submitText = () => {
    const value = text.trim();
    if (value) onText(value);
  };

  return (
    <div
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="flex items-start gap-3"
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--bg)]/85 font-human text-xl text-[var(--ink)]" aria-hidden>
          松手就搜这张图
        </div>
      )}
      {preview && <img src={preview} alt="这次搜的截图" className="h-20 max-w-[12rem] shrink-0 rounded-md border border-[var(--line)] object-contain" />}
      <TextArea
        aria-label="题目文字" rows={3} value={text} placeholder="截图后 ⌘V，或粘贴题目文字"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitText(); } }}
        className="flex-1"
      />
      <div className="flex shrink-0 flex-col gap-2">
        <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={submitText}>搜</Button>
        <Button variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus className="h-4 w-4" strokeWidth={1.75} />选图片</Button>
      </div>
      <input
        ref={fileInput} type="file" accept="image/*" className="hidden" aria-label="选择题目图片"
        onChange={event => { const file = event.target.files?.[0]; if (file) onImage(file); event.target.value = ''; }}
      />
    </div>
  );
}
