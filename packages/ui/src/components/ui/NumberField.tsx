import { clsx } from 'clsx';

export interface NumberFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Number input field with label and optional description.
 * Used by BoardSettingsDialog for numeric settings (time intervals, thresholds, etc.)
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  id,
  description,
  disabled,
  className,
}: NumberFieldProps) {
  return (
    <div className={clsx('', className)}>
      <label className="mb-1 block text-xs text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      />
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}