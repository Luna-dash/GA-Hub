import { type ButtonHTMLAttributes } from 'react'
import { CornerDownRight } from 'lucide-react'
import clsx from 'clsx'
import { ThemedSelect } from './ThemedSelect'
import { SessionChannelIcon, sessionChannel } from './SessionChannelIcon'
import '@/styles/model-select.css'

interface ModelOption { key: string; name: string }
interface CommonModelSelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
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

export function modelPresentation(name: string) {
  const slash = name.indexOf('/')
  const type = slash < 0 ? '' : name.slice(0, slash)
  const channel = sessionChannel(type)
  return { channel, label: channel ? name.slice(slash + 1) || name : name }
}

function ModelLabel({ name, follow = false }: { name: string; follow?: boolean }) {
  const { channel, label } = modelPresentation(name)
  return <>
    <span className={clsx('model-select-mark', channel && `model-select-mark--${channel}`)}>
      {follow ? <CornerDownRight size={16} aria-hidden="true" /> : <SessionChannelIcon type={channel ?? ''} />}
    </span>
    <span className="model-select-label">{label}</span>
  </>
}

function ModelSelect({ llms, value, onChange, follow, ...props }: CommonModelSelectProps & {
  value: string; onChange: (key: string) => void; follow?: boolean
}) {
  const options = follow ? [{ key: '', name: '跟随主模型' }, ...llms] : llms
  return <ThemedSelect {...props} options={options} value={value} onChange={onChange}
    disabled={props.disabled || llms.length === 0}
    displayName={(option) => modelPresentation(option.name).label}
    renderLabel={(option) => <ModelLabel name={option?.name ?? (llms.length ? '选择模型' : '暂无模型')} follow={follow && option?.key === ''} />} />
}

export function MainModelSelect({ value, onChange, ...props }: MainModelSelectProps) {
  return <ModelSelect {...props} value={value ?? ''} onChange={onChange} />
}
export function SubagentModelSelect({ value, onChange, ...props }: SubagentModelSelectProps) {
  return <ModelSelect {...props} value={value ?? ''} onChange={(key) => onChange(key || null)} follow />
}
