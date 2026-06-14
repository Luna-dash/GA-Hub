// Page chrome: header + body container.
import { ReactNode } from 'react'

interface Props {
  title: string
  titleExtra?: ReactNode
  description?: ReactNode
  middleArea?: ReactNode
  actions?: ReactNode
  children: ReactNode
}

export function PageShell({ title, titleExtra, description, middleArea, actions, children }: Props) {
  return (
    <div className="flex flex-col h-full relative overflow-hidden p-3">
      <section className="relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden rounded-2xl border border-line bg-bg-soft shadow-[0_6px_18px_rgba(45,34,22,0.12)]">
        <header className="shrink-0 px-4 py-3 flex items-center gap-4 bg-bg-card/75 border-b border-line/70">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-[#2C2418]">{title}</h1>
              {titleExtra}
            </div>
            {description && <div className="text-xs text-[#665741]">{description}</div>}
          </div>
          {middleArea && <div className="flex-1 flex items-center justify-start pl-24">{middleArea}</div>}
          <div className="flex items-center gap-2 flex-wrap justify-end shrink-0 ml-auto">{actions}</div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto bg-bg-soft">{children}</div>
      </section>
    </div>
  )
}
