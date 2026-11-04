/**
 * How a course's units turn into weekly meetings. This is the same rule as private.meeting_plan in the database,
 * which is what actually creates the sections; it is here so a form can show what will happen before saving.
 *   lecture: 1 unit = 1 hour. Up to 1.5 h is one meeting, up to 4 h two meetings, more three.
 *   lab:     1 unit = 3 hours. One meeting per lab unit (rounded up).
 */
export interface PlanPart {
  component: 'lecture' | 'lab'
  meetings: number
  minutes: number
}

export function meetingPlan(lecture: number, lab: number): PlanPart[] {
  const parts: PlanPart[] = []
  if (lecture > 0) {
    const meetings = lecture <= 1.5 ? 1 : lecture <= 4 ? 2 : 3
    parts.push({ component: 'lecture', meetings, minutes: Math.round((lecture * 60) / meetings) })
  }
  if (lab > 0) {
    const meetings = Math.max(Math.ceil(lab), 1)
    parts.push({ component: 'lab', meetings, minutes: Math.round((lab * 180) / meetings) })
  }
  return parts
}

export function planText(parts: PlanPart[]): string {
  return parts.map((p) => `${p.component === 'lab' ? 'Lab' : 'Lecture'} ${p.meetings} × ${p.minutes} min`).join(' · ')
}

/** Hours of teaching a week for a course: lecture units are hours, lab units are three hours each. */
export const weeklyHours = (lecture: number, lab: number) => lecture + lab * 3
