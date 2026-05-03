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
    <div className="flex flex-col h-full">
      <header className="border-b border-line px-6 py-4 flex items-start justify-between gap-4 bg-bg-soft/70 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
