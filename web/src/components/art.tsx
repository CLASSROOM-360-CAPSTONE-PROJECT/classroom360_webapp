import { cn } from '@/lib/cn'

/*
  Small drawings in the console's own vocabulary: the key rack, the key tag with its punched hole, the ruled
  sheet. They are drawn here, not taken from an icon set, so the empty parts of the console look like part of the
  same place as the rest of it. Colours are the theme's: ink for structure, brass for the key.
*/

const INK_200 = '#cfd8e5'
const INK_300 = '#a9b8cd'
const INK_400 = '#8499b6'
const BRASS = '#d29a3f'

/** An empty hook on a rail, with the outline of the tag that would hang there. */
function Hook() {
  return (
    <svg viewBox="0 0 120 76" className="h-[76px] w-[120px]" aria-hidden>
      <rect x="10" y="8" width="100" height="7" rx="3.5" fill={INK_200} />
      <circle cx="18" cy="11.5" r="1.6" fill={INK_400} />
      <circle cx="102" cy="11.5" r="1.6" fill={INK_400} />
      <path d="M60 15v11a6 6 0 0 0 12 0" fill="none" stroke={BRASS} strokeWidth="3" strokeLinecap="round" />
      <rect x="44" y="38" width="30" height="30" rx="6" fill="none" stroke={INK_300} strokeWidth="1.5" strokeDasharray="4 3" />
      <circle cx="59" cy="46" r="3" fill="none" stroke={INK_300} strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  )
}

/** A week with nothing in it: five columns and the faint outline of a meeting. */
function Week() {
  return (
    <svg viewBox="0 0 120 76" className="h-[76px] w-[120px]" aria-hidden>
      <rect x="10" y="8" width="100" height="60" rx="5" fill="none" stroke={INK_200} strokeWidth="1.5" />
      {[30, 50, 70, 90].map((x) => (
        <line key={x} x1={x} y1="8" x2={x} y2="68" stroke={INK_200} strokeWidth="1" />
      ))}
      {[24, 40, 54].map((y) => (
        <line key={y} x1="10" y1={y} x2="110" y2={y} stroke={INK_200} strokeWidth="1" strokeDasharray="2 3" />
      ))}
      <rect x="53" y="27" width="14" height="22" rx="3" fill="none" stroke={BRASS} strokeWidth="1.5" strokeDasharray="4 3" />
    </svg>
  )
}

/** A ruled sheet with a few lines written and the rest blank. */
function Sheet() {
  return (
    <svg viewBox="0 0 120 76" className="h-[76px] w-[120px]" aria-hidden>
      <rect x="28" y="6" width="64" height="64" rx="5" fill="none" stroke={INK_200} strokeWidth="1.5" />
      <line x1="38" y1="22" x2="82" y2="22" stroke={INK_300} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="34" x2="74" y2="34" stroke={INK_200} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="46" x2="80" y2="46" stroke={INK_200} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="58" x2="62" y2="58" stroke={INK_200} strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" />
      <circle cx="82" cy="58" r="3" fill="none" stroke={BRASS} strokeWidth="1.5" />
    </svg>
  )
}

export type ArtKind = 'hook' | 'week' | 'sheet'

export function EmptyArt({ kind = 'hook', className }: { kind?: ArtKind; className?: string }) {
  return <div className={cn('mx-auto mb-2 w-fit', className)}>{kind === 'week' ? <Week /> : kind === 'sheet' ? <Sheet /> : <Hook />}</div>
}

/**
 * The sign-in page's drawing: a rail of four hooks with a key tag on each, one hook empty because that key is out.
 * The tags settle on their hooks once when the page opens. A dimension line below marks the four rooms, as on a plan.
 */
export function KeyRack({ className }: { className?: string }) {
  const hooks = [
    { x: 56, code: '301', door: 'Door 1' },
    { x: 136, code: '302', door: 'Door 2' },
    { x: 216, code: '303', door: 'Door 3' },
    { x: 296, code: '304', door: 'Door 4' },
  ]
  const out = '303'
  return (
    <svg viewBox="0 0 352 248" className={cn('w-full max-w-[420px]', className)} role="img" aria-label="A rack of four hooks with a key on three of them. The key to room 303 is out.">
      {/* rail */}
      <rect x="14" y="26" width="324" height="12" rx="6" fill="#263d5c" />
      <rect x="14" y="26" width="324" height="3" rx="1.5" fill="#3a5578" />
      <circle cx="26" cy="32" r="2.4" fill="#0b1524" />
      <circle cx="326" cy="32" r="2.4" fill="#0b1524" />

      {hooks.map((h, i) => {
        const gone = h.code === out
        return (
          <g key={h.code}>
            {/* hook */}
            <path d={`M${h.x} 38v12a7 7 0 0 0 14 0`} transform={`translate(${-7} 0)`} fill="none" stroke={gone ? BRASS : INK_400} strokeWidth="3.2" strokeLinecap="round" />
            {gone ? (
              <g>
                <rect x={h.x - 28} y="74" width="56" height="84" rx="9" fill="none" stroke="#d29a3f" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="5 4" />
                <circle cx={h.x} cy="90" r="5" fill="none" stroke="#d29a3f" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
                <text x={h.x} y="128" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="17" fill="#d29a3f" fillOpacity="0.8">
                  {h.code}
                </text>
                <text x={h.x} y="146" textAnchor="middle" fontFamily="IBM Plex Sans, sans-serif" fontSize="10.5" fill="#e3b96a" fillOpacity="0.9">
                  Key out
                </text>
              </g>
            ) : (
              <g className="swing" style={{ animationDelay: `${120 + i * 110}ms` }}>
                <circle cx={h.x} cy="66" r="7" fill="none" stroke={INK_300} strokeWidth="2" />
                <rect x={h.x - 28} y="74" width="56" height="84" rx="9" fill="#1a2c45" stroke="#3a5578" strokeWidth="1.5" />
                <circle cx={h.x} cy="90" r="5" fill="#0b1524" stroke="#5a7396" strokeWidth="1.5" />
                <text x={h.x} y="128" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="17" fontWeight="500" fill="#e6ebf2">
                  {h.code}
                </text>
                <text x={h.x} y="146" textAnchor="middle" fontFamily="IBM Plex Sans, sans-serif" fontSize="10.5" fill="#8499b6">
                  {h.door}
                </text>
              </g>
            )}
          </g>
        )
      })}

      {/* the dimension line of a plan: four rooms on the third floor */}
      <g stroke="#5a7396" strokeWidth="1">
        <line x1="28" y1="196" x2="324" y2="196" />
        <line x1="28" y1="190" x2="28" y2="202" />
        <line x1="324" y1="190" x2="324" y2="202" />
        <line x1="28" y1="196" x2="36" y2="192" />
        <line x1="324" y1="196" x2="316" y2="192" />
      </g>
      <rect x="116" y="186" width="120" height="20" fill="#111f33" />
      <text x="176" y="200" textAnchor="middle" fontFamily="IBM Plex Sans Condensed, IBM Plex Sans, sans-serif" fontSize="13" fontWeight="500" fill="#a9b8cd">
        3rd floor, four rooms
      </text>
    </svg>
  )
}
