/**
 * Room types ("facilities"): what a room has that a course may need. They are stored in one spelling,
 * the same one the database uses (private.norm_facility): "Chemistry Laboratory" -> chemistry_lab.
 */
export const ROOM_TYPE_PRESETS = [
  'computer_lab',
  'chemistry_lab',
  'physics_lab',
  'biology_lab',
  'electronics_lab',
  'drafting_room',
  'speech_lab',
  'nursing_skills_lab',
  'gym',
  'auditorium',
]

/** '' when the text holds nothing usable. */
export function normFacility(text: string): string {
  return text
    .toLowerCase()
    .replace(/laboratory/g, 'lab')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 'chemistry_lab' -> 'Chemistry lab' */
export function facilityTitle(f: string): string {
  const s = f.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Several room types written in any style, as the clean list the database keeps. */
export function normFacilities(list: string[]): string[] {
  return [...new Set(list.map(normFacility).filter(Boolean))].sort()
}
