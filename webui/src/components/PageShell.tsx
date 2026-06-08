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
    <div className="flex flex-col h-full relative overflow-hidden p-3 gap-0">
      <header className="relative z-10 border border-line px-4 py-3 flex items-start justify-between gap-4 bg-bg-card shadow-[0_2px_7px_rgba(45,34,22,0.11)] rounded-t-lg">
        <div>
          <h1 className="text-base font-semibold text-[#2C2418]">{title}</h1>
          {description && <p className="text-xs text-[#665741] mt-0.5">{description}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">{actions}</div>
      </header>
      <div className="relative z-10 flex-1 overflow-y-auto border-x border-b border-line rounded-b-lg bg-bg-soft shadow-[0_2px_7px_rgba(45,34,22,0.10)]">{children}</div>
    </div>
  )
}
