// Page chrome: header + body container.
import { ReactNode } from 'react'

interface Props {
  title: string
  titleExtra?: ReactNode
  middleArea?: ReactNode
  actions?: ReactNode
  children: ReactNode
  layout?: 'panel' | 'workspace'
  className?: string
}

export function PageShell({ title, titleExtra, middleArea, actions, children, layout = 'panel', className = '' }: Props) {
  return (
    <div className={`flex min-w-0 flex-col h-full relative overflow-hidden ${layout === 'panel' ? 'p-3' : ''} ${className}`}>
      <section className={`relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden bg-bg-soft ${layout === 'panel' ? 'rounded-2xl border border-line shadow-[0_6px_18px_rgba(45,34,22,0.12)]' : ''}`}>
        {/* `relative` so a page can anchor a middle-area element to the header
            box itself (e.g. Conductor's centred history trigger), instead of to
            the leftover space between the title and the actions. `z-20` above
            the section's `z-10`: a middle-area popover overflowing the header
            must paint above the body card below it (DOM order would otherwise
            let the section win the z tie). */}
        <header className={`relative z-20 min-h-16 shrink-0 px-4 py-3 flex items-center gap-4 bg-bg-card/75 border-b border-line/70 ${layout === 'workspace' ? 'flex-wrap' : ''}`}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-ink">{title}</h1>
              {titleExtra}
            </div>
          </div>
          {middleArea && <div className={`flex-1 flex items-center justify-start ${layout === 'panel' ? 'pl-24' : ''}`}>{middleArea}</div>}
          <div className="flex items-center gap-2 flex-wrap justify-end shrink-0 ml-auto">{actions}</div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto bg-bg-soft">{children}</div>
      </section>
    </div>
  )
}
