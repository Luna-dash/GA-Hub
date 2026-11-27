// Page chrome: header + body container.
import { ReactNode } from 'react'

interface Props {
  title: string
  titleExtra?: ReactNode
  middleArea?: ReactNode
  actions?: ReactNode
  children: ReactNode
  layout?: 'panel' | 'workspace'
  wrapHeader?: boolean
  className?: string
}

export function PageShell({ title, titleExtra, middleArea, actions, children, layout = 'panel', wrapHeader = false, className = '' }: Props) {
  return (
    <div className={`ga-page-shell flex min-w-0 flex-col h-full relative overflow-hidden ${layout === 'panel' ? 'p-3' : ''} ${className}`}>
      <section className={`ga-page-surface relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden bg-transparent ${layout === 'panel' ? 'rounded-2xl border border-line shadow-[0_6px_18px_rgba(28,25,23,0.10)]' : ''}`}>
        {/* `relative` so a page can anchor a middle-area element to the header
            box itself (e.g. Conductor's centred history trigger), instead of to
            the leftover space between the title and the actions. `z-20` above
            the section's `z-10`: a middle-area popover overflowing the header
            must paint above the body card below it (DOM order would otherwise
            let the section win the z tie). */}
        <header className={`ga-page-header relative z-20 min-h-14 shrink-0 px-4 py-2.5 flex items-center gap-4 bg-bg-card/95 border-b border-line/70 shadow-[inset_0_1px_0_var(--c-inset-highlight)] ${layout === 'workspace' || wrapHeader ? 'flex-wrap' : ''} ${wrapHeader ? 'gap-y-2' : ''}`}>
          <div className="flex flex-col gap-1">
            <div className={`flex items-center gap-2 ${wrapHeader ? 'whitespace-nowrap' : ''}`}>
              <h1 className="text-base font-semibold text-ink">{title}</h1>
              {titleExtra}
            </div>
          </div>
          {middleArea && <div className={`min-w-0 flex-1 flex items-center justify-start ${layout === 'panel' ? 'pl-0 lg:pl-10 xl:pl-24' : ''} ${wrapHeader ? 'basis-full md:basis-56' : ''}`}>{middleArea}</div>}
          <div className={`flex items-center gap-2 flex-wrap justify-end shrink-0 ml-auto ${wrapHeader ? 'max-w-full' : ''}`}>{actions}</div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto bg-transparent">{children}</div>
      </section>
    </div>
  )
}
