import { useEffect, useRef, type ReactNode } from 'react'

/** Small modal built on the native <dialog>, so focus trapping and Escape come for free. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  stickyFooter,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** keep the buttons in view while a long body scrolls */
  stickyFooter?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={`m-auto max-h-[calc(100vh-32px)] overflow-y-auto rounded-lg border border-ink-200 bg-white p-0 text-ink-900 shadow-xl ${
        wide ? 'w-[min(1040px,calc(100vw-32px))]' : 'w-[min(460px,calc(100vw-32px))]'
      }`}
    >
      <div className="p-5">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
        {footer && (
          <div
            className={
              stickyFooter
                ? 'sticky bottom-0 z-10 -mx-5 -mb-5 mt-5 flex flex-wrap justify-end gap-2 border-t border-ink-200 bg-white px-5 py-3'
                : 'mt-5 flex justify-end gap-2'
            }
          >
            {footer}
          </div>
        )}
      </div>
    </dialog>
  )
}
