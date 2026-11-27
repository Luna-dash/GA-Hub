// ActionIcons — 统一的矢量图标与高频图标按钮原语
// 对齐 lucide-react 的 24x24 栅格与圆角描边语言（strokeWidth=1.85），
// 消除跨页面 Unicode 字符 / Emoji / 重复手写 SVG 带来的割裂感。

import type { ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  BookOpen,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FileJson,
  FileText,
  FolderDown,
  FolderOpen,
  History,
  Inbox,
  Layers,
  ListPlus,
  LoaderCircle,
  Mail,
  Maximize2,
  Minimize2,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  SendHorizontal,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  Unlink,
  Upload,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'

const STROKE = 1.85

export {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  BookOpen,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Clock,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FileJson,
  FileText,
  FolderDown,
  FolderOpen,
  History,
  Inbox,
  Layers,
  ListPlus,
  Mail,
  Maximize2,
  Minimize2,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  SendHorizontal,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  Unlink,
  Upload,
  X,
  Zap,
}

/** 定制双折角收缩/展开箭头，用于会话分组全展与对话回底收起控件 */
export function CollapseChevronsIcon({
  direction = 'collapse',
  className = 'h-3.5 w-3.5',
}: {
  direction?: 'expand' | 'collapse'
  className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === 'collapse' ? 'm7 4 5 5 5-5M7 20l5-5 5 5' : 'm7 9 5-5 5 5M7 15l5 5 5-5'} />
    </svg>
  )
}

/** 定制侧栏/抽屉折叠双折角图标，共享于 SidebarNav、SessionRail 与 ConversationIndexRail */
export function RailFoldGlyph({
  direction,
  className = 'h-3.5 w-3.5',
}: {
  direction: 'left' | 'right' | 'up' | 'down'
  className?: string
}) {
  const path =
    direction === 'right'
      ? 'm10 17 5-5-5-5M5 17l5-5-5-5'
      : direction === 'left'
        ? 'm14 17-5-5 5-5M19 17l-5-5 5-5'
        : direction === 'down'
          ? 'm7 6 5 5 5-5M7 13l5 5 5-5'
          : 'm7 11 5-5 5 5M7 18l5-5 5 5'
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  )
}

/** 定制图钉图标，兼顾未置顶细描边与置顶实心填充识别度 */
export function PinGlyph({ pinned, className = 'h-3 w-3' }: { pinned: boolean; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill={pinned ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" />
      <path d="M12 15v6" />
    </svg>
  )
}

/** 定制“移回聊天”图形：简洁门框 + 退出箭头 */
export function MoveOutIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
      <path d="m14 8 4 4-4 4" />
      <path d="M8 12h10" />
    </svg>
  )
}

export function CopyIcon({
  copied = false,
  size = 13,
  className,
}: {
  copied?: boolean
  size?: number
  className?: string
}) {
  return copied
    ? <Check size={size} strokeWidth={2.2} className={clsx('shrink-0 text-status-success', className)} aria-hidden="true" />
    : <Copy size={size} strokeWidth={STROKE} className={clsx('shrink-0', className)} aria-hidden="true" />
}

export function RefreshIcon({
  spinning = false,
  size = 14,
  className,
}: {
  spinning?: boolean
  size?: number
  className?: string
}) {
  return (
    <RotateCw
      size={size}
      strokeWidth={STROKE}
      className={clsx('shrink-0', spinning && 'animate-spin motion-reduce:animate-none', className)}
      aria-hidden="true"
    />
  )
}

export function RewindIcon({ size = 13, className }: { size?: number; className?: string }) {
  return <RotateCcw size={size} strokeWidth={STROKE} className={clsx('shrink-0', className)} aria-hidden="true" />
}

export function ChevronDisclosureIcon({
  open,
  size = 14,
  className,
}: {
  open: boolean
  size?: number
  className?: string
}) {
  return (
    <ChevronRight
      size={size}
      strokeWidth={2}
      className={clsx('shrink-0 transition-transform duration-150', open && 'rotate-90', className)}
      aria-hidden="true"
    />
  )
}

interface CloseIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  label: string
  variant?: 'ghost' | 'badge' | 'compact'
  iconSize?: number
  title?: string | null
}

export function CloseIconButton({
  label,
  variant = 'ghost',
  iconSize,
  className,
  title,
  type = 'button',
  ...props
}: CloseIconButtonProps) {
  const variantClass =
    variant === 'badge'
      ? 'ga-btn-icon-badge'
      : variant === 'compact'
        ? 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-bg-soft hover:text-status-danger disabled:opacity-40'
        : 'ga-btn-icon-ghost'
  const size = iconSize ?? (variant === 'badge' ? 11 : variant === 'compact' ? 13 : 15)
  return (
    <button
      type={type}
      aria-label={label}
      title={title === null ? undefined : (title ?? label)}
      className={clsx(variantClass, className)}
      {...props}
    >
      <X size={size} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

export type StatusBadgeKind = 'connected' | 'connecting' | 'offline' | 'running' | 'idle' | 'error'

export function statusBadgeToneClass(kind: StatusBadgeKind) {
  return kind === 'connected' || kind === 'running'
    ? 'ga-badge-connected'
    : kind === 'connecting'
      ? 'ga-badge-connecting'
      : 'ga-badge-offline'
}

export function StatusIconGlyph({ kind, className }: { kind: StatusBadgeKind; className?: string }) {
  if (kind === 'connected' || kind === 'running') {
    return <Wifi className={clsx('h-3.5 w-3.5', className)} strokeWidth={STROKE} aria-hidden="true" />
  }
  if (kind === 'connecting') {
    return <LoaderCircle className={clsx('h-3.5 w-3.5 animate-spin motion-reduce:animate-none', className)} strokeWidth={STROKE} aria-hidden="true" />
  }
  if (kind === 'error') {
    return <AlertTriangle className={clsx('h-3.5 w-3.5', className)} strokeWidth={STROKE} aria-hidden="true" />
  }
  return <WifiOff className={clsx('h-3.5 w-3.5', className)} strokeWidth={STROKE} aria-hidden="true" />
}

/** 页面/服务连接与运行状态纯图标徽标（带悬停提示与无障碍标签） */
export function StatusIconBadge({
  kind,
  label,
  srText = false,
  className,
}: {
  kind: StatusBadgeKind
  label: string
  srText?: boolean
  className?: string
}) {
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={clsx('ga-badge', statusBadgeToneClass(kind), className)}
    >
      <StatusIconGlyph kind={kind} />
      {srText && <span className="sr-only">{label}</span>}
    </span>
  )
}
