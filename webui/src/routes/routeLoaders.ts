import { APP_PAGES, type AppPageMeta } from '@/config/pages'

const pagesByPath: Record<string, AppPageMeta> = Object.fromEntries(
  APP_PAGES.map((page) => [page.to, page]),
)

export function preloadRoute(path: string): void {
  const pathname = path.split('?')[0]
  const entry = pagesByPath[pathname] ?? (pathname.startsWith('/conversations/') ? pagesByPath['/conversations'] : undefined)
  if (entry) void entry.loader()
}
