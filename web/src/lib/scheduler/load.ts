import { supabase } from '../supabase.ts'
import type {
  BuildInput,
  RawBusy,
  RawInstructor,
  RawOwnEntry,
  RawRoom,
  RawSchoolHours,
  RawSection,
  RawUnavailability,
  RawWorkHours,
} from './problem.ts'

async function rows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

type SectionWithCourse = Omit<RawSection, 'course'> & { courses: RawSection['course'] }

/**
 * Everything the generator needs, as the signed-in person is allowed to see it:
 * the programs' sections, the rooms in use, the instructors and their unavailable times,
 * what every department has already booked (schedule_busy), and the programs' own meetings.
 */
export async function loadBuildInput(termId: string, programIds: string[]): Promise<BuildInput> {
  const [sections, rooms, instructors, busy, ownEntries, schoolHours] = await Promise.all([
    rows<SectionWithCourse>(
      supabase
        .from('sections')
        .select(
          'id, code, component, year_level, cohort, program_id, enrollment, instructor_id, meetings_per_week, minutes_per_meeting, courses(code, required_facility, lab_units)',
        )
        .eq('term_id', termId)
        .in('program_id', programIds)
        .order('code'),
    ),
    rows<RawRoom>(supabase.from('rooms').select('id, code, capacity, facilities, is_active').eq('is_active', true).order('code')),
    rows<RawInstructor>(supabase.from('instructors').select('id, full_name, max_weekly_hours, employment_type').eq('is_active', true)),
    rows<RawBusy>(supabase.rpc('schedule_busy', { p_term_id: termId })),
    rows<RawOwnEntry>(
      supabase
        .from('schedule_entries')
        .select('id, section_id, status, day_of_week, is_pinned')
        .eq('term_id', termId)
        .in('program_id', programIds),
    ),
    rows<RawSchoolHours>(supabase.from('school_hours').select('day_of_week, opens_at, closes_at')),
  ])
  const ids = [...new Set(sections.map((s) => s.instructor_id).filter((x): x is string => Boolean(x)))]
  const unavailability = ids.length
    ? await rows<RawUnavailability>(
        supabase.from('instructor_unavailability').select('instructor_id, day_of_week, start_time, end_time').in('instructor_id', ids),
      )
    : []
  const workHours = ids.length
    ? await rows<RawWorkHours>(
        supabase.from('instructor_work_hours').select('instructor_id, day_of_week, start_time, end_time').in('instructor_id', ids),
      )
    : []
  return {
    schoolHours,
    workHours,
    sections: sections.map(({ courses, ...s }) => ({ ...s, course: courses })),
    rooms,
    instructors,
    unavailability,
    busy,
    ownEntries,
  }
}
