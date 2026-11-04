import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download, FileSpreadsheet } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Badge, Button, Notice, Table, TBody, THead, td, th } from '@/components/ui'
import { friendlyError } from '@/lib/errors'
import { FileProblem, readTable, type Cell } from '@/lib/import/readTable'
import { downloadText } from '@/lib/import/template'
import type { Issue } from '@/lib/import/teachingLoad'

const MAX_SHOWN = 150

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export interface ImportFileDialogProps<R extends { row: number }> {
  open: boolean
  onClose: () => void
  title: string
  /** what the file should hold, shown before a file is chosen */
  intro: ReactNode
  /** the name read out for the file input, for example "Rooms file" */
  fileLabel: string
  template: { filename: string; text: string }
  /** the "Which columns does the file need?" help */
  help: ReactNode
  /** extra choices that change how the file is read (the building for lines that name none); shown before and after a file is chosen */
  options?: ReactNode
  /** shown instead of the file chooser when the import cannot be used yet (no building to put rooms in) */
  blockedReason?: string | null
  /**
   * Reads the table of cells. Pure and quick: it runs again whenever `parse` itself changes (which is when an option above
   * changes), so wrap it in useCallback.
   */
  parse: (table: Cell[][]) => { rows: R[]; issues: Issue[]; skipped?: number }
  columns: Array<{ head: string; cell: (r: R) => ReactNode }>
  /** the figures above the preview */
  summary?: (rows: R[], skipped: number) => Array<[label: string, value: string]>
  /** what one row is called: ['room', 'rooms'] */
  noun: readonly [string, string]
  /** saves the rows; returns the sentence to show afterwards. Throwing means nothing was saved. */
  apply: (rows: R[], fileName: string) => Promise<string>
  onImported: (text: string) => void
}

/**
 * The dialog behind the CSV import on the Rooms and Courses pages. The file is read and checked here in the browser;
 * the person sees exactly what would be added, and nothing is saved until they press the Import button.
 */
export function ImportFileDialog<R extends { row: number }>(props: ImportFileDialogProps<R>) {
  const { open, onClose, title, intro, fileLabel, template, help, options, blockedReason, parse, columns, summary, noun, apply, onImported } = props
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; table: Cell[][] } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const reset = () => {
    setFile(null)
    setProblem(null)
    if (input.current) input.current.value = ''
  }
  const close = () => {
    reset()
    onClose()
  }

  const read = useMutation({
    mutationFn: async (f: File) => ({ name: f.name, table: await readTable(f) }),
    onMutate: () => setProblem(null),
    onSuccess: (f) => setFile(f),
    onError: (err) => {
      setFile(null)
      setProblem(err instanceof FileProblem ? err.message : friendlyError(err, 'The file could not be read.'))
    },
  })

  const parsed = useMemo(() => (file ? parse(file.table) : null), [file, parse])

  const save = useMutation({
    mutationFn: () => apply(parsed!.rows, file!.name),
    onSuccess: (text) => {
      onImported(text)
      close()
    },
    onError: (err) => setProblem(friendlyError(err, 'The import failed and nothing was saved.')),
  })

  const errorCount = parsed?.issues.filter((i) => i.level === 'error').length ?? 0
  const rows = parsed?.rows ?? []
  const order = { error: 0, warning: 1, info: 2 } as const
  const issues = [...(parsed?.issues ?? [])].sort((a, b) => order[a.level] - order[b.level] || a.row - b.row)
  const figures = parsed && summary ? summary(rows, parsed.skipped ?? 0) : []

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {file && (
            <Button variant="secondary" onClick={reset} disabled={save.isPending}>
              Choose another file
            </Button>
          )}
          {file && parsed && rows.length > 0 && (
            <Button onClick={() => save.mutate()} busy={save.isPending} disabled={errorCount > 0}>
              Import {plural(rows.length, noun[0], noun[1])}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {blockedReason && <Notice tone="bad">{blockedReason}</Notice>}

        {!file && (
          <>
            <p className="text-ink-600">{intro}</p>

            {options}

            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={input}
                type="file"
                accept=".csv,.xlsx,.xlsm,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) read.mutate(f)
                }}
                disabled={Boolean(blockedReason) || read.isPending}
                className="block max-w-full text-[14px] file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-ink-200 file:bg-white file:px-3.5 file:text-[14px] file:font-medium hover:file:bg-ink-50"
                aria-label={fileLabel}
              />
              <Button variant="ghost" onClick={() => downloadText(template.filename, template.text)}>
                <Download className="size-4" aria-hidden />
                Download a template
              </Button>
            </div>

            {read.isPending && (
              <p className="text-ink-600" role="status">
                Reading {read.variables?.name}…
              </p>
            )}
            {problem && <Notice tone="bad">{problem}</Notice>}

            <details className="rounded-md border border-ink-200 px-3 py-2 text-[14px]">
              <summary className="cursor-pointer font-medium">Which columns does the file need?</summary>
              <div className="mt-2 space-y-2 text-ink-600">{help}</div>
            </details>
          </>
        )}

        {file && parsed && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-ink-600">
              <FileSpreadsheet className="size-4" aria-hidden />
              <span className="font-medium text-ink-900">{file.name}</span>
              <span>· {plural(rows.length, noun[0], noun[1])} to add</span>
            </div>

            {options}

            {problem && <Notice tone="bad">{problem}</Notice>}

            {figures.length > 0 && (
              <dl className="grid gap-px overflow-hidden rounded-lg border border-ink-200 bg-ink-200 sm:grid-cols-2 lg:grid-cols-4">
                {figures.map(([label, value]) => (
                  <div key={label} className="bg-white px-4 py-3">
                    <dt className="text-[13px] text-ink-500">{label}</dt>
                    <dd className="text-[17px] font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {errorCount > 0 ? (
              <Notice tone="bad">
                {plural(errorCount, 'problem')} must be fixed before anything can be imported. Nothing has been saved. Correct the file and choose it again
                {options ? ', or change the choice above' : ''}.
              </Notice>
            ) : rows.length > 0 ? (
              <p className="text-ink-600">Nothing has been saved yet. Look it over, then import.</p>
            ) : (
              <Notice tone="bad">There is nothing new to add in this file.</Notice>
            )}

            {issues.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2 text-[14px]" aria-label="Problems found">
                {issues.map((i, k) => (
                  <li key={k} className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      {i.level === 'error' ? <Badge tone="bad">Error</Badge> : i.level === 'warning' ? <Badge tone="warn">Check</Badge> : <Badge>Note</Badge>}
                    </span>
                    <span>
                      {i.row ? <span className="text-ink-500">Line {i.row}: </span> : null}
                      {i.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-md border border-ink-200">
                <Table>
                  <THead>
                    <tr>
                      <th className={th}>Line</th>
                      {columns.map((c) => (
                        <th key={c.head} className={th}>
                          {c.head}
                        </th>
                      ))}
                    </tr>
                  </THead>
                  <TBody>
                    {rows.slice(0, MAX_SHOWN).map((r) => (
                      <tr key={r.row}>
                        <td className={`${td} text-ink-500`}>{r.row}</td>
                        {columns.map((c) => (
                          <td key={c.head} className={td}>
                            {c.cell(r)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </TBody>
                </Table>
                {rows.length > MAX_SHOWN && (
                  <p className="border-t border-ink-100 px-4 py-2 text-[13px] text-ink-500">
                    Showing the first {MAX_SHOWN} of {rows.length}. All of them are imported.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
