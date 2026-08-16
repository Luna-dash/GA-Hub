import { describe, expect, it } from 'vitest'
import { deriveFeishuUiState } from './feishuStatus'

describe('deriveFeishuUiState', () => {
  it('does not report missing configuration before the keychain check completes', () => {
    expect(deriveFeishuUiState({
      statusLoaded: true,
      connected: false,
      checkReady: undefined,
      checkPending: true,
      checkFailed: false,
    }).label).toBe('检测中')
  })

  it('keeps a failed check distinct from confirmed missing keys', () => {
    expect(deriveFeishuUiState({
      statusLoaded: true,
      connected: false,
      checkReady: undefined,
      checkPending: false,
      checkFailed: true,
    }).label).toBe('检测失败')
  })

  it('only reports unconfigured after an explicit ready=false result', () => {
    expect(deriveFeishuUiState({
      statusLoaded: true,
      connected: false,
      checkReady: false,
      checkPending: false,
      checkFailed: false,
    }).label).toBe('未配置')
  })

  it('treats a running gateway as connected even while the config probe is pending', () => {
    expect(deriveFeishuUiState({
      statusLoaded: true,
      connected: true,
      pid: 20284,
      checkReady: undefined,
      checkPending: true,
      checkFailed: false,
    })).toMatchObject({ label: '已连接', text: 'PID 20284' })
  })

  it('reports configured keys with a stopped gateway as disconnected', () => {
    expect(deriveFeishuUiState({
      statusLoaded: true,
      connected: false,
      checkReady: true,
      checkPending: false,
      checkFailed: false,
    }).label).toBe('未连接')
  })
})
