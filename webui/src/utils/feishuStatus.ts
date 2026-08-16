export type FeishuUiState = {
  label: '检测中' | '检测失败' | '未配置' | '已连接' | '未连接'
  dot: string
  text: string
}

type FeishuUiStateInput = {
  statusLoaded: boolean
  connected: boolean
  pid?: number | null
  checkReady?: boolean
  checkPending: boolean
  checkFailed: boolean
}

/** Keep an unknown or failed config check distinct from a confirmed missing config. */
export function deriveFeishuUiState({
  statusLoaded,
  connected,
  pid,
  checkReady,
  checkPending,
  checkFailed,
}: FeishuUiStateInput): FeishuUiState {
  if (!statusLoaded) {
    return { label: '检测中', dot: 'bg-amber-400', text: '读取飞书长连接状态…' }
  }
  // A live gateway is stronger evidence than a delayed config probe.
  if (connected) {
    return { label: '已连接', dot: 'bg-emerald-500', text: pid ? `PID ${pid}` : '长连接在线' }
  }
  if (checkPending || checkReady === undefined) {
    if (checkFailed) {
      return { label: '检测失败', dot: 'bg-amber-500', text: '暂时无法读取 Key 状态，请刷新重试。' }
    }
    return { label: '检测中', dot: 'bg-amber-400', text: '正在从 GA keychain 检查飞书 Key…' }
  }
  if (!checkReady) {
    return { label: '未配置', dot: 'bg-rose-500', text: '请设置飞书 Key。' }
  }
  return { label: '未连接', dot: 'bg-slate-400', text: 'Key 已配置，网关未运行。' }
}
