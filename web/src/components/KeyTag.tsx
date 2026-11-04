import { cn } from '@/lib/cn'

type Tone = 'brass' | 'ink' | 'alert'

const tones: Record<Tone, { tag: string; hole: string }> = {
  brass: { tag: 'border-brass-300 bg-brass-100 text-brass-700', hole: 'border-brass-400' },
  ink: { tag: 'border-ink-200 bg-ink-100 text-ink-700', hole: 'border-ink-400' },
  alert: { tag: 'border-rose-200 bg-rose-50 text-rose-700', hole: 'border-rose-400' },
}

/**
 * The room code drawn as a key tag, with the punched hole. It is the one recurring visual
 * motif of the console: a room's tag is brass while its key is out, ink when it sits in the
 * locker, and red when it has not come back.
 */
export function KeyTag({
  code,
  tone = 'ink',
  size = 'sm',
  className,
}: {
  code: string
  tone?: Tone
  size?: 'sm' | 'lg'
  className?: string
}) {
  const t = tones[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-[5px] border font-medium',
        size === 'sm' ? 'gap-1.5 py-0.5 pl-1.5 pr-2 text-[12.5px] leading-5' : 'gap-2 py-1 pl-2.5 pr-3.5 text-[15px] leading-6',
        t.tag,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('shrink-0 rounded-full border bg-white', size === 'sm' ? 'size-[7px]' : 'size-[9px]', t.hole)}
      />
      {code}
    </span>
  )
}
