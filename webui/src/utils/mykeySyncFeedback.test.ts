import { describe, it, expect } from 'vitest'
import { MYKEY_SYNC_CONFIRM, myKeySyncSuccess, myKeySyncFailure } from './mykeySyncUi'

describe('human-friendly MyKey sync feedback', () => {
  it('states both overwrite risks without implementation jargon', () => {
    expect(MYKEY_SYNC_CONFIRM.upload.message).toContain('替换云端')
    expect(MYKEY_SYNC_CONFIRM.fetch.message).toContain('先备份')
    expect(MYKEY_SYNC_CONFIRM.fetch.message).toContain('尚未上传')
  })
  it('never exposes raw paths, hashes or script markers in success text', () => {
    const log = '[fetch] updated D:/private/mykey.py (sha256=deadbeef)'
    expect(myKeySyncSuccess('fetch', log)).toBe('云端配置已同步到本机，模型列表已刷新。')
    expect(myKeySyncSuccess('upload', '[upload] done sha256=deadbeef')).toContain('其他设备')
    expect(myKeySyncSuccess('upload', '[upload] 远端已是最新，无需重复上传')).toContain('无需重复')
    expect(myKeySyncSuccess('fetch', '[fetch] 已是最新')).toBe('本机配置已与云端一致。')
  })
  it('keeps environment diagnostics folded', () => {
    const error = { body: { detail: { message: '缺少 cryptography', command: 'python.exe', stderr: 'ModuleNotFoundError: cryptography' } } }
    const feedback = myKeySyncFailure('fetch', error)
    expect(feedback.message).toContain('设置')
    expect(feedback.detail).toContain('ModuleNotFoundError')
    expect(feedback.message).not.toContain('ModuleNotFoundError')
  })
  it('does not confuse Python command metadata with a missing runtime', () => {
    const feedback = myKeySyncFailure('upload', { body: { detail: { message: '同步服务连接超时', command: 'C:/Python/python.exe upload', stderr: 'TimeoutError' } } })
    expect(feedback.message).toContain('网络')
    expect(feedback.message).not.toContain('Python')
  })
  it('does not claim failed verification rolled back the cloud', () => {
    expect(myKeySyncFailure('upload', new Error('回读校验失败')).message).toContain('可能已收到')
  })
  it('offers a decrypt recovery step without claiming the local file is untouched', () => {
    expect(myKeySyncFailure('fetch', new Error('解密失败')).message).toContain('相同的同步密钥')
    expect(myKeySyncFailure('fetch', new Error('unexpected failure')).message).toContain('本机配置状态')
  })
})
