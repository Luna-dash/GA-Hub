import { describe, expect, it } from 'vitest'
import { normalizeMathDelimiters } from './mathMarkdown'

describe('normalizeMathDelimiters', () => {
  it('keeps \\(...\\) inline while promoting \\[...\\] to display blocks (session fc532b46)', () => {
    const input = [
      '\\[',
      '\\text{敌人摘要} = \\phi(A) + \\phi(B)',
      '\\]',
      '',
      '加法不看顺序，所以换成 \\(\\phi(B)+\\phi(A)\\)，摘要不变。得到上下文 \\(h\\)。',
    ].join('\n')

    const out = normalizeMathDelimiters(input)
    expect(out).toContain('$$\n\\text{敌人摘要} = \\phi(A) + \\phi(B)\n$$')
    expect(out).toContain('换成 $$\\phi(B)+\\phi(A)$$，摘要不变。得到上下文 $$h$$。')
    expect(out).not.toContain('\n$$\n\\phi(B)+\\phi(A)\n$$\n')
    expect(out).not.toContain('\n$$\nh\n$$\n')
  })

  it('collapses soft line breaks inside \\(...\\) to keep inline flow', () => {
    const input = '公式为 \\(\\alpha +\n  \\beta\\) 成立。'
    expect(normalizeMathDelimiters(input)).toBe('公式为 $$\\alpha + \\beta$$ 成立。')
  })

  it('promotes standalone single-line $$...$$ to display block but keeps inline $$...$$ inline', () => {
    expect(normalizeMathDelimiters('$$E = mc^2$$')).toBe('$$\nE = mc^2\n$$')
    expect(normalizeMathDelimiters('> $$E = mc^2$$')).toBe('> $$\n> E = mc^2\n> $$')
    expect(normalizeMathDelimiters('设 $$a$$ 与 $$b$$ 满足条件')).toBe('设 $$a$$ 与 $$b$$ 满足条件')
    expect(normalizeMathDelimiters('$$a$$ + $$b$$')).toBe('$$a$$ + $$b$$')
  })

  it('preserves blockquote and list indentation for \\[...\\]', () => {
    expect(normalizeMathDelimiters('> \\[ a = b \\]')).toBe('> $$\n> a = b\n> $$')
    expect(normalizeMathDelimiters('公式：\\[ x = 1 \\] 结束')).toBe('公式：\n$$\nx = 1\n$$\n结束')
    expect(normalizeMathDelimiters('- 项：\n  \\[ y = 2 \\]')).toBe('- 项：\n  $$\n  y = 2\n  $$')
  })

  it('does not turn escaped markdown bracket citations like \\[1\\] into display math', () => {
    const input = '参见文献 \\[1\\] 和 \\[2, 3\\]，以及 \\[TODO\\]。'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('does not pair an unclosed \\[ with a later \\] across a blank line', () => {
    const input = '第一段误写了未闭合 \\[ 说明\n\n第二段后面有个 \\] 结尾'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('normalizes guarded single-dollar inline math without touching currency or shell variables', () => {
    expect(normalizeMathDelimiters('其中 $Q(s, a)$ 表示价值，$h_t \\in \\mathbb{R}^d$。'))
      .toBe('其中 $$Q(s, a)$$ 表示价值，$$h_t \\in \\mathbb{R}^d$$。')
    expect(normalizeMathDelimiters('上下文$h$来打分')).toBe('上下文$$h$$来打分')
    expect(normalizeMathDelimiters('设 $\\text{损失} = a + b$ 且 $1+1=2$。'))
      .toBe('设 $$\\text{损失} = a + b$$ 且 $$1+1=2$$。')

    // Currency & shell protections
    for (const literal of [
      '价格从 $5 涨到 $10 了',
      '区间 ($5-$10) 内',
      '成本$5涨到$10',
      '输出 $PATH 和 $HOME。',
      '变量 "$PATH/$HOME" 测试',
      '展开 ${FOO} 和 ${BAR}',
      '价格为 \\$5 和 \\$10',
      '总计 $5.00 + $3.00 = $8.00',
    ]) {
      expect(normalizeMathDelimiters(literal)).toBe(literal)
    }

    // Mixed currency and math on the same line
    expect(normalizeMathDelimiters('价格是 $5，变量是 $x$。'))
      .toBe('价格是 $5，变量是 $$x$$。')
  })

  it('skips fenced code blocks, tilde fences, inline code spans, and existing $$ blocks', () => {
    const input = [
      '```bash',
      'echo $PATH $HOME',
      'printf "\\(x\\)"',
      '```',
      '',
      '````markdown',
      '\\[y = 1\\]',
      '````',
      '',
      '~~~tex',
      '$a + b$',
      '~~~',
      '',
      '行内代码 `\\(x\\)` 与 `$HOME` 不变。',
      '',
      '$$',
      'f(x) \\\\ (a + b)',
      '$$',
    ].join('\n')

    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('leaves link metadata literal while normalizing math in explicit link labels', () => {
    const suffix = '](https://example.test/$value$ "价格 $rate$") [引用][ref]\n\n'
      + '[ref]: https://example.test/$path$ "标题 $name$"'
    expect(normalizeMathDelimiters('[公式 $x$' + suffix)).toBe('[公式 $$x$$' + suffix)
  })

  it('keeps shortcut and collapsed reference keys aligned with their definition', () => {
    const input = '[公式 $x$] [公式 $x$][]\n\n[公式 $x$]: /path'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('escapes unescaped pipes in inline math inside GFM table rows', () => {
    const input = '| 符号 | 含义 |\n|---|---|\n| $|x|$ | $P(y|x)$ |'
    expect(normalizeMathDelimiters(input))
      .toBe('| 符号 | 含义 |\n|---|---|\n| $$\\vert x\\vert $$ | $$P(y\\vert x)$$ |')
  })
})
