import { describe, expect, it } from 'vitest'
import type { ServicePanelItem } from '@/api/types'
import {
  activeServices,
  attentionServices,
  dashboardVerdict,
  serviceActivityLabel,
  usefulMetrics,
} from './dashboardUi'

const service = (overrides: Partial<ServicePanelItem> = {}): ServicePanelItem => ({
  id: 'agent',
  name: 'Agent',
  state: 'ready',
  activity: 'standby',
  health: 'healthy',
  expected_running: true,
  summary: '等待任务',
  href: '/chat',
  metrics: {},
  error: null,
  ...overrides,
})

describe('dashboard service semantics', () => {
  it('treats a standby agent and optional inactive modules as ready, not broken', () => {
    const services = [
      service(),
      service({ id: 'feishu', name: '飞书', state: 'stopped', activity: 'inactive', expected_running: false }),
    ]
    expect(attentionServices(services)).toEqual([])
    expect(dashboardVerdict(services)).toEqual({
      tone: 'good',
      title: '系统可接收任务',
      detail: 'Agent 待命，当前没有后台活动',
    })
    expect(serviceActivityLabel(services[1])).toBe('当前未运行')
  })

  it('separates active modules from modules that need attention', () => {
    const services = [
      service({ state: 'running', activity: 'active', summary: '正在执行任务' }),
      service({ id: 'feishu', name: '飞书', state: 'running', activity: 'active' }),
      service({ id: 'task_scheduler', name: '定时任务', state: 'stopped', activity: 'inactive', health: 'attention', summary: '已启用计划，但调度器已停止' }),
    ]
    expect(activeServices(services).map((item) => item.id)).toEqual(['agent', 'feishu'])
    expect(attentionServices(services).map((item) => item.id)).toEqual(['task_scheduler'])
    expect(dashboardVerdict(services).title).toBe('1 个模块需要查看')
  })

  it('keeps only metrics with meaningful values', () => {
    expect(usefulMetrics(service({ metrics: {
      请求: 3,
      失败: 0,
      启用: true,
      停用: false,
      空值: null,
      缺省: '—',
      文本: '在线',
    } }))).toEqual([['请求', 3], ['启用', true], ['文本', '在线']])
  })
})
