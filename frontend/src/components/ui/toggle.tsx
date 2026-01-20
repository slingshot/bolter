import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
}: ToggleProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        className={cn(
          'relative shrink-0 w-[21px] h-[12px] rounded-full transition-colors',
          checked ? 'bg-content-primary' : 'bg-border-medium',
          disabled && 'opacity-50 cursor-not-allowed',
          !disabled && 'cursor-pointer'
        )}
      >
        <span
          className={cn(
            'absolute top-[1px] w-[10px] h-[10px] rounded-full bg-background-page transition-transform duration-200 shadow-sm',
            checked ? 'left-[10px]' : 'left-[1px]'
          )}
        />
      </button>
      <label
        className={cn(
          'text-[12px] leading-[1.5] text-content-primary font-medium cursor-pointer select-none',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        onClick={() => !disabled && onCheckedChange(!checked)}
      >
        {label}
      </label>
    </div>
  );
}
