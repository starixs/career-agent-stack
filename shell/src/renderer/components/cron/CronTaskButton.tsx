// Composer schedule/goal button.
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface CronTaskButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
}

export default function CronTaskButton({ onClick, isActive = false, disabled = false }: CronTaskButtonProps) {
  const { t } = useTranslation('chat');

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 items-center justify-center rounded-full border transition focus:ring-2 focus:outline-none ${
        isActive
          ? 'border-[var(--success)] bg-[var(--success-bg)] text-[var(--success)] hover:bg-[var(--success-bg)] focus:ring-[var(--success)]'
          : 'border-[var(--line)] bg-[var(--paper)] text-[var(--muted)] hover:bg-[var(--hover)] focus:ring-[var(--line-2)]'
      } disabled:cursor-not-allowed disabled:opacity-50`}
      title={isActive ? t('composer.cronEnabled') : t('composer.cron')}
    >
      <Timer className="h-4 w-4" />
    </button>
  );
}
