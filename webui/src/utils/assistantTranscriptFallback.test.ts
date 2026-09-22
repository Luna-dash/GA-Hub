import { describe, expect, it } from 'vitest'
import { fallbackSummary } from './assistantTranscript'

// Fallback summary derivation for turns whose model output missed the
// <summary> protocol. Rules locked with the user on 2026-09-22 after a full
// corpus study (423 derivable turns / 9266) against a Python reference
// implementation; expectations below are the verified reference outputs.
//  - Prefer the first complete sentence within 50 chars (。！？ stops even if short)
//  - A line-ending ： counts as sentence end and is rewritten to 。
//  - No sentence end: downgrade to clause/space break with a trailing ellipsis
//  - Strip summary/parameter label shells and markdown emphasis; keep emoji
//  - Never derive from error or empty turns
describe('fallback summary derivation', () => {
  const cases: Array<[string, string]> = [
    ['关键确认！fluxionai 域调 refresh 返回 200', '关键确认！'],
    ['✅ 测速完成，节点性能如下：\n\n## 报告\n正文', '✅ 测速完成，节点性能如下。'],
    [
      '关键澄清：在 fluxionai 域上调 /api 返回 404 page not found！说明问题',
      '关键澄清：在 fluxionai 域上调 /api 返回 404 page not found！',
    ],
    [
      '<summary>正则转义错误；修正后查 token</arg_value>\n\n🛠️ Tool: x',
      '正则转义错误；修正后查 token',
    ],
    ['重大发现！refresh 返回 401（上一次 200），说明 rt 已失效', '重大发现！'],
    [
      'cookies 命令返回空——前面用户提到登录态存在 l... 开头的 cookie（很可能是 laravel，因为常见）。我用 CDP',
      'cookies 命令返回空——前面用户提到登录态存在 l... 开头的 cookie…',
    ],
    ['[!!! 流异常中断 AttributeError !!!]', ''],
    ['!!!Error: boom', ''],
    ['\n\n## 根因定位结论\n\n已查清。这是**误报** bug', '根因定位结论'],
    ['ADMIN_KEY 已重置为已知值 xyz 并存文件。现在可触发', 'ADMIN_KEY 已重置为已知值 xyz 并存文件。'],
    [
      '✅ 已从 GitHub Releases 拉到官方数据（beta3→beta10，2026-06-11 至 09-06，共 8 个版本）。核心',
      '✅ 已从 GitHub Releases 拉到官方数据…',
    ],
    ['工作记忆已更新。下一步验证策略：本地模拟', '工作记忆已更新。'],
    ['请先修改配置，然后重启服务', '请先修改配置，然后重启服务'],
    ['。。', ''],
    ['', ''],
    // label-shell residue in stray positions (v3 hardening, 2026-09-22)
    ['A 完成</summary>\n\n后面正文继续', 'A 完成'],
    ['|DSML| <parameter name="summary">A 完成</parameter>\n\n正文', 'A 完成'],
    ['<thinking>想想</thinking>\n\n正文若干。继续说', '正文若干。'],
    ['嗯 <parameter name="summary">A 完成</parameter> 就这样', '嗯 A 完成'],
  ]

  it.each(cases)('derives %j -> %j', (input, expected) => {
    expect(fallbackSummary(input)).toBe(expected)
  })
})
