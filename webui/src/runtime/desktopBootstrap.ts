import {
  desktopRuntimeConfigError,
  getRuntimeConfig,
} from './runtimeConfig'

export type DesktopBackendReadiness = () => Promise<boolean>

export async function queryDesktopBackendReadiness(
  invokeReady?: DesktopBackendReadiness,
): Promise<boolean> {
  const configError = desktopRuntimeConfigError()
  if (configError) throw new Error(configError)
  if (!getRuntimeConfig().desktop) return true

  const check = invokeReady ?? (async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('desktop_backend_ready')
  })
  return check()
}
