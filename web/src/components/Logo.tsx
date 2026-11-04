import { cn } from '@/lib/cn'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#1a2c45" />
      <circle
        cx="16"
        cy="16"
        r="8.5"
        fill="none"
        stroke="#d29a3f"
        strokeWidth="2.5"
        strokeDasharray="42 11"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.6" fill="#d29a3f" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-[-0.01em]">Classroom360</span>
    </span>
  )
}
