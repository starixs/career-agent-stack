interface MentionTabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export function MentionTabButton({
  label,
  active,
  onClick,
}: MentionTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? 'bg-[var(--paper)] text-[var(--ink)] shadow-sm'
          : 'text-[var(--muted)] hover:bg-[var(--hover)]'
      }`}
    >
      {label}
    </button>
  );
}
