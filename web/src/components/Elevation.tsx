import type { ReactNode } from 'react'

const floorMark = (n: number) => (n < 0 ? `B${-n}` : String(n))

/**
 * Things that belong to rooms, drawn as the buildings the rooms are in: each building a stack of floors, the top floor
 * first, with a dark plate on the left of every floor like the indicator in a lift. `render` draws one thing as a list item.
 */
export function Elevation<T>({
  items,
  building,
  floor,
  render,
  tileMin = 215,
}: {
  items: T[]
  building: (item: T) => string
  floor: (item: T) => number
  render: (item: T) => ReactNode
  /** the narrowest a tile may be, in pixels */
  tileMin?: number
}) {
  const buildings = new Map<string, Map<number, T[]>>()
  for (const it of items) {
    const name = building(it)
    const floors = buildings.get(name) ?? new Map<number, T[]>()
    floors.set(floor(it), [...(floors.get(floor(it)) ?? []), it])
    buildings.set(name, floors)
  }
  return (
    <div className="space-y-6 p-4">
      {[...buildings].map(([name, floors]) => {
        const count = [...floors.values()].reduce((n, l) => n + l.length, 0)
        return (
          <section key={name} aria-label={name}>
            <h3 className="mb-2 flex items-center gap-3 font-display text-[16px] font-semibold">
              {name}
              <span className="h-px flex-1 bg-ink-200" aria-hidden />
              <span className="text-[12.5px] font-normal text-ink-500">{count === 1 ? '1 room' : `${count} rooms`}</span>
            </h3>
            <div className="overflow-hidden rounded-md border border-ink-300 border-t-[3px] border-t-ink-800">
              {[...floors]
                .sort((a, b) => b[0] - a[0])
                .map(([n, list]) => (
                  <div key={n} className="grid grid-cols-[52px_minmax(0,1fr)] border-t border-ink-200 first:border-t-0">
                    <div className="grid place-content-center bg-ink-900 text-center" aria-hidden>
                      <span className="block text-[10.5px] leading-3 text-ink-300">Floor</span>
                      <span className="block font-display text-[24px] font-semibold leading-7 text-brass-300">{floorMark(n)}</span>
                    </div>
                    <ul
                      className="grid items-start gap-3 bg-ink-50/60 p-3"
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }}
                      aria-label={`${name}, floor ${floorMark(n)}`}
                    >
                      {list.map((it) => render(it))}
                    </ul>
                  </div>
                ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
