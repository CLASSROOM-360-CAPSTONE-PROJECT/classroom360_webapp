/** The example file offered for download on the import dialog. It shows every column the importer understands. */
export const TEMPLATE_HEADERS = [
  'Instructor',
  'Employee No',
  'Email',
  'Employment',
  'Max Weekly Hours',
  'Work Hours',
  'Course Code',
  'Course Title',
  'Lecture Units',
  'Lab Units',
  'Room Type',
  'Program',
  'Year',
  'Section',
  'Students',
]

export const TEMPLATE_ROWS: string[][] = [
  ['Juan Dela Cruz', 'E-101', 'juan.delacruz@school.edu', 'Full-time', '24', 'Mon-Fri 8:00-17:00', 'IT 211', 'Data Structures and Algorithms', '2', '1', 'Computer Laboratory', 'BSIT', '2', 'A', '35'],
  ['Juan Dela Cruz', '', '', '', '', '', 'IT 101', 'Introduction to Computing', '3', '', '', 'BSIT', '1', 'A', '40'],
  ['Maria Santos', 'E-102', 'maria.santos@school.edu', 'Part-time', '12', 'Tue/Thu 13:00-18:00; Sat 8:00-12:00', 'CHEM 101', 'General Chemistry', '3', '1', 'Chemistry Laboratory', 'BSCPE', '1', 'B', '30'],
  ['Maria Santos', '', '', '', '', '', 'MATH 101', 'Calculus 1', '3', '', '', 'BSCPE', '1', 'B', '30'],
]

function quote(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

/** rows of text to CSV */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n'
}

export function templateCsv(): string {
  return toCsv([TEMPLATE_HEADERS, ...TEMPLATE_ROWS])
}

/** the example file on the Rooms import */
export function roomsTemplateCsv(): string {
  return toCsv([
    ['Room Code', 'Name', 'Building', 'Floor', 'Seats', 'Room Types', 'In Service'],
    ['LRC-305', 'Room 305', 'LRC', '3', '40', '', 'Yes'],
    ['LRC-306', 'Chemistry Laboratory 1', 'LRC', '3', '30', 'Chemistry Laboratory', 'Yes'],
    ['LRC-307', 'Computer Laboratory B', 'LRC', '3', '35', 'Computer Laboratory; Electronics Laboratory', 'Yes'],
    ['LRC-308', 'Lecture Room 308', 'LRC', '3', '50', '', 'No'],
  ])
}

/** the example file on the course catalog import */
export function coursesTemplateCsv(): string {
  return toCsv([
    ['Course Code', 'Course Title', 'Department', 'Lecture Units', 'Lab Units', 'Room Type'],
    ['IT 101', 'Introduction to Computing', 'SCITE', '3', '0', ''],
    ['IT 211', 'Data Structures and Algorithms', 'SCITE', '2', '1', 'Computer Laboratory'],
    ['CHEM 101', 'General Chemistry', '', '3', '1', 'Chemistry Laboratory'],
    ['PE 101', 'Physical Fitness', '', '2', '0', 'Gym'],
  ])
}

/** the example file on the classes import: one line per class, the instructor optional */
export function classesTemplateCsv(): string {
  return toCsv([
    ['Course Code', 'Course Title', 'Lecture Units', 'Lab Units', 'Room Type', 'Program', 'Year', 'Section', 'Students', 'Instructor'],
    ['IT 211', 'Data Structures and Algorithms', '2', '1', 'Computer Laboratory', 'BSIT', '2', 'A', '35', 'Juan Dela Cruz'],
    ['IT 101', 'Introduction to Computing', '3', '', '', 'BSIT', '1', 'A', '40', 'Juan Dela Cruz'],
    ['CHEM 101', 'General Chemistry', '3', '1', 'Chemistry Laboratory', 'BSCPE', '1', 'B', '30', ''],
    ['MATH 101', 'Calculus 1', '3', '', '', 'BSCPE', '1', 'B', '30', ''],
  ])
}

/** Offers text to the browser as a file download. */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  // a byte-order mark makes Excel open UTF-8 CSV files with the right characters
  const blob = new Blob(['﻿', text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
