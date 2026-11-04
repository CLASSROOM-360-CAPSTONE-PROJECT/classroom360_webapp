import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCourses, type CourseContext } from '../src/lib/import/courses.ts'
import { resolveInstructors, type InstructorRef } from '../src/lib/import/classes.ts'
import { lineList } from '../src/lib/import/columns.ts'
import { tableFromCsv } from '../src/lib/import/readTable.ts'
import { parseActive, parseFloor, parseRooms, parseRoomTypes, parseSeats, type RoomContext } from '../src/lib/import/rooms.ts'
import { classesTemplateCsv, coursesTemplateCsv, roomsTemplateCsv } from '../src/lib/import/template.ts'
import { parseTeachingLoad, type ImportRow } from '../src/lib/import/teachingLoad.ts'

const LRC = { id: 'b-lrc', code: 'LRC', name: 'Learning Resource Center' }
const SCI = { id: 'b-sci', code: 'SCI', name: 'Science Building' }
const roomCtx = (over: Partial<RoomContext> = {}): RoomContext => ({ buildings: [LRC, SCI], existingCodes: [], defaultBuildingId: null, ...over })

const SCITE = { id: 'd-scite', code: 'SCITE', name: 'School of Computing, Information Technology and Engineering' }
const OTHER = { id: 'd-other', code: 'OTH', name: 'Another Department' }
const courseCtx = (over: Partial<CourseContext> = {}): CourseContext => ({
  departments: [SCITE, OTHER],
  allowedDepartmentIds: null,
  defaultDepartmentId: null,
  existingCodes: [],
  knownRoomTypes: ['computer_lab', 'chemistry_lab', 'gym', 'electronics_lab'],
  ...over,
})

const csv = (text: string) => tableFromCsv(text.trim() + '\n')
const errors = (r: { issues: Array<{ level: string; message: string; row: number }> }) => r.issues.filter((i) => i.level === 'error')
const warnings = (r: { issues: Array<{ level: string; message: string; row: number }> }) => r.issues.filter((i) => i.level === 'warning')

describe('room cells', () => {
  it('reads floors the way people write them', () => {
    assert.equal(parseFloor('3'), 3)
    assert.equal(parseFloor('3rd'), 3)
    assert.equal(parseFloor('3rd floor'), 3)
    assert.equal(parseFloor('3F'), 3)
    assert.equal(parseFloor('3/F'), 3)
    assert.equal(parseFloor('Ground'), 1)
    assert.equal(parseFloor('GF'), 1)
    assert.equal(parseFloor('B1'), -1)
    assert.equal(parseFloor('-2'), -2)
    assert.equal(parseFloor('top'), null)
    assert.equal(parseFloor('3.5'), null)
    assert.equal(parseFloor(''), null)
  })

  it('reads seats as whole numbers', () => {
    assert.equal(parseSeats('40'), 40)
    assert.equal(parseSeats('40 seats'), 40)
    assert.equal(parseSeats(' 35 pax '), 35)
    assert.equal(parseSeats('forty'), null)
    assert.equal(parseSeats('40.5'), null)
    assert.equal(parseSeats('-4'), null)
  })

  it('reads in-service answers', () => {
    assert.equal(parseActive('Yes'), true)
    assert.equal(parseActive('In service'), true)
    assert.equal(parseActive('Active'), true)
    assert.equal(parseActive('No'), false)
    assert.equal(parseActive('Out of service'), false)
    assert.equal(parseActive('under repair'), false)
    assert.equal(parseActive('maybe'), null)
  })

  it('turns room types into the database spelling and drops "lecture room"', () => {
    assert.deepEqual(parseRoomTypes('Computer Laboratory'), ['computer_lab'])
    assert.deepEqual(parseRoomTypes('Computer Laboratory; Electronics Lab'), ['computer_lab', 'electronics_lab'])
    assert.deepEqual(parseRoomTypes('Chemistry Lab / Physics Lab'), ['chemistry_lab', 'physics_lab'])
    assert.deepEqual(parseRoomTypes('Lecture room'), [])
    assert.deepEqual(parseRoomTypes('Standard'), [])
    assert.deepEqual(parseRoomTypes('N/A'), [])
    assert.deepEqual(parseRoomTypes(''), [])
    assert.deepEqual(parseRoomTypes('Gym, gym'), ['gym'])
  })
})

describe('rooms file', () => {
  it('reads the template without a single problem', async () => {
    const r = parseRooms(await tableFromCsv(roomsTemplateCsv()), roomCtx())
    assert.deepEqual(r.issues.filter((i) => i.level !== 'info'), [])
    assert.equal(r.rows.length, 4)
    const lab = r.rows.find((x) => x.code === 'LRC-307')!
    assert.deepEqual(lab.facilities, ['computer_lab', 'electronics_lab'])
    assert.equal(lab.capacity, 35)
    assert.equal(lab.floor, 3)
    assert.equal(lab.building.id, 'b-lrc')
    assert.equal(r.rows.find((x) => x.code === 'LRC-308')!.is_active, false)
    assert.equal(r.rows.find((x) => x.code === 'LRC-305')!.is_active, true)
    assert.deepEqual(r.rows[0]!.facilities, [])
  })

  it('understands other wordings of the titles and finds titles below a heading', async () => {
    const t = await csv(`
Rooms of the Science Building,,,
,,,
Room No.,Room Name,Bldg,Capacity,Facilities
SCI-201,Lab 201,Science Building,30,Chemistry Laboratory
SCI-202,Room 202,sci,45,
`)
    const r = parseRooms(t, roomCtx())
    assert.deepEqual(errors(r), [])
    assert.equal(r.rows.length, 2)
    assert.equal(r.rows[0]!.building.id, 'b-sci') // matched by name
    assert.equal(r.rows[1]!.building.id, 'b-sci') // matched by code, any case
    assert.equal(r.rows[0]!.row, 4)
    assert.deepEqual(r.rows[0]!.facilities, ['chemistry_lab'])
  })

  it('uses the chosen building when the file names none, and says so when there is none to use', async () => {
    const t = await csv(`
Room Code,Seats
LRC-401,40
LRC-402,35
`)
    const without = parseRooms(t, roomCtx())
    assert.equal(without.rows.length, 0)
    assert.match(errors(without)[0]!.message, /which building/)
    const withDefault = parseRooms(t, roomCtx({ defaultBuildingId: 'b-lrc' }))
    assert.deepEqual(errors(withDefault), [])
    assert.deepEqual(withDefault.rows.map((x) => x.building.code), ['LRC', 'LRC'])
    // no floor column: floor 1 and a note
    assert.ok(withDefault.issues.some((i) => i.level === 'info' && /floor 1/.test(i.message)))
  })

  it('fills a blank building cell from the chosen building, and rejects an unknown building', async () => {
    const t = await csv(`
Room Code,Building,Seats
A-1,,30
A-2,Annex,30
A-3,SCI,30
`)
    const r = parseRooms(t, roomCtx({ defaultBuildingId: 'b-lrc' }))
    assert.deepEqual(r.rows.map((x) => [x.code, x.building.code]), [['A-1', 'LRC'], ['A-3', 'SCI']])
    const e = errors(r)
    assert.equal(e.length, 1)
    assert.equal(e[0]!.row, 3)
    assert.match(e[0]!.message, /"Annex" is not in the system.*LRC, SCI/)
    // with no building chosen the blank cell is a problem of its own
    const none = parseRooms(t, roomCtx())
    assert.ok(errors(none).some((i) => i.row === 2 && /building is missing/.test(i.message)))
  })

  it('leaves out rooms that already exist, whatever their case, and does not call that an error', async () => {
    const t = await csv(`
Room Code,Building,Seats
lrc-301,LRC,40
LRC-302,LRC,40
LRC-310,LRC,40
`)
    const r = parseRooms(t, roomCtx({ existingCodes: ['LRC-301', 'LRC-302'] }))
    assert.deepEqual(errors(r), [])
    assert.deepEqual(r.rows.map((x) => x.code), ['LRC-310'])
    assert.equal(r.skipped, 2)
    assert.match(warnings(r)[0]!.message, /2 rooms are already in the system.*lrc-301, LRC-302/)
  })

  it('refuses a code that is on two lines of the file', async () => {
    const t = await csv(`
Room Code,Building,Seats
LRC-500,LRC,40
lrc-500,LRC,30
`)
    const r = parseRooms(t, roomCtx())
    assert.equal(r.rows.length, 1)
    assert.match(errors(r)[0]!.message, /already on line 2 of this file/)
    assert.equal(errors(r)[0]!.row, 3)
  })

  it('checks seats, floor and in-service the way the Add room form does', async () => {
    const t = await csv(`
Room Code,Building,Floor,Seats,In Service
R1,LRC,3,0,Yes
R2,LRC,3,2001,Yes
R3,LRC,3,abc,Yes
R4,LRC,3,,Yes
R5,LRC,top,40,Yes
R6,LRC,3,40,perhaps
R7,LRC,101,40,Yes
R8,LRC,3,40,Yes
`)
    const r = parseRooms(t, roomCtx())
    assert.deepEqual(r.rows.map((x) => x.code), ['R8'])
    assert.deepEqual(errors(r).map((e) => e.row), [2, 3, 4, 5, 6, 7, 8])
    assert.match(errors(r)[3]!.message, /seats is missing/)
    assert.match(errors(r)[4]!.message, /not a floor/)
    assert.match(errors(r)[5]!.message, /not a status/)
  })

  it('uses the code as the name when there is none, with one note for all of them', async () => {
    const t = await csv(`
Room Code,Name,Building,Seats
A-1,,LRC,40
A-2,Named room,LRC,40
A-3,,LRC,40
`)
    const r = parseRooms(t, roomCtx())
    assert.deepEqual(r.rows.map((x) => x.name), ['A-1', 'Named room', 'A-3'])
    const notes = r.issues.filter((i) => /no name/.test(i.message))
    assert.equal(notes.length, 1)
    assert.match(notes[0]!.message, /2 rooms have no name.*lines 2 and 4/)
  })

  it('says what is missing instead of guessing', async () => {
    assert.match(errors(parseRooms(await csv('Room Code,Name\nA-1,Room'), roomCtx()))[0]!.message, /no column for: Seats/)
    assert.match(errors(parseRooms(await csv('Name,Seats\nRoom,40'), roomCtx()))[0]!.message, /no column for: Room code/)
    assert.match(errors(parseRooms(await csv('Foo,Bar\n1,2'), roomCtx()))[0]!.message, /Could not find the column titles/)
    assert.match(errors(parseRooms(await csv('Room Code,Seats'), roomCtx()))[0]!.message, /no lines of data/)
    assert.deepEqual(parseRooms([], roomCtx()).rows, [])
  })

  it('stops at 1000 rooms', async () => {
    const lines = ['Room Code,Building,Seats', ...Array.from({ length: 1001 }, (_, i) => `R-${i},LRC,30`)]
    const r = parseRooms(await csv(lines.join('\n')), roomCtx())
    assert.equal(r.rows.length, 0)
    assert.match(errors(r)[0]!.message, /1001 rooms.*at most 1000/)
    const ok = parseRooms(await csv(lines.slice(0, 1001).join('\n')), roomCtx())
    assert.equal(ok.rows.length, 1000)
  })

  it('reads a semicolon-separated file saved by a European-settings Excel, with a byte-order mark', async () => {
    const t = await tableFromCsv('﻿Room Code;Building;Seats;Room Types\nLRC-601;LRC;40;Computer Laboratory\n')
    const r = parseRooms(t, roomCtx())
    assert.deepEqual(errors(r), [])
    assert.deepEqual(r.rows[0]!.facilities, ['computer_lab'])
  })
})

describe('courses file', () => {
  it('reads the template without a single problem', async () => {
    const r = parseCourses(await tableFromCsv(coursesTemplateCsv()), courseCtx())
    assert.deepEqual(r.issues.filter((i) => i.level === 'error' || i.level === 'warning'), [])
    assert.equal(r.rows.length, 4)
    const ds = r.rows.find((x) => x.code === 'IT 211')!
    assert.equal(ds.lecture_units, 2)
    assert.equal(ds.lab_units, 1)
    assert.equal(ds.room_type, 'computer_lab')
    assert.equal(ds.department?.code, 'SCITE')
    assert.equal(r.rows.find((x) => x.code === 'CHEM 101')!.department, null)
    // blank departments get one note
    assert.ok(r.issues.some((i) => /2 courses have no department/.test(i.message)))
  })

  it('puts lines with no department in the chosen one', async () => {
    const r = parseCourses(await tableFromCsv(coursesTemplateCsv()), courseCtx({ defaultDepartmentId: 'd-other' }))
    assert.equal(r.rows.find((x) => x.code === 'CHEM 101')!.department?.code, 'OTH')
    assert.equal(r.rows.find((x) => x.code === 'IT 101')!.department?.code, 'SCITE')
  })

  it('reads other wordings, units as 2/1, a total only, and a department by name', async () => {
    const t = await csv(`
Subject Code,Subject Title,Lec/Lab,Dept
MATH 1,Calculus,3/0,Another Department
PHY 1,Physics,2/1,SCITE
`)
    const r = parseCourses(t, courseCtx())
    assert.deepEqual(errors(r), [])
    assert.deepEqual(r.rows.map((x) => [x.code, x.lecture_units, x.lab_units, x.department?.code]), [['MATH 1', 3, 0, 'OTH'], ['PHY 1', 2, 1, 'SCITE']])

    const total = parseCourses(await csv('Code,Title,Units\nENG 1,English,3\n'), courseCtx())
    assert.deepEqual(total.rows.map((x) => [x.lecture_units, x.lab_units]), [[3, 0]])
    assert.ok(total.issues.some((i) => i.level === 'info' && /only a total Units column/.test(i.message)))
  })

  it('applies the Add course checks to units', async () => {
    const t = await csv(`
Course Code,Course Title,Lecture Units,Lab Units
A 1,Fine,3,0
A 2,Too many,13,0
A 3,Nothing,0,0
A 4,Quarter,2.25,0
A 5,Text,three,0
A 6,Half,1.5,1
`)
    const r = parseCourses(t, courseCtx())
    assert.deepEqual(r.rows.map((x) => x.code), ['A 1', 'A 6'])
    assert.deepEqual(errors(r).map((e) => e.row), [3, 4, 5, 6])
    assert.match(errors(r)[0]!.message, /most is 12/)
    assert.match(errors(r)[1]!.message, /no lecture or laboratory units/)
    assert.match(errors(r)[2]!.message, /one decimal/)
    assert.match(errors(r)[3]!.message, /not a number of lecture units/)
  })

  it('warns when Units disagrees with lecture + lab', async () => {
    const r = parseCourses(await csv('Course Code,Course Title,Lecture Units,Lab Units,Units\nB 1,Mismatch,2,1,4\n'), courseCtx())
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0]!.lecture_units + r.rows[0]!.lab_units, 3)
    assert.match(warnings(r)[0]!.message, /Units is 4 but lecture \+ lab units add up to 3/)
  })

  it('needs a title, a code and a department that exists', async () => {
    const t = await csv(`
Course Code,Course Title,Department,Units
C 1,,SCITE,3
,No code,SCITE,3
C 3,Unknown dept,XYZ,3
C 4,Fine,SCITE,3
`)
    const r = parseCourses(t, courseCtx())
    assert.deepEqual(r.rows.map((x) => x.code), ['C 4'])
    assert.match(errors(r)[0]!.message, /title is missing/)
    assert.match(errors(r)[1]!.message, /code is missing/)
    assert.match(errors(r)[2]!.message, /department "XYZ" is not in the system.*SCITE, OTH/)
  })

  it('keeps a program chair to their own department', async () => {
    const chair = courseCtx({ allowedDepartmentIds: ['d-scite'], defaultDepartmentId: 'd-scite' })
    const t = await csv(`
Course Code,Course Title,Department,Units
D 1,Mine,SCITE,3
D 2,Theirs,OTH,3
D 3,Unspecified,,3
`)
    const r = parseCourses(t, chair)
    assert.deepEqual(r.rows.map((x) => [x.code, x.department?.code]), [['D 1', 'SCITE'], ['D 3', 'SCITE']])
    assert.match(errors(r)[0]!.message, /your own department only, and OTH is not it/)
    // a chair with no department of their own can add nothing
    const none = parseCourses(t, courseCtx({ allowedDepartmentIds: [], defaultDepartmentId: null }))
    assert.equal(none.rows.length, 0)
    assert.equal(errors(none).length, 3)
  })

  it('leaves out courses already in the catalog and refuses a code that appears twice', async () => {
    const t = await csv(`
Course Code,Course Title,Units
it 101,Existing in another case,3
IT 102,New,3
IT 102,Again,3
`)
    const r = parseCourses(t, courseCtx({ existingCodes: ['IT 101'] }))
    assert.deepEqual(r.rows.map((x) => x.code), ['IT 102'])
    assert.equal(r.skipped, 1)
    assert.match(warnings(r)[0]!.message, /1 course is already in the catalog and was left out: IT 101/)
    assert.match(errors(r)[0]!.message, /already on line 3/)
  })

  it('warns once about a room type no room has', async () => {
    const t = await csv(`
Course Code,Course Title,Units,Room Type
E 1,Pharmacy A,3,Pharmacy Laboratory
E 2,Pharmacy B,3,Pharmacy Lab
E 3,Computing,3,Computer Laboratory
E 4,Lecture,3,Lecture room
`)
    const r = parseCourses(t, courseCtx())
    assert.deepEqual(errors(r), [])
    assert.equal(r.rows.length, 4)
    assert.equal(r.rows[0]!.room_type, 'pharmacy_lab')
    assert.equal(r.rows[2]!.room_type, 'computer_lab')
    assert.equal(r.rows[3]!.room_type, null)
    const w = warnings(r)
    assert.equal(w.length, 1)
    assert.match(w[0]!.message, /No room has the type "Pharmacy Laboratory" yet \(lines 2 and 3\)/)
  })

  it('needs the three columns that matter', async () => {
    assert.match(errors(parseCourses(await csv('Course Code,Course Title,Department\nX,Y,Z'), courseCtx()))[0]!.message, /no column for: Units/)
    assert.match(errors(parseCourses(await csv('Course Code,Units,Department\nX,3,Z'), courseCtx()))[0]!.message, /no column for: Course title/)
    assert.match(errors(parseCourses(await csv('Foo,Bar\n1,2'), courseCtx()))[0]!.message, /Could not find the column titles/)
  })
})

describe('classes file', () => {
  const classesTable = async (text: string) => csv(text)
  const people: InstructorRef[] = [
    { id: 'i1', full_name: 'Juan Dela Cruz', employee_no: 'E-101', email: 'juan@school.edu', is_active: true },
    { id: 'i2', full_name: 'Maria  Santos', employee_no: null, email: null, is_active: true },
    { id: 'i3', full_name: 'Pedro Reyes', employee_no: null, email: null, is_active: false },
    { id: 'i4', full_name: 'Ana Lim', employee_no: 'E-201', email: null, is_active: true },
    { id: 'i5', full_name: 'Ana Lim', employee_no: 'E-202', email: null, is_active: true },
  ]
  const row = (n: number, instructor: ImportRow['instructor']): ImportRow => ({
    row: n,
    instructor,
    course: { code: 'IT 1', lecture_units: 3, lab_units: 0 },
    program: 'BSIT',
    year: 1,
    section: 'A',
  })

  it('reads the template with no Instructor details at all', async () => {
    const p = parseTeachingLoad(await tableFromCsv(classesTemplateCsv()), { classesOnly: true })
    assert.deepEqual(p.issues.filter((i) => i.level === 'error'), [])
    assert.equal(p.rows.length, 4)
    assert.equal(p.rows[0]!.instructor.name, 'Juan Dela Cruz')
    assert.equal(p.rows[2]!.instructor.name, '')
  })

  it('does not need an Instructor column, but the teaching-load import still does', async () => {
    const t = await classesTable(`
Course Code,Lecture Units,Program,Year,Section
IT 1,3,BSIT,1,A
`)
    const p = parseTeachingLoad(t, { classesOnly: true })
    assert.deepEqual(p.issues.filter((i) => i.level === 'error'), [])
    assert.equal(p.rows.length, 1)
    assert.equal(p.rows[0]!.instructor.name, '')
    const strict = parseTeachingLoad(t)
    assert.match(strict.issues[0]!.message, /no column for: Instructor/)
  })

  it('ignores instructor details instead of reading or complaining about them', async () => {
    const t = await classesTable(`
Instructor,Employee No,Employment,Max Weekly Hours,Work Hours,Course Code,Lecture Units,Program,Year,Section
Juan Dela Cruz,E-101,whenever,1000,gibberish,IT 1,3,BSIT,1,A
`)
    const loose = parseTeachingLoad(t, { classesOnly: true })
    assert.deepEqual(loose.issues.filter((i) => i.level === 'error'), [])
    assert.deepEqual(loose.rows[0]!.instructor, { name: 'Juan Dela Cruz', employee_no: 'E-101' })
    assert.ok(loose.issues.some((i) => i.level === 'info' && /Ignored here: Employment, Max Weekly Hours, Work Hours/.test(i.message)))
    // the full import still checks them
    assert.ok(parseTeachingLoad(t).issues.some((i) => i.level === 'error' && /employment type/.test(i.message)))
  })

  it('gives each line the instructor already in the system and nothing else', () => {
    const out = resolveInstructors(
      [row(2, { name: 'juan   dela cruz' }), row(3, { name: 'Maria Santos' }), row(4, { name: 'J. Cruz', employee_no: 'E-101' }), row(5, { name: 'Someone', email: 'JUAN@school.edu' })],
      people,
    )
    assert.equal(out.assigned, 4)
    assert.deepEqual(out.issues, [])
    // the database is given the instructor's own name and numbers, so it picks exactly that person and changes nothing
    assert.deepEqual(out.rows[0]!.instructor, { name: 'Juan Dela Cruz', employee_no: 'E-101', email: 'juan@school.edu' })
    assert.deepEqual(out.rows[1]!.instructor, { name: 'Maria  Santos' })
    assert.equal(out.rows[2]!.instructor.name, 'Juan Dela Cruz')
    assert.equal(out.rows[3]!.instructor.name, 'Juan Dela Cruz')
  })

  it('never lets the database create an instructor: unknown names become unassigned, with one note per name', () => {
    const out = resolveInstructors([row(2, { name: 'Nobody Known' }), row(3, { name: 'nobody known' }), row(4, { name: 'Juan Dela Cruz' }), row(9, { name: 'Other Stranger' })], people)
    assert.equal(out.assigned, 1)
    assert.deepEqual(out.rows.map((r) => r.instructor.name), ['', '', 'Juan Dela Cruz', ''])
    assert.equal(out.issues.length, 2)
    assert.match(out.issues[0]!.message, /"Nobody Known" is not in the system \(lines 2 and 3\)/)
    assert.match(out.issues[1]!.message, /"Other Stranger".*line 9/)
    for (const i of out.issues) assert.equal(i.level, 'warning')
  })

  it('treats a blank instructor as a plain unassigned class, with no note', () => {
    const out = resolveInstructors([row(2, { name: '' })], people)
    assert.equal(out.assigned, 0)
    assert.deepEqual(out.issues, [])
    assert.equal(out.rows[0]!.instructor.name, '')
  })

  it('does not give a class to an inactive instructor or guess between two people with one name', () => {
    const out = resolveInstructors([row(2, { name: 'Pedro Reyes' }), row(3, { name: 'Ana Lim' }), row(4, { name: 'Ana Lim', employee_no: 'E-202' })], people)
    assert.deepEqual(out.rows.map((r) => r.instructor.name), ['', '', 'Ana Lim'])
    assert.equal(out.rows[2]!.instructor.employee_no, 'E-202')
    assert.ok(out.issues.some((i) => /"Pedro Reyes" is marked inactive/.test(i.message)))
    assert.ok(out.issues.some((i) => /More than one instructor matches "Ana Lim".*employee number/.test(i.message)))
    assert.equal(out.assigned, 1)
  })

  it('does not change the rows it was given', () => {
    const input = [row(2, { name: 'Nobody Known' })]
    resolveInstructors(input, people)
    assert.equal(input[0]!.instructor.name, 'Nobody Known')
  })
})

describe('line lists', () => {
  it('names the lines briefly', () => {
    assert.equal(lineList([4]), 'line 4')
    assert.equal(lineList([4, 9]), 'lines 4 and 9')
    assert.equal(lineList([12, 4, 9]), 'lines 4, 9 and 12')
    assert.equal(lineList([1, 2, 3, 4, 5, 6, 7, 8]), 'lines 1, 2, 3, 4, 5, 6 and 2 more')
    assert.equal(lineList([3, 3]), 'line 3')
  })
})
