// Page chrome: header + body container.
import { ReactNode } from 'react'

interface Props {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

export function PageShell({ title, description, actions, children }: Props) {
  return (
    <div className="flex flex-col h-full relative overflow-hidden p-3">
      <section className="relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden rounded-2xl border border-line bg-bg-soft shadow-[0_6px_18px_rgba(45,34,22,0.12)]">
        <header className="shrink-0 px-4 py-3 flex items-start justify-between gap-4 bg-bg-card/75 border-b border-line/70">
          <div>
            <h1 className="text-base font-semibold text-[#2C2418]">{title}</h1>
            {description && <p className="text-xs text-[#665741] mt-0.5">{description}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">{actions}</div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto bg-bg-soft">{children}</div>
      </section>
    </div>
  )
}
