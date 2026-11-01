/**
 * 小芽在对话里怎么"说"（主线体验 §6.2）：
 *  - SpeechBlocks：一段话拆成几个短对话块逐块出现，像一个人连发几条，不是一封邮件。
 *  - QuietWorkLine：工具调用和思考过程不进对话（11-02 定），后台在干活时只露一行人话。
 *    细节在右栏「正在做」和日志里，不给用户看。
 */
import Markdown from '@/components/Markdown';
import { getCareerToolLabel } from '@/components/tools/careerToolLabels';
import type { ContentBlock } from '@/types/chat';
import { splitSpeechSegments } from '@/utils/speechSegments';

const SPEECH_BLOCK = 'speech-block ai-message-content w-fit max-w-[85%] rounded-2xl bg-[var(--side)] px-4 py-2.5 text-[var(--ink)] select-text';

export function SpeechBlocks({ text, streaming }: { text: string; streaming: boolean }) {
  const segments = splitSpeechSegments(text);
  return (
    <div className="flex w-full flex-col items-start gap-1.5 px-1 py-0.5" data-testid="speech-blocks">
      {segments.map((segment, index) => (
        <div key={index} className={SPEECH_BLOCK} data-testid="speech-block">
          <Markdown streaming={streaming && index === segments.length - 1}>{segment}</Markdown>
        </div>
      ))}
    </div>
  );
}

/** 一组工具 / 思考块里最后一个工具的人话；不是求职工具就只说"在想"。 */
export function quietWorkLabel(blocks: ContentBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name) {
      return getCareerToolLabel(block.tool.name) ?? '在处理';
    }
  }
  return '在想';
}

export function QuietWorkLine({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-sm text-[var(--muted)]" data-testid="quiet-work-line" aria-live="polite">
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="speech-dot" />
        <span className="speech-dot" />
        <span className="speech-dot" />
      </span>
      <span>{quietWorkLabel(blocks)}</span>
    </div>
  );
}
