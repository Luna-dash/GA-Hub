import { CircleDashed, FolderOpen, FolderPlus } from 'lucide-react'
import { ThemedSelect, type SelectOption } from './ThemedSelect'

interface ProjectSelectProps {
  id?: string
  options: ReadonlyArray<SelectOption>
  value: string
  onChange: (path: string) => void
  disabled?: boolean
  title?: string
}

export function ProjectSelect(props: ProjectSelectProps) {
  return <ThemedSelect {...props} aria-label="当前项目" className="project-select-trigger max-w-[220px]"
    displayName={(option) => option.name}
    renderLabel={(option) => <>
      <span className="model-select-mark model-select-mark--project">
        {!option?.key ? <CircleDashed size={16} aria-hidden="true" />
          : option.key === '__new__' ? <FolderPlus size={16} aria-hidden="true" />
            : <FolderOpen size={16} aria-hidden="true" />}
      </span>
      <span className="model-select-label">{option?.name ?? '未绑定项目'}</span>
    </>} />
}
