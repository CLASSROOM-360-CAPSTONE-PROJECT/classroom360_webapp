/** Turns a database or network error into a sentence a person can act on. */
export function friendlyError(err: unknown, fallback = 'The change was not saved.'): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!msg) return fallback
  if (msg.includes('no_room_double_booking')) return 'That room is already booked at that time, possibly by another department.'
  if (msg.includes('no_instructor_double_booking')) return 'That instructor already teaches at that time.'
  if (msg.includes('no_cohort_double_booking')) return 'That student block already has a class at that time.'
  if (msg.includes('no_room_double_request') || msg.includes('no_instructor_double_request'))
    return 'That room or instructor is already taken by an approved request at that time.'
  if (msg.includes('outside school hours')) return 'The school is not open at that time. See School hours.'
  if (msg.includes('duplicate key')) return 'That code is already in use.'
  if (msg.includes('row-level security') || msg.includes('permission denied')) return 'You are not allowed to do that.'
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Could not reach the server. Check your connection and try again.'
  return msg
}

/** True when the error is one of the three double-booking guards. */
export function isDoubleBooking(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : ''
  return /no_(room|instructor|cohort)_double_booking/.test(msg)
}
