import { useId, useState } from 'react'
import { cn } from '@/lib/cn'

/**
 * Form primitives.
 *
 * Every control here is a real labelled form element rather than a styled div,
 * so keyboard navigation, screen-reader naming and browser validation all work
 * without extra wiring. `NumberField` in particular is what makes the
 * composition canvas fully operable without a pointer.
 */

export type FieldProps = {
  label: string
  /** Hide the visible label but keep it for assistive technology. */
  srOnlyLabel?: boolean
  hint?: string
  error?: string | null
  className?: string
  children: (props: { id: string; describedBy: string | undefined }) => React.ReactNode
}

export function Field({ label, srOnlyLabel, hint, error, className, children }: FieldProps) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={id}
        className={cn(
          'text-[11px] font-medium tracking-wide text-ink-400',
          srOnlyLabel && 'sr-only',
        )}
      >
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined })}
      {hint ? (
        <p id={hintId} className="text-[11px] leading-snug text-ink-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[11px] leading-snug text-live-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const inputClass =
  'h-8 w-full rounded-sm border border-deck-600 bg-deck-950 px-2 text-sm text-ink-100 ' +
  'placeholder:text-ink-500 focus:border-accent-500 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Keep an editable local draft that can diverge from the committed value.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * These fields are controlled, and their consumers legitimately reject some
 * intermediate input: the source store ignores an empty name, and the
 * transform layer clamps out-of-range geometry. With a plain controlled input
 * that means the displayed value snaps back mid-edit, so clearing a field and
 * retyping produces nonsense like "CameraHost Camera" — the user can never
 * actually replace a value.
 *
 * Holding a draft while the field is focused lets the user clear it, type a
 * partial value, and have the committed state follow only when the input
 * parses. External changes still win whenever the field is not being edited.
 */
function useDraft<T>(
  value: T,
  format: (value: T) => string,
): {
  display: string
  onInput: (next: string) => void
  onFocus: () => void
  onBlur: () => void
} {
  // `null` means "not editing" — show the committed value.
  const [draft, setDraft] = useState<string | null>(null)

  return {
    display: draft ?? format(value),
    onInput: setDraft,
    onFocus: () => setDraft((current) => current ?? format(value)),
    // On blur the draft is dropped, so the field snaps to whatever the store
    // actually committed. That is the moment the user finds out their value
    // was clamped, which is the right time to tell them.
    onBlur: () => setDraft(null),
  }
}

/* Stable formatters, declared at module scope. */
const textFormat = (value: string): string => value
const numberFormat = (value: number): string => (Number.isFinite(value) ? String(value) : '0')

export type TextFieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  srOnlyLabel?: boolean
  hint?: string
  error?: string | null
  placeholder?: string
  disabled?: boolean
  maxLength?: number
  className?: string
}

export function TextField({
  label,
  value,
  onChange,
  srOnlyLabel,
  hint,
  error,
  placeholder,
  disabled,
  maxLength,
  className,
}: TextFieldProps) {
  const draft = useDraft(value, textFormat)

  return (
    <Field
      label={label}
      srOnlyLabel={srOnlyLabel}
      hint={hint}
      error={error}
      className={className}
    >
      {({ id, describedBy }) => (
        <input
          id={id}
          type="text"
          value={draft.display}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onFocus={draft.onFocus}
          onChange={(event) => {
            const next = event.target.value
            draft.onInput(next)
            // The consumer may reject this (an empty name, for example); the
            // draft keeps the field editable either way.
            onChange(next)
          }}
          onBlur={draft.onBlur}
          className={inputClass}
        />
      )}
    </Field>
  )
}

export type NumberFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Suffix shown inside the field, e.g. "px" or "°". */
  unit?: string
  srOnlyLabel?: boolean
  hint?: string
  disabled?: boolean
  className?: string
}

/**
 * Numeric input with a unit suffix.
 *
 * Empty and partial input ("", "-", "1.") is held as a draft rather than being
 * coerced to 0, so the field can be cleared and retyped. The committed value
 * only moves when the input parses, and the transform layer normalizes again
 * afterwards — so an out-of-range typed or pasted value can never corrupt a
 * composition, it just gets clamped.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  srOnlyLabel,
  hint,
  disabled,
  className,
}: NumberFieldProps) {
  const draft = useDraft(value, numberFormat)

  return (
    <Field label={label} srOnlyLabel={srOnlyLabel} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <div className="relative">
          <input
            id={id}
            // `type="text"` with a numeric input mode: a native number input
            // reports an empty string for "-" and "1.", which makes partial
            // entry impossible to distinguish from a cleared field.
            type="text"
            inputMode="decimal"
            value={draft.display}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            role="spinbutton"
            aria-valuenow={Number.isFinite(value) ? value : undefined}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-describedby={describedBy}
            onFocus={draft.onFocus}
            onChange={(event) => {
              const text = event.target.value
              draft.onInput(text)
              if (text.trim() === '') return
              const next = Number(text)
              if (!Number.isFinite(next)) return
              onChange(next)
            }}
            onBlur={draft.onBlur}
            onKeyDown={(event) => {
              // Arrow keys still step the value, as on a native number input.
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const delta = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? step * 10 : step)
              const current = Number.isFinite(value) ? value : 0
              onChange(current + delta)
              // Step from the committed value, not from a stale draft.
              draft.onInput(numberFormat(current + delta))
            }}
            className={cn(inputClass, unit && 'pr-7', 'font-mono tabular-nums')}
          />
          {unit ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-ink-500"
            >
              {unit}
            </span>
          ) : null}
        </div>
      )}
    </Field>
  )
}

export type SelectFieldProps<T extends string> = {
  label: string
  value: T
  options: Array<{ value: T; label: string; disabled?: boolean }>
  onChange: (value: T) => void
  srOnlyLabel?: boolean
  hint?: string
  disabled?: boolean
  className?: string
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  srOnlyLabel,
  hint,
  disabled,
  className,
}: SelectFieldProps<T>) {
  return (
    <Field label={label} srOnlyLabel={srOnlyLabel} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value as T)}
          className={cn(inputClass, 'cursor-pointer pr-7')}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

export type SliderFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  /** Rendered beside the label, e.g. "-6.0 dB". */
  valueLabel?: string
  /** Spoken value for screen readers when the numeric value is not meaningful. */
  ariaValueText?: string
  disabled?: boolean
  className?: string
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  valueLabel,
  ariaValueText,
  disabled,
  className,
}: SliderFieldProps) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[11px] font-medium tracking-wide text-ink-400">
          {label}
        </label>
        {valueLabel ? (
          <span className="font-mono text-[11px] tabular-nums text-ink-300">{valueLabel}</span>
        ) : null}
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={ariaValueText}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="w-full"
      />
    </div>
  )
}

export type ToggleProps = {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
  className?: string
}

/** A real checkbox, styled. Keyboard and screen-reader behaviour comes free. */
export function Toggle({ label, checked, onChange, hint, disabled, className }: ToggleProps) {
  const id = useId()
  const hintId = useId()
  return (
    <div className={cn('flex gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent-500 disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <label
          htmlFor={id}
          className={cn(
            'block cursor-pointer text-xs leading-snug text-ink-200',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="mt-0.5 text-[11px] leading-snug text-ink-500">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
}
