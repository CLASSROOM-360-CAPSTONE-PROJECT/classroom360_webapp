/** The observer's name is remembered in this browser so it does not have to be typed for every trial. */
export const OBSERVER_KEY = 'c360.observer'

export function readObserver(): string {
  try {
    return window.localStorage.getItem(OBSERVER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveObserver(name: string) {
  try {
    window.localStorage.setItem(OBSERVER_KEY, name.trim())
  } catch {
    /* only a convenience */
  }
}
