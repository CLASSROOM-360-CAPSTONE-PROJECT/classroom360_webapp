import { useCallback, useState } from 'react'

/**
 * Like useState, but remembers the choice in this browser (a view mode, a filter). Storage can be missing or blocked
 * (private windows, blocked site data), so every read and write is guarded and the page works the same without it.
 * `valid` rejects a stored value that no longer means anything, such as a view that was removed.
 */
export function useStoredState<T extends string>(key: string, fallback: T, valid: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = window.localStorage.getItem(key)
      return saved !== null && (valid as readonly string[]).includes(saved) ? (saved as T) : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, next)
      } catch {
        /* the choice just is not remembered */
      }
    },
    [key],
  )
  return [value, set]
}
