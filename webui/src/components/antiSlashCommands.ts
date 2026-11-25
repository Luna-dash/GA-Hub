export interface AntiSlashCommandInput {
  name: string
  description?: string | null
  hint?: string | null
}

export type AntiSlashCommandTier = 'core' | 'custom' | 'secondary'

export interface AntiSlashCommandItem {
  name: string
  description?: string | null
  hint?: string | null
  tier: AntiSlashCommandTier
}

export interface AntiSlashFilterResult {
  items: AntiSlashCommandItem[]
  hiddenCount: number
  totalAvailable: number
}

const CJK_RE = /[\u4e00-\u9fff]/

const CORE_ANTI_COMMANDS: readonly {
  name: string
  description: string
  hint?: string
}[] = [
  { name: 'compact', description: '压缩当前对话上下文，节省额度' },
  { name: 'plan', description: '先调研并生成结构化方案', hint: '<目标>' },
  { name: 'review', description: '审查工作区改动与潜在问题' },
  { name: 'grill-me', description: '交互式追问，逐项对齐设计决策' },
  { name: 'boost', description: '复杂任务深度思考与严谨验证' },
  { name: 'goal', description: '长程目标持续推进直至完成' },
  { name: 'learn', description: '将纠偏或协作约定沉淀为规则' },
]

const CORE_INDEX = new Map(CORE_ANTI_COMMANDS.map((entry, index) => [entry.name, index]))
const CORE_BY_NAME = new Map(CORE_ANTI_COMMANDS.map((entry) => [entry.name, entry]))

const SECONDARY_ANTI_COMMANDS: Record<string, string> = {
  teamwork: '多 Agent 协作拆解大型任务',
  swarm: '启动多 Agent 协同看板',
  browser: '使用浏览器检索或操作网页',
  init: '初始化项目规则与上下文说明',
  memory: '查看或整理记忆规则',
  skills: '查看或调用可用技能',
  agents: '查看或管理子代理',
  workflow: '运行多步编排工作流',
  workflows: '查看或运行工作流',
  'run-workflow': '运行多步编排工作流',
}

const BLOCKED_ANTI_COMMANDS = new Set([
  'exit',
  'quit',
  'clear',
  'help',
  'login',
  'logout',
  'auth',
  'model',
  'models',
  'status',
  'settings',
  'config',
  'theme',
  'new',
  'resume',
  'history',
  'sessions',
  'mcp',
  'doctor',
  'version',
  'bug',
  'feedback',
  'update',
  'schedule',
  'swarm_monitor',
  'swarm_pane',
  'swarm_narrator',
  'migrate-agent-settings',
  'migrate-workflows',
])

export const DEFAULT_ANTI_COMMANDS: readonly AntiSlashCommandInput[] = [
  { name: 'compact', description: '压缩当前对话上下文，节省额度' },
  { name: 'plan', description: '先调研并生成结构化方案', hint: '<目标>' },
  { name: 'review', description: '审查工作区改动与潜在问题' },
]

function normalizeCommandName(rawName: string): string {
  return rawName.trim().replace(/^\/+/, '').toLowerCase()
}

function resolveDescription(
  normalized: string,
  tier: AntiSlashCommandTier,
  upstreamDescription?: string | null,
): string | null | undefined {
  const trimmed = upstreamDescription?.trim()
  if (trimmed && CJK_RE.test(trimmed)) return trimmed
  if (tier === 'core') return CORE_BY_NAME.get(normalized)?.description ?? (trimmed || upstreamDescription)
  if (tier === 'secondary') return SECONDARY_ANTI_COMMANDS[normalized] ?? (trimmed || upstreamDescription)
  return trimmed || upstreamDescription
}

interface InternalEntry {
  item: AntiSlashCommandItem
  rawDescription: string
  order: number
}

export function filterAntiSlashCommands(
  rawCommands: readonly AntiSlashCommandInput[],
  query: string,
): AntiSlashFilterResult {
  const seen = new Set<string>()
  const kept: InternalEntry[] = []

  rawCommands.forEach((cmd, order) => {
    const normalized = normalizeCommandName(cmd.name ?? '')
    if (!normalized || seen.has(normalized) || BLOCKED_ANTI_COMMANDS.has(normalized)) return
    seen.add(normalized)

    const tier: AntiSlashCommandTier = CORE_BY_NAME.has(normalized)
      ? 'core'
      : Object.hasOwn(SECONDARY_ANTI_COMMANDS, normalized)
        ? 'secondary'
        : 'custom'

    const coreMeta = CORE_BY_NAME.get(normalized)
    const hint = cmd.hint?.trim() || coreMeta?.hint || undefined
    const description = resolveDescription(normalized, tier, cmd.description)

    kept.push({
      item: {
        name: normalized,
        description: description ?? null,
        hint: hint ?? null,
        tier,
      },
      rawDescription: (cmd.description ?? '').trim().toLowerCase(),
      order,
    })
  })

  const totalAvailable = kept.length
  const normalizedQuery = query.trim().replace(/^\/+/, '').toLowerCase()

  if (!normalizedQuery) {
    const coreItems = kept
      .filter((entry) => entry.item.tier === 'core')
      .sort((a, b) => (CORE_INDEX.get(a.item.name) ?? 999) - (CORE_INDEX.get(b.item.name) ?? 999))
      .map((entry) => entry.item)
    const customItems = kept
      .filter((entry) => entry.item.tier === 'custom')
      .map((entry) => entry.item)
    const secondaryItems = kept
      .filter((entry) => entry.item.tier === 'secondary')
      .map((entry) => entry.item)

    if (coreItems.length + customItems.length > 0) {
      return {
        items: [...coreItems, ...customItems],
        hiddenCount: secondaryItems.length,
        totalAvailable,
      }
    }
    return {
      items: secondaryItems,
      hiddenCount: 0,
      totalAvailable,
    }
  }

  const tierRank: Record<AntiSlashCommandTier, number> = {
    core: 0,
    custom: 1,
    secondary: 2,
  }

  const matched = kept
    .filter((entry) => {
      const desc = (entry.item.description ?? '').toLowerCase()
      return (
        entry.item.name.includes(normalizedQuery)
        || desc.includes(normalizedQuery)
        || entry.rawDescription.includes(normalizedQuery)
      )
    })
    .sort((a, b) => {
      const aPrefix = a.item.name.startsWith(normalizedQuery) ? 0 : 1
      const bPrefix = b.item.name.startsWith(normalizedQuery) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      const rankDiff = tierRank[a.item.tier] - tierRank[b.item.tier]
      if (rankDiff !== 0) return rankDiff
      if (a.item.tier === 'core' && b.item.tier === 'core') {
        return (CORE_INDEX.get(a.item.name) ?? 999) - (CORE_INDEX.get(b.item.name) ?? 999)
      }
      return a.order - b.order
    })
    .map((entry) => entry.item)

  return {
    items: matched,
    hiddenCount: 0,
    totalAvailable,
  }
}
