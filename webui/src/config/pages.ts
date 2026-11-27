import type { ComponentType } from 'react'

export type NavIconName =
  | 'dashboard'
  | 'chat'
  | 'anti'
  | 'conversations'
  | 'memory'
  | 'conductor'
  | 'goalHive'
  | 'mykey'
  | 'themeTasks'
  | 'tasks'
  | 'autonomous'
  | 'tokens'
  | 'settings'

export interface AppPageMeta {
  id: string
  to: string
  label: string
  navIcon: NavIconName
  inNav: boolean
  defaultVisible?: boolean
  palette: { label: string; icon: string }
  loader: () => Promise<{ default: ComponentType<any> }>
}

/**
 * Single declarative registry for standard SPA pages.
 *
 * Explicit exceptions stay out of this table by design:
 * - `/conversations/:id` deep-link route
 * - setup-mode shell (`<Settings initialMode="setup" />`)
 */
export const APP_PAGES: readonly AppPageMeta[] = [
  {
    id: 'dashboard',
    to: '/dashboard',
    label: '状态面板',
    navIcon: 'dashboard',
    inNav: true,
    palette: { label: '状态面板 / Dashboard', icon: '▦' },
    loader: () => import('@/pages/Dashboard'),
  },
  {
    id: 'chat',
    to: '/chat',
    label: '实时聊天',
    navIcon: 'chat',
    inNav: true,
    palette: { label: '实时聊天 / Live Chat', icon: '💬' },
    loader: () => import('@/pages/LiveChat'),
  },
  {
    id: 'anti',
    to: '/anti',
    label: 'Agy 会话',
    navIcon: 'anti',
    inNav: true,
    defaultVisible: false,
    palette: { label: 'Agy 会话 / Anti Chat', icon: '✦' },
    loader: () => import('@/pages/AntiChat'),
  },
  {
    id: 'theme-tasks',
    to: '/theme-tasks',
    label: '主题任务',
    navIcon: 'themeTasks',
    inNav: true,
    palette: { label: '主题任务 / Theme Tasks', icon: '🗂' },
    loader: () => import('@/pages/ThemeTasks'),
  },
  {
    id: 'conductor',
    to: '/conductor',
    label: '指挥模式',
    navIcon: 'conductor',
    inNav: true,
    palette: { label: '指挥模式 / Conductor', icon: '🎼' },
    loader: () => import('@/pages/Conductor'),
  },
  {
    id: 'goal-hive',
    to: '/goal-hive',
    label: 'Goal模式',
    navIcon: 'goalHive',
    inNav: true,
    palette: { label: 'Goal模式 / Goal Hive', icon: '🐝' },
    loader: () => import('@/pages/GoalHive'),
  },
  {
    id: 'conversations',
    to: '/conversations',
    label: '历史对话',
    navIcon: 'conversations',
    inNav: true,
    palette: { label: '历史对话 / Conversations', icon: '🗂️' },
    loader: () => import('@/pages/Conversations'),
  },
  {
    id: 'memory',
    to: '/memory',
    label: '记忆体系',
    navIcon: 'memory',
    inNav: true,
    palette: { label: '记忆体系 / Memory & SOP', icon: '🧠' },
    loader: () => import('@/pages/Memory'),
  },
  {
    id: 'mykey',
    to: '/mykey',
    label: 'LLM管理',
    navIcon: 'mykey',
    inNav: true,
    palette: { label: 'LLM管理 / MyKey', icon: '🔐' },
    loader: () => import('@/pages/MyKey'),
  },
  {
    id: 'tasks',
    to: '/tasks',
    label: '定时任务',
    navIcon: 'tasks',
    inNav: true,
    palette: { label: '定时任务 / Tasks', icon: '☑' },
    loader: () => import('@/pages/Tasks'),
  },
  {
    id: 'autonomous',
    to: '/autonomous',
    label: '自主进化',
    navIcon: 'autonomous',
    inNav: true,
    palette: { label: '自主进化 / Autonomous', icon: '🌀' },
    loader: () => import('@/pages/Autonomous'),
  },
  {
    id: 'tokens',
    to: '/tokens',
    label: '用量统计',
    navIcon: 'tokens',
    inNav: true,
    palette: { label: '用量统计 / Token Usage', icon: '◫' },
    loader: () => import('@/pages/TokenStats'),
  },
  {
    id: 'settings',
    to: '/settings',
    label: '系统设置',
    navIcon: 'settings',
    inNav: false,
    palette: { label: '系统设置 / Settings', icon: '⚙️' },
    loader: () => import('@/pages/Settings'),
  },
] as const
