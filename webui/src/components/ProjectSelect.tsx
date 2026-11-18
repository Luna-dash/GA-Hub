import { CircleDashed, FolderOpen, FolderPlus } from 'lucide-react'
import { ThemedSelect, type SelectOption } from './ThemedSelect'

interface ProjectSelectProps {
  id?: string
  options: ReadonlyArray<SelectOption>
  value: string
  onChange: (path: string) => void
  disabled?: boolean
  title?: string
  'aria-label'?: string
  standalone?: boolean
  placeholder?: string
}

export function ProjectSelect({ standalone, placeholder = '未绑定项目', 'aria-label': label = '当前项目', ...props }: ProjectSelectProps) {
  return <ThemedSelect {...props} aria-label={label} className={standalone ? 'max-w-full' : 'project-select-trigger max-w-[220px]'}
    displayName={(option) => option.name} placeholder={placeholder}
    renderMark={(option) => (
      <span className="model-select-mark model-select-mark--project">
        {!option?.key ? <CircleDashed size={16} aria-hidden="true" />
          : option.key === '__new__' ? <FolderPlus size={16} aria-hidden="true" />
            : <FolderOpen size={16} aria-hidden="true" />}
      </span>
    )} />
}
