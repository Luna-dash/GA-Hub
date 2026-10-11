// MyKey sync page UI visibility (localStorage-backed, cross-page synced).
//
// 上传 mykey 会用本机内容覆盖同步服务器版本，属于高风险低频操作：
// 按钮默认隐藏，需在「设置」页手动确认后才显示（见 Settings 的 mykey 同步面板）。

import { errorMessageFromError, myKeySyncErrorFromError } from './sessionUi'

export type MyKeySyncAction = 'upload' | 'fetch'

export const MYKEY_SYNC_CONFIRM = {
  upload: {
    title: '将本机配置上传到云端？',
    message: '本机 mykey 将加密上传，替换云端版本。\n其他设备之后可下载这份配置，请确认它是你要共享的版本。',
    confirmText: '确认上传',
  },
  fetch: {
    title: '用云端配置替换本机配置？',
    message: '下载后会覆盖本机 mykey，现有文件会先备份。\n本机尚未上传的修改不会保留在当前配置中。',
    confirmText: '下载并替换',
  },
} as const

/** Script output is diagnostic evidence, never the user-facing success text. */
export function myKeySyncSuccess(action: MyKeySyncAction, stdout = ''): string {
  const current = /^\[(?:upload|fetch)\]\s*(?:远端)?已是最新(?:，|。|\s|$)/m.test(stdout)
  if (current) return action === 'upload'
    ? '云端已是这份配置，无需重复上传。'
    : '本机配置已与云端一致。'
  return action === 'upload'
    ? '配置已上传到云端，其他设备可以下载使用。'
    : '云端配置已同步到本机，模型列表已刷新。'
}

/** Explain the next step without pretending a failed upload never reached the
 * server or a failed reload never replaced the local file. Keep evidence folded. */
export function myKeySyncFailure(action: MyKeySyncAction, error: unknown) {
  const detail = myKeySyncErrorFromError(error)
  const primary = errorMessageFromError(error, '')
  const data = (error as { body?: { detail?: unknown } } | null)?.body?.detail
  const stderr = typeof data === 'object' && data !== null && 'stderr' in data ? String(data.stderr ?? '') : ''
  // Exclude command/path metadata: python.exe is present for every failure.
  const text = `${primary}\n${stderr}`
  let message: string
  if (/回读|校验失败|验证失败/.test(text) && action === 'upload') {
    message = '云端可能已收到配置，但暂时未能确认结果。请稍后重试，确认同步是否完成。'
  } else if (/cryptography|Python|解释器/i.test(text)) {
    message = '同步环境还没准备好。请到设置中选择支持同步的 Python（3.11 及以上，并安装 cryptography）后重试。'
  } else if (/解密|口令|decrypt/i.test(text)) {
    message = '未能解密云端配置。请确认本机与其他设备使用了相同的同步密钥。'
  } else if (/404|远端无数据|不存在/.test(text)) {
    message = action === 'upload' ? '未找到可上传的配置或同步组件。请确认本机已配置好 mykey。'
      : '未找到可下载的配置或同步组件。请确认云端已有配置，并检查本机同步环境。'
  } else if (/语法|SyntaxError/.test(text)) {
    message = '配置格式有误，未能完成同步。请修正配置后重试。'
  } else if (/timeout|timed out|超时|网络|连接|HTTP|fetch|network/i.test(text)) {
    message = '暂时无法完成同步。请检查网络和同步服务，稍后重试。'
  } else {
    message = action === 'upload' ? '这次上传未能完成，请查看详情了解原因后重试。'
      : '这次同步未能完成，请检查本机配置状态，查看详情后重试。'
  }
  return { title: action === 'upload' ? '暂时未能完成上传' : '暂时未能完成下载', message, detail }
}

import { storageKeys } from '@/config/storageKeys'

export const MYKEY_SHOW_UPLOAD_KEY = storageKeys.mykeyShowUpload
export const MYKEY_SHOW_UPLOAD_EVENT = 'gahub:mykey-show-upload'

export function getMyKeyShowUpload(): boolean {
  try {
    return localStorage.getItem(MYKEY_SHOW_UPLOAD_KEY) === '1'
  } catch {
    return false
  }
}

export function setMyKeyShowUpload(value: boolean): boolean {
  try {
    localStorage.setItem(MYKEY_SHOW_UPLOAD_KEY, value ? '1' : '0')
  } catch { /* storage unavailable — keep in-memory only */ }
  window.dispatchEvent(new CustomEvent<boolean>(MYKEY_SHOW_UPLOAD_EVENT, { detail: value }))
  return value
}
