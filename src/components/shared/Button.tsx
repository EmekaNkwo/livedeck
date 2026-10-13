import { type VariantProps, cva } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

const button = cva(
  // Flat and square, matching the tool-like VDO.Ninja look rather than a
  // rounded product button.
  'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap ' +
    'transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-400',
  {
    variants: {
      variant: {
        primary: 'bg-accent-500 text-white hover:bg-accent-400',
        secondary: 'bg-deck-700 text-ink-200 hover:bg-deck-600',
        ghost: 'text-ink-300 hover:bg-deck-750 hover:text-ink-100',
        outline: 'border border-deck-600 text-ink-200 hover:border-deck-500 hover:bg-deck-800',
        live: 'bg-live-500 text-white hover:bg-live-400',
        danger: 'bg-deck-700 text-live-400 hover:bg-live-600 hover:text-white',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-11 px-5 text-base',
        // Square icon-only buttons. Each still needs an aria-label.
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
      active: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      // An "active" toggle must not rely on colour alone, so the active state
      // also gains a ring. Callers pair this with aria-pressed.
      {
        active: true,
        variant: 'ghost',
        class: 'bg-accent-500/15 text-accent-400',
      },
      {
        active: true,
        variant: 'secondary',
        class: 'bg-accent-600 text-white',
      },
      {
        active: true,
        variant: 'outline',
        class: 'border-accent-500 bg-accent-500/10 text-accent-400',
      },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', active: false },
  },
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, active, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(button({ variant, size, active }), className)}
      {...props}
    />
  )
})
