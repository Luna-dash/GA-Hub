// MyKey sync page UI visibility (localStorage-backed, cross-page synced).
//
// 上传 mykey 会用本机内容覆盖同步服务器版本，属于高风险低频操作：
// 按钮默认隐藏，需在「设置」页手动确认后才显示（见 Settings 的 mykey 同步面板）。

export const MYKEY_SHOW_UPLOAD_KEY = 'gahub.mykey-show-upload'
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
