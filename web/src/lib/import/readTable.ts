/**
 * Reads a CSV or Excel file into a plain table of cells. The two libraries are loaded only when a file is
 * actually chosen, so the rest of the app does not pay for them.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export type Cell = string | number | boolean | Date | null

export class FileProblem extends Error {}

/** CSV text to a table. The delimiter (comma, semicolon or tab) is detected; a leading byte-order mark is dropped. */
export async function tableFromCsv(text: string): Promise<Cell[][]> {
  const { default: Papa } = await import('papaparse')
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // blank lines are kept so that "line 12" in a message is line 12 of the file as the person sees it in Excel or a text editor
  const result = Papa.parse<string[]>(clean, { skipEmptyLines: false, delimitersToGuess: [',', ';', '\t', '|'] })
  const fatal = result.errors.find((e) => e.type === 'Quotes')
  if (fatal) throw new FileProblem(`The CSV file has a quoting problem near line ${(fatal.row ?? 0) + 2}. Check for a stray quotation mark.`)
  return result.data
}

/** The first sheet of an .xlsx workbook to a table. Merged cells arrive empty except for their top-left cell. */
export async function tableFromXlsx(input: Blob): Promise<Cell[][]> {
  const { readSheet } = await import('read-excel-file/browser')
  try {
    return (await readSheet(input)) as Cell[][]
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'InvalidInputError' || name === 'InvalidSpreadsheetError') {
      throw new FileProblem('That does not look like a valid .xlsx file. Open it in Excel and save it again as .xlsx or CSV.')
    }
    throw err
  }
}

export async function readTable(file: File): Promise<Cell[][]> {
  if (file.size > MAX_IMPORT_BYTES) throw new FileProblem('The file is larger than 5 MB. Split it by department or program and import the parts.')
  if (file.size === 0) throw new FileProblem('The file is empty.')
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return tableFromXlsx(file)
  if (name.endsWith('.xls')) throw new FileProblem('Old .xls files are not supported. In Excel choose File, Save As, and pick .xlsx or CSV.')
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) return tableFromCsv(await file.text())
  throw new FileProblem('Choose a .csv or .xlsx file.')
}
