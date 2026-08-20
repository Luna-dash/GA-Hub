export const routeLoaders = {
  dashboard: () => import('@/pages/Dashboard'),
  chat: () => import('@/pages/LiveChat'),
  conversations: () => import('@/pages/Conversations'),
  memory: () => import('@/pages/Memory'),
  goalHive: () => import('@/pages/GoalHive'),
  conductor: () => import('@/pages/Conductor'),
  mykey: () => import('@/pages/MyKey'),
  settings: () => import('@/pages/Settings'),
  tasks: () => import('@/pages/Tasks'),
  autonomous: () => import('@/pages/Autonomous'),
  tokens: () => import('@/pages/TokenStats'),
}

const loadersByPath: Record<string, () => Promise<unknown>> = {
  '/dashboard': routeLoaders.dashboard,
  '/chat': routeLoaders.chat,
  '/conversations': routeLoaders.conversations,
  '/memory': routeLoaders.memory,
  '/goal-hive': routeLoaders.goalHive,
  '/conductor': routeLoaders.conductor,
  '/mykey': routeLoaders.mykey,
  '/settings': routeLoaders.settings,
  '/tasks': routeLoaders.tasks,
  '/autonomous': routeLoaders.autonomous,
  '/tokens': routeLoaders.tokens,
}

export function preloadRoute(path: string): void {
  const pathname = path.split('?')[0]
  const direct = loadersByPath[pathname]
  const loader = direct ?? (pathname.startsWith('/conversations/') ? routeLoaders.conversations : undefined)
  if (loader) void loader()
}
