import type { ServicePanelItem } from '@/api/types'

export type ServiceMetric = [label: string, value: string | number | boolean]
export type DashboardVerdict = {
  tone: 'good' | 'busy' | 'attention' | 'unknown'
  title: string
  detail: string
}

export function usefulMetrics(service: ServicePanelItem): ServiceMetric[] {
  return Object.entries(service.metrics).flatMap(([label, value]) => {
    if (value == null || value === false || value === 0) return []
    if (typeof value === 'string' && (!value.trim() || value === '—')) return []
    return [[label, value] as ServiceMetric]
  })
}

export function attentionServices(services: ServicePanelItem[]): ServicePanelItem[] {
  return services.filter((service) => service.health === 'attention' || service.health === 'unknown')
}

export function activeServices(services: ServicePanelItem[]): ServicePanelItem[] {
  return services.filter((service) => service.activity === 'active')
}

export function serviceActivityLabel(service: ServicePanelItem): string {
  if (service.health === 'attention') return '需处理'
  if (service.health === 'unknown') return '状态未知'
  if (service.activity === 'active') return '活动中'
  if (service.activity === 'standby') return '可用 · 待命'
  return '当前未运行'
}

export function dashboardVerdict(services: ServicePanelItem[]): DashboardVerdict {
  const attention = attentionServices(services)
  if (attention.length > 0) {
    return {
      tone: attention.some((service) => service.health === 'attention') ? 'attention' : 'unknown',
      title: `${attention.length} 个模块需要查看`,
      detail: attention.map((service) => service.name).join('、'),
    }
  }

  const agent = services.find((service) => service.id === 'agent')
  if (!agent) return { tone: 'unknown', title: '暂时无法判断系统状态', detail: 'Agent 状态尚未返回' }

  const active = activeServices(services)
  if (agent.activity === 'active') {
    return {
      tone: 'busy',
      title: '系统正在处理任务',
      detail: active.length > 1 ? `另有 ${active.length - 1} 个模块活动中` : 'Agent 正在执行任务',
    }
  }

  return {
    tone: 'good',
    title: '系统可接收任务',
    detail: active.length > 0 ? `${active.length} 个辅助模块活动中` : 'Agent 待命，当前没有后台活动',
  }
}
