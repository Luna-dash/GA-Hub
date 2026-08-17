import type { SelectHTMLAttributes } from 'react'
import clsx from 'clsx'

interface ModelOption {
  key: string
  name: string
}

interface CommonModelSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  llms: ReadonlyArray<ModelOption>
}

interface MainModelSelectProps extends CommonModelSelectProps {
  value: string | undefined
  onChange: (llmKey: string) => void
}

interface SubagentModelSelectProps extends CommonModelSelectProps {
  value: string | null
  onChange: (llmKey: string | null) => void
}

const SELECT_CLASS = 'min-w-0 shrink-0 truncate rounded border border-line bg-bg-card px-3 py-1.5 text-sm text-[#2C2418] hover:border-accent focus:border-accent focus:outline-none disabled:opacity-50'

export function MainModelSelect({ llms, value, onChange, className, disabled, ...props }: MainModelSelectProps) {
  return (
    <select
      {...props}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || llms.length === 0}
      className={clsx(SELECT_CLASS, className)}
    >
      {llms.map((llm) => (
        <option key={llm.key} value={llm.key}>{llm.name}</option>
      ))}
    </select>
  )
}

export function SubagentModelSelect({ llms, value, onChange, className, disabled, ...props }: SubagentModelSelectProps) {
  return (
    <select
      {...props}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      disabled={disabled || llms.length === 0}
      className={clsx(SELECT_CLASS, className)}
    >
      <option value="">跟随主模型</option>
      {llms.map((llm) => (
        <option key={llm.key} value={llm.key}>{llm.name}</option>
      ))}
    </select>
  )
}
