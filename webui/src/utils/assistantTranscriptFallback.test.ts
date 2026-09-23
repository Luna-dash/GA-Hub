import { describe, expect, it } from 'vitest'
import { fallbackSummary } from './assistantTranscript'

// Fallback summary derivation for turns whose model output missed the
// summary protocol. Rules locked with the user on 2026-09-22 after a full
// corpus study (423 derivable turns / 9266) against a Python reference
// implementation; expectations below are the verified reference outputs.
//  - Rev4 (2026-09-23): leads of 80 chars or less are kept whole (cleanup +
//    trailing colon swap only). Over 80: cut at the last sentence end (。！？)
//    within 80, else at the first one after 80, else keep the whole lead. A
//    cut below 15 chars falls back to the whole lead; no ellipsis is ever
//    appended; the bare 'DSML' cut is gone (fixed upstream).
//  - Rev2: a colon never ends a sentence; a trailing ：/: renders as 。
//  - Strip summary/parameter label shells and markdown emphasis; keep emoji
//  - Never derive from error or empty turns
describe('fallback summary derivation', () => {
  const cases: Array<[string, string]> = [
    ['关键确认！fluxionai 域调 refresh 返回 200', '关键确认！fluxionai 域调 refresh 返回 200'],
    ['✅ 测速完成，节点性能如下：\n\n## 报告\n正文', '✅ 测速完成，节点性能如下。'],
    [
      '关键澄清：在 fluxionai 域上调 /api 返回 404 page not found！说明问题',
      '关键澄清：在 fluxionai 域上调 /api 返回 404 page not found！说明问题',
    ],
    [
      '<summary>正则转义错误；修正后查 token</arg_value>\n\n🛠️ Tool: x',
      '正则转义错误；修正后查 token',
    ],
    ['重大发现！refresh 返回 401（上一次 200），说明 rt 已失效', '重大发现！refresh 返回 401（上一次 200），说明 rt 已失效'],
    [
      'cookies 命令返回空——前面用户提到登录态存在 l... 开头的 cookie（很可能是 laravel，因为常见）。我用 CDP',
      'cookies 命令返回空——前面用户提到登录态存在 l... 开头的 cookie（很可能是 laravel，因为常见）。我用 CDP',
    ],
    ['[!!! 流异常中断 AttributeError !!!]', ''],
    ['!!!Error: boom', ''],
    ['\n\n## 根因定位结论\n\n已查清。这是**误报** bug', '根因定位结论'],
    ['ADMIN_KEY 已重置为已知值 xyz 并存文件。现在可触发', 'ADMIN_KEY 已重置为已知值 xyz 并存文件。现在可触发'],
    [
      '✅ 已从 GitHub Releases 拉到官方数据（beta3→beta10，2026-06-11 至 09-06，共 8 个版本）。核心',
      '✅ 已从 GitHub Releases 拉到官方数据（beta3→beta10，2026-06-11 至 09-06，共 8 个版本）。核心',
    ],
    ['工作记忆已更新。下一步验证策略：本地模拟', '工作记忆已更新。下一步验证策略：本地模拟'],
    ['请先修改配置，然后重启服务', '请先修改配置，然后重启服务'],
    ['。。', ''],
    ['', ''],
    // label-shell residue in stray positions (v3 hardening, 2026-09-22)
    ['A 完成</summary>\n\n后面正文继续', 'A 完成'],
    ['|DSML| <parameter name="summary">A 完成</parameter>\n\n正文', 'A 完成'],
    ['<thinking>想想</thinking>\n\n正文若干。继续说', '正文若干。继续说'],
    ['嗯 <parameter name="summary">A 完成</parameter> 就这样', '嗯 A 完成'],
    // rev2+rev3 (2026-09-22): colons never stop; short leads stay whole; trailing ：/: as 。
    [
      '更新检查与隔离验证已完成，结果如下：\n\n## 已完成\n\n- 基于上次更新基点',
      '更新检查与隔离验证已完成，结果如下。',
    ],
    [
      '合并完成，CF 相关 SOP 现在只剩两个，职责清晰：\n\n**1. cf_management_sop.md — CF 总体管理**',
      '合并完成，CF 相关 SOP 现在只剩两个，职责清晰。',
    ],
    ['**新码（刚生成，约 2 分钟有效）：**\n\n# `954473649`', '新码（刚生成，约 2 分钟有效）。'],
    // rev3 (2026-09-22): whole-lead rule & slash-prefixed DSML close residue
    ['重试 run 返回 200(刚才 403 是瞬时):\n\n继续流程。', '重试 run 返回 200(刚才 403 是瞬时)。'],
    ['<summary>找定义与加载流程，确认入口' + '<' + '/' + '｜｜DSML｜｜ parameter>\n\n后文继续', '找定义与加载流程，确认入口'],
    // rev4 (2026-09-23): sentence-end ladder over 80, 15-char minimum, whole-lead fallback, no ellipsis
    [
      '第一句长达十五个字以上因此保留。' + '后续内容没有句终标点所以要一直延伸下去直到总长度超过八十个字符为止'.repeat(3),
      '第一句长达十五个字以上因此保留。',
    ],
    [
      '第一句虽然够长但是继续写下去。第二句收尾。' + '后续内容没有句终标点所以要一直延伸下去直到总长度超过八十个字符为止'.repeat(2),
      '第一句虽然够长但是继续写下去。第二句收尾。',
    ],
    [
      '开' + '无标点的描述文字继续延伸'.repeat(9) + '。' + '尾巴内容继续写',
      '开' + '无标点的描述文字继续延伸'.repeat(9) + '。',
    ],
    [
      'The quick brown fox jumps over the lazy dog repeatedly without any sentence end so this long line just stays whole',
      'The quick brown fox jumps over the lazy dog repeatedly without any sentence end so this long line just stays whole',
    ],
    [
      '。' + '开头就是句终标点接下来是没有任何句终标点的长文本要一直写下去超过八十个字符才能进入截断分支的测试内容啊'.repeat(2),
      '。' + '开头就是句终标点接下来是没有任何句终标点的长文本要一直写下去超过八十个字符才能进入截断分支的测试内容啊'.repeat(2),
    ],
    [
      '甲乙丙丁戊己庚辛壬癸子丑寅。' + '后续内容没有句终标点所以要一直延伸下去直到总长度超过八十个字符为止'.repeat(3),
      '甲乙丙丁戊己庚辛壬癸子丑寅。' + '后续内容没有句终标点所以要一直延伸下去直到总长度超过八十个字符为止'.repeat(3),
    ],
    [
      '甲乙丙丁戊己庚辛壬癸子丑寅卯。' + '后续内容没有句终标点所以要一直延伸下去直到总长度超过八十个字符为止'.repeat(3),
      '甲乙丙丁戊己庚辛壬癸子丑寅卯。',
    ],
    ['探测报告：marker=DSML 标签处理已由外部解决，这里不应再被切断的说明文字', '探测报告：marker=DSML 标签处理已由外部解决，这里不应再被切断的说明文字'],
  ]

  it.each(cases)('derives %j -> %j', (input, expected) => {
    expect(fallbackSummary(input)).toBe(expected)
  })
})
