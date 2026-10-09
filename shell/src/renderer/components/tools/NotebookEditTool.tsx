import type { NotebookEditInput, ToolUseSimple } from '@/types/chat';

import { ExpandableContainer, FilePath, ToolHeader } from './utils';

interface NotebookEditToolProps {
  tool: ToolUseSimple;
}

export default function NotebookEditTool({ tool }: NotebookEditToolProps) {
  const input = tool.parsedInput as NotebookEditInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const editMode = input.edit_mode || 'replace';
  const cellType = input.cell_type || 'code';

  return (
    <div className="space-y-2">
      {/* Inner header (B2): notebook path + cell + cell type, no tool name */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <FilePath path={input.notebook_path} />
        {input.cell_id && (
          <span className="text-xs text-[var(--muted)]">cell: {input.cell_id}</span>
        )}
        <span className="rounded border border-[var(--info)]/30 bg-[var(--info)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--info)]">
          {cellType}
        </span>
        {editMode === 'delete' && (
          <span className="rounded border border-[var(--danger)]/30 bg-[var(--danger-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--danger)]">
            delete
          </span>
        )}
      </div>

      {editMode !== 'delete' && (
        <ExpandableContainer>
          <pre className="overflow-x-auto rounded bg-[var(--inset)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-2)] select-text">
            {input.new_source || ''}
          </pre>
        </ExpandableContainer>
      )}
    </div>
  );
}
