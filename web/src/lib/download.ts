/** Hand a text to the browser as a file download. */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // give the browser a moment to start the download before the address is released
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
