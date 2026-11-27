import { describe, expect, it } from 'vitest'
import { HttpError, HttpTimeoutError } from '@/api/client'
import { extractErrorMessage } from './errors'

describe('extractErrorMessage', () => {
  it('unwraps FastAPI body.detail strings and structured detail objects', () => {
    expect(extractErrorMessage({ body: { detail: '纯文本 detail' } })).toBe('纯文本 detail')
    expect(extractErrorMessage({ body: { detail: { message: '人话', code: 'E123' } } })).toBe('人话')
    expect(extractErrorMessage({ body: { detail: { detail: '具体错误', code: 'fallback' } } })).toBe('具体错误')
    expect(extractErrorMessage({ body: { detail: { error: '上游失败', code: 'x' } } })).toBe('上游失败')
    expect(extractErrorMessage({ body: { detail: { code: 'project_error', path: 'D:/repo' } } })).toBe('project_error')
    expect(extractErrorMessage({ body: { detail: { path: 'D:/repo' } } })).toBe('{"path":"D:/repo"}')
  })

  it('unwraps top-level body.message and body.error on HttpError without detail', () => {
    expect(extractErrorMessage(new HttpError(400, { message: '参数无效' }))).toBe('参数无效')
    expect(extractErrorMessage(new HttpError(500, { error: '服务异常' }))).toBe('服务异常')
    expect(extractErrorMessage({ body: {}, message: 'transport broken' })).toBe('transport broken')
  })

  it('unwraps JSON-stringified Error.message and string payloads', () => {
    expect(extractErrorMessage(new Error('{"detail":"配置错误"}'))).toBe('配置错误')
    expect(extractErrorMessage(new Error('{"detail":{"message":"嵌套提示"}}'))).toBe('嵌套提示')
    expect(extractErrorMessage(new Error('{"error":"token expired"}'))).toBe('token expired')
    expect(extractErrorMessage('{"message":"字符串 JSON"}')).toBe('字符串 JSON')
    expect(extractErrorMessage('普通文本错误')).toBe('普通文本错误')
  })

  it('formats HttpTimeoutError and NetworkError into user-friendly Chinese messages', () => {
    expect(extractErrorMessage(new HttpTimeoutError('/api/sessions', 30000))).toBe('请求超时，请检查网络或稍后重试')
    const networkErr = new Error('Network request failed: /api/sessions')
    networkErr.name = 'NetworkError'
    ;(networkErr as Error & { code: string }).code = 'network_error'
    expect(extractErrorMessage(networkErr)).toBe('网络连接失败，请检查服务或网络状态后重试')
  })

  it('falls back cleanly for empty or non-object errors', () => {
    expect(extractErrorMessage(null, '未知错误')).toBe('未知错误')
    expect(extractErrorMessage(undefined, '操作失败')).toBe('操作失败')
    expect(extractErrorMessage('   ', '默认提示')).toBe('默认提示')
    expect(extractErrorMessage({}, '默认提示')).toBe('默认提示')
  })

  it('filters serialized null/empty HttpError bodies while preserving fallback messages', () => {
    expect(extractErrorMessage(new HttpError(500, null), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, {}), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, []), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, 'null'), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: {} }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { error: {} }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: [] }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: null }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { message: 'null' }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: { path: 'D:/repo' } }), '服务失败')).toBe('{"path":"D:/repo"}')
    expect(extractErrorMessage(new HttpError(500, { detail: { detail: {} } }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { error: { detail: [] } }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: { error: [] } }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage(new HttpError(500, { detail: { message: 'null' } }), '服务失败')).toBe('服务失败')
    expect(extractErrorMessage({ body: { detail: { detail: {} } }, message: 'transport down' }, '服务失败')).toBe('transport down')
    expect(extractErrorMessage('{"detail":{}}', '服务失败')).toBe('服务失败')
    expect(extractErrorMessage({ body: { detail: {} }, message: 'transport down' })).toBe('transport down')
  })

  it('extracts FastAPI 422 validation detail arrays and nested error objects', () => {
    expect(
      extractErrorMessage(
        new HttpError(422, {
          detail: [{ loc: ['body', 'name'], msg: 'Field required', type: 'missing' }],
        }),
      ),
    ).toBe('Field required')
    expect(
      extractErrorMessage(
        new HttpError(422, {
          detail: [
            { loc: ['body', 'name'], msg: '名称不能为空' },
            { loc: ['body', 'port'], msg: '端口无效' },
          ],
        }),
      ),
    ).toBe('名称不能为空；端口无效')
    expect(
      extractErrorMessage(new HttpError(502, { error: { message: 'upstream rate limit', type: 'rate_limit' } })),
    ).toBe('upstream rate limit')
    expect(
      extractErrorMessage(new HttpError(500, { detail: { error: { message: 'nested upstream error' } } })),
    ).toBe('nested upstream error')
    expect(extractErrorMessage(new Error('{"detail":[{"msg":"invalid payload"}]}'))).toBe('invalid payload')
    expect(extractErrorMessage(new Error('{"error":{"message":"json nested error"}}'))).toBe('json nested error')
  })
})
