// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView } from './MarkdownView'
import { FileLinkContext, FileTransferConclusion, CitationLink, PathLink, isLocalCitation } from './FileCitation'
import { MemoryRouter, useLocation } from 'react-router-dom'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  addTransferFile: vi.fn(),
  revealFile: vi.fn(),
  resolveFile: vi.fn(),
  clipboardWrite: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { revealFile: mocks.revealFile, resolveFile: mocks.resolveFile },
}))

vi.mock('./FileTransferBox', () => ({
  addTransferFile: mocks.addTransferFile, fileTransferQueryKey: ['file-transfer'],
}))

vi.mock('@/stores/toastStore', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

describe('MarkdownView responsive wrapping', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.addTransferFile.mockReset()
    mocks.addTransferFile.mockResolvedValue(undefined)
    mocks.revealFile.mockReset()
    mocks.revealFile.mockResolvedValue({ ok: true, path: '' })
    mocks.resolveFile.mockReset()
    mocks.resolveFile.mockResolvedValue({
      raw: '', resolved: null, exists: false, is_dir: false, ambiguous: false,
    })
    mocks.clipboardWrite.mockReset()
    mocks.clipboardWrite.mockResolvedValue(undefined)
    ;(navigator as unknown as { clipboard: unknown }).clipboard = {
      writeText: mocks.clipboardWrite,
    }
    // writeClipboard() falls back to execCommand outside secure contexts;
    // jsdom is not secure, so pin the secure path for the mock.
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it.each(['chat', 'plain'] as const)('allows long unbroken %s content to shrink and wrap', (mode) => {
    const detail = `_运行错误（stream_error）：${'AttributeError'.repeat(30)}_`
    act(() => root.render(<MarkdownView mode={mode}>{detail}</MarkdownView>))

    const prose = host.querySelector('.prose-chat')
    expect(prose?.classList.contains('min-w-0')).toBe(true)
    expect(prose?.classList.contains('max-w-full')).toBe(true)
    expect(prose?.classList.contains('[overflow-wrap:anywhere]')).toBe(true)
    expect(prose?.textContent).toContain('AttributeError')
  })

  it.each([
    String.raw`C:\Users\Luna\New project\final report.docx`,
    '/tmp/New project/final report.pdf',
  ])('opens a complete FILE marker path containing spaces: %s', async (path) => {
    mocks.resolveFile.mockResolvedValue({ resolved: path, exists: true, is_dir: false })
    act(() => root.render(
      <MarkdownView mode="plain">{`交付物：[FILE:${path}] 后续说明`}</MarkdownView>,
    ))

    const link = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title.startsWith(path))
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain(path)
    expect(host.textContent).toContain('后续说明')

    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.revealFile).toHaveBeenCalledTimes(1)
    expect(mocks.revealFile).toHaveBeenCalledWith(path, 'open')
  })

  it('does not turn an empty FILE marker into a path button', () => {
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:   ]'}</MarkdownView>))

    expect(host.querySelector('button[title^="打开文件"]')).toBeNull()
    expect(mocks.revealFile).not.toHaveBeenCalled()
  })

  it.each([
    ['/D:/study/GA/temp/project_artifacts/intercepter-b964d989/patent_templates/技术交底书_润色排版版.docx', '/D:/study/GA/temp/project_artifacts/intercepter-b964d989/patent_templates/技术交底书_润色排版版.docx'],
    ['patent_templates/技术交底书.pdf', 'patent_templates/技术交底书.pdf'],
    ['docs/a%20b%23%2B%25.md', 'docs/a b#+%.md'],
    ['docs/literal%2520name.md', 'docs/literal%20name.md'],
    ['file:///D:/docs/a%2520b.md', 'file:///D:/docs/a%2520b.md'],
  ])('resolves the filesystem path from the Markdown URL %s', async (url, expected) => {
    const resolved = 'D:/resolved/交底书.docx'
    mocks.resolveFile.mockResolvedValue({ raw: expected, resolved, exists: true, is_dir: false, ambiguous: false })
    act(() => root.render(<FileLinkContext.Provider value={{ sessionId: 'intercepter-session' }}><MarkdownView>{`[文档](${url})`}</MarkdownView></FileLinkContext.Provider>))
    expect(mocks.resolveFile).not.toHaveBeenCalled()
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
    expect(mocks.resolveFile).toHaveBeenCalledWith(expected, 'intercepter-session')
    expect(mocks.revealFile).toHaveBeenCalledWith(resolved, 'open')
  })

  it('preserves literal percent escapes in raw file citations', async () => {
    const path = 'docs/literal%20name.md'
    act(() => root.render(<MarkdownView>{`[FILE:${path}]`}</MarkdownView>))
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
    expect(mocks.resolveFile).toHaveBeenCalledWith(path, undefined)
  })

  it('offers resolve-aware actions on the path-link context menu', async () => {
    mocks.resolveFile.mockResolvedValue({
      raw: 'temp/report.md',
      resolved: 'D:/GA/temp/report.md',
      exists: true,
      is_dir: false,
      ambiguous: false,
    })
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:temp/report.md]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })

    const link = host.querySelector<HTMLButtonElement>('button')
    expect(link).not.toBeNull()
    expect(mocks.resolveFile).not.toHaveBeenCalled()

    await act(async () => {
      link!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 10,
      }))
      await Promise.resolve()
    })
    expect(link?.title).toContain('D:/GA/temp/report.md')
    const labels = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent)
    expect(labels).toContain('定位文件')
    expect(labels).toContain('在资源管理器中显示')
    expect(labels).toContain('复制完整路径')
    expect(labels).toContain('复制所在文件夹')

    const copyItem = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '复制完整路径')
    await act(async () => { copyItem?.click(); await Promise.resolve() })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith('D:/GA/temp/report.md')
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it.each(['pelican_bicycle_v2.svg', './pelican_bicycle_v2.svg', 'report.pdf?download=1', '报告.svg'])('renders file target %s as an action without eager resolution or navigation', async (target) => {
    act(() => root.render(<MarkdownView mode="chat">{`[文件 **下载**](${target})`}</MarkdownView>))
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('文件 下载')
    expect(host.querySelector('strong')?.textContent).toBe('下载')
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('button')).not.toBeNull()
    expect(mocks.resolveFile).not.toHaveBeenCalled()
    expect(mocks.revealFile).not.toHaveBeenCalled()
  })

  it('keeps web URLs, app routes and fragments as links', () => {
    act(() => root.render(<MarkdownView>{'[web](https://example.com/report.svg) [route](/chat) [anchor](#section) [mail](mailto:a@example.com)'}</MarkdownView>))
    expect([...host.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      'https://example.com/report.svg', '/chat', '#section', 'mailto:a@example.com',
    ])
  })

  it('still resolves and opens explicit FILE markers with bare filenames', async () => {
    const path = 'D:/study/GA/temp/pelican_bicycle_v2.svg'
    mocks.resolveFile.mockResolvedValue({ raw: 'pelican_bicycle_v2.svg', resolved: path, exists: true, is_dir: false, ambiguous: false })
    act(() => root.render(<MarkdownView>{'[FILE:pelican_bicycle_v2.svg]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })
    expect(mocks.resolveFile).not.toHaveBeenCalled()
    expect(host.querySelector('a')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve() })
    expect(mocks.revealFile).toHaveBeenCalledWith(path, 'open')
    expect(host.querySelector('button')?.title).toContain(path)
  })

  it('disables open actions when the cited path cannot be resolved', async () => {
    mocks.resolveFile.mockResolvedValue({
      raw: 'temp/ghost.md', resolved: null, exists: false, is_dir: false, ambiguous: false,
    })
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:temp/ghost.md]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 10,
      }))
      await Promise.resolve()
    })
    const items = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    const openItem = items.find((button) => button.textContent === '定位文件')
    const copyItem = items.find((button) => button.textContent === '复制完整路径')
    expect(openItem?.disabled).toBe(true)
    expect(copyItem?.disabled).toBe(true)
  })
  it('keeps resources, routes and unsafe schemes out of file resolution', () => {
    for (const target of ['/chat', '/anti', '/theme-tasks?open=1', '#here', '/api/files/id.pdf', '/api/files-by-path?path=x',
      'https://example.com/a.md', 'javascript:alert(1)']) expect(isLocalCitation(target)).toBe(false)
    for (const target of ['report.md', '../notes/a.md', '/tmp/a.md', 'file:///D:/a.md']) expect(isLocalCitation(target)).toBe(true)
    act(() => root.render(<MarkdownView>{'[bad](javascript:alert) [attachment](/api/files/a.pdf) [anchor](#here)'}</MarkdownView>))
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(host.querySelector('a[href="/api/files/a.pdf"]')?.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('a[href="#here"]')).not.toBeNull()
    expect(mocks.resolveFile).not.toHaveBeenCalled()
  })

  it('changes app route using the router', async () => {
    function RouteProbe() { return <output>{useLocation().pathname}</output> }
    act(() => root.render(<MemoryRouter initialEntries={['/chat']}><CitationLink href="/settings">settings</CitationLink><RouteProbe /></MemoryRouter>))
    await act(async () => { host.querySelector('a')!.click() })
    expect(host.querySelector('output')?.textContent).toBe('/settings')
    expect(mocks.resolveFile).not.toHaveBeenCalled()
  })

  it('adds a resolved conclusion link only after choosing the context menu action', async () => {
    mocks.resolveFile.mockResolvedValue({ resolved: 'D:/docs/a.md', exists: true, is_dir: false })
    act(() => root.render(<FileLinkContext.Provider value={{ sessionId: 'anti-session', engine: 'anti' }}>
      <FileTransferConclusion.Provider value={{ engine: 'anti', project: 'docs' }}>
        <PathLink path="a.md" display="a" />
      </FileTransferConclusion.Provider>
    </FileLinkContext.Provider>))
    await act(async () => { host.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(mocks.resolveFile).toHaveBeenCalledWith('a.md', 'anti-session', 'anti')
    expect(mocks.addTransferFile).not.toHaveBeenCalled()
    const save = [...document.body.querySelectorAll('button')].find(b => b.textContent === '放入中转箱')!
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    expect(mocks.addTransferFile).toHaveBeenCalledTimes(1)
    expect(mocks.addTransferFile).toHaveBeenCalledWith({ path: 'D:/docs/a.md', engine: 'anti', session_id: 'anti-session', project: 'docs' })
  })

  it('does not offer the transfer action outside conclusions', async () => {
    mocks.resolveFile.mockResolvedValue({ resolved: 'D:/docs/a.md', exists: true, is_dir: false })
    act(() => root.render(<FileLinkContext.Provider value={{ sessionId: 'chat-session' }}><PathLink path="a.md" display="a" /></FileLinkContext.Provider>))
    await act(async () => { host.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(document.body.textContent).not.toContain('放入中转箱')
    expect(mocks.addTransferFile).not.toHaveBeenCalled()
  })

  it('merges concurrent lookups and hands off an action only once', async () => {
    let done!: (value: unknown) => void
    mocks.resolveFile.mockReturnValue(new Promise(resolve => { done = resolve }))
    let opened!: () => void
    mocks.revealFile.mockReturnValue(new Promise<void>(resolve => { opened = resolve }))
    act(() => root.render(<><PathLink path="a.md" display="one" /><PathLink path="a.md" display="two" /></>))
    await act(async () => {
      host.querySelectorAll('button').forEach(button => button.click())
      done({ resolved: 'D:/a.md', exists: true, is_dir: false })
    })
    expect(mocks.resolveFile).toHaveBeenCalledTimes(1)
    expect(mocks.revealFile).toHaveBeenCalledTimes(1)
    await act(async () => { opened() })
  })

  it('does not open a stale lookup after changing projects', async () => {
    let done!: (value: unknown) => void
    mocks.resolveFile.mockReturnValue(new Promise(resolve => { done = resolve }))
    const view = (sessionId: string) => <FileLinkContext.Provider value={{ sessionId, projectPath: sessionId }}><PathLink path="a.md" display="a" /></FileLinkContext.Provider>
    act(() => root.render(view('first')))
    await act(async () => { host.querySelector('button')!.click() })
    act(() => root.render(view('second')))
    await act(async () => { done({ resolved: 'D:/first/a.md', exists: true }) })
    expect(mocks.revealFile).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('allows the same link to be activated again after a completed reveal', async () => {
    mocks.resolveFile.mockResolvedValue({ resolved: 'D:/docs/a.md', candidates: [], ambiguous: false })
    act(() => root.render(<PathLink path="a.md" display="a" />))
    const button = host.querySelector('button')!
    for (let i = 0; i < 3; i++) {
      await act(async () => { button.click() })
      expect(button.disabled).toBe(false)
      expect(mocks.revealFile).toHaveBeenCalledTimes(i + 1)
    }
    // Revalidate the path on every new activation; only concurrent lookups share work.
    expect(mocks.resolveFile).toHaveBeenCalledTimes(3)
  })

  it('releases the activation lock after an error and suppresses only in-flight clicks', async () => {
    mocks.resolveFile.mockResolvedValue({ resolved: 'D:/docs/a.md', candidates: [], ambiguous: false })
    let rejectReveal!: (reason: Error) => void
    mocks.revealFile.mockImplementationOnce(() => new Promise((_, reject) => { rejectReveal = reject }))
    act(() => root.render(<PathLink path="a.md" display="a" />))
    const button = host.querySelector('button')!
    await act(async () => { button.click() })
    expect(button.disabled).toBe(true)
    act(() => button.click())
    expect(mocks.revealFile).toHaveBeenCalledTimes(1)
    await act(async () => { rejectReveal(new Error('temporary failure')) })
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(mocks.revealFile).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(false)
  })

  it('requires selection when lookup has multiple candidates', async () => {
    mocks.resolveFile.mockResolvedValue({ resolved: null, candidates: ['D:/a.md', 'D:/docs/a.md'], ambiguous: true })
    act(() => root.render(<PathLink path="a.md" display="a" />))
    await act(async () => { host.querySelector('button')!.click() })
    expect(mocks.revealFile).not.toHaveBeenCalled()
    await act(async () => { [...document.body.querySelectorAll('button')].find(b => b.textContent === 'D:/docs/a.md')!.click() })
    expect(mocks.revealFile).toHaveBeenCalledWith('D:/docs/a.md', 'open')
  })

  it('renders \\(...\\) inline inside paragraphs while keeping \\[...\\] as display math', () => {
    const md = [
      '\\[',
      '\\text{敌人摘要} = \\phi(A) + \\phi(B)',
      '\\]',
      '',
      '加法不看顺序，换成 \\(\\phi(B)+\\phi(A)\\)，得到上下文 \\(h\\)。',
    ].join('\n')
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    const displays = host.querySelectorAll('.katex-display')
    expect(displays).toHaveLength(1)
    expect(displays[0].textContent).toContain('敌人摘要')

    const paragraphs = [...host.querySelectorAll('p')]
    const prosePara = paragraphs.find((p) => p.textContent?.includes('加法不看顺序'))
    expect(prosePara).toBeDefined()
    expect(prosePara?.querySelectorAll('.md-math-inline')).toHaveLength(2)
    expect(prosePara?.querySelectorAll('.katex-display')).toHaveLength(0)
  })

  it('renders standalone single-line $$...$$ as display math and guarded $...$ as inline math', () => {
    const md = [
      '$$E = mc^2$$',
      '',
      '其中 $x_i$ 为输入特征，而价格 $5 到 $10 与 $PATH/$HOME 保持原文。',
    ].join('\n')
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    expect(host.querySelectorAll('.katex-display')).toHaveLength(1)
    const prosePara = [...host.querySelectorAll('p')].find((p) => p.textContent?.includes('其中'))
    expect(prosePara?.querySelectorAll('.md-math-inline')).toHaveLength(1)
    expect(prosePara?.textContent).toContain('$5 到 $10')
    expect(prosePara?.textContent).toContain('$PATH/$HOME')
  })

  it('emits KaTeX 0.18 DOM classes matching katex.min.css for nested super/subscripts', () => {
    act(() => root.render(<MarkdownView mode="chat">{'$$x_i + x^{y^z}$$'}</MarkdownView>))

    expect(host.querySelector('.katex .katex-base')).not.toBeNull()
    expect(host.querySelector('.katex .katex-sizing.reset-size6.size3')).not.toBeNull()
    expect(host.querySelector('.katex .katex-sizing.reset-size3.size1')).not.toBeNull()
  })

  it('keeps math delimiters literal and fenced math blocks unrendered in plain mode', () => {
    const md = '$$E = mc^2$$\n\n(h) and $x_i$\n\n```math\na + b\n```'
    act(() => root.render(<MarkdownView mode="plain">{md}</MarkdownView>))

    expect(host.querySelector('.katex')).toBeNull()
    expect(host.textContent).toContain('$$E = mc^2$$')
    expect(host.textContent).toContain('$x_i$')
    expect(host.querySelector('pre code')?.textContent).toContain('a + b')
  })

  it('keeps dollar signs in inline and reference link destinations', () => {
    const md = '[直接](https://example.test/$value$ "价格 $rate$")， [引用][ref]，公式 $x$。\n\n'
      + '[ref]: https://example.test/$path$ "标题 $name$"'
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    const links = [...host.querySelectorAll('a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.test/$value$',
      'https://example.test/$path$',
    ])
    expect(host.querySelectorAll('.md-math-inline')).toHaveLength(1)
  })

  it.each([
    '    echo $x$ and \\(x\\)',
    '> ~~~sh\n> echo $x$ and \\(x\\)\n> ~~~',
    '>     echo $x$ and \\(x\\)',
  ])('keeps code literals unchanged in %j', (md) => {
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    expect(host.querySelector('pre code')?.textContent).toBe('echo $x$ and \\(x\\)\n')
  })

  it.each([
    ['名称 | 公式 | 含义\n--- | --- | ---\n样例 | \\(|x|\\) | 绝对值', '绝对值'],
    ['| 名称 | 公式 | 含义 |\n| --- | --- | --- |\n| 样例 | \\(||x||\\) | 范数 |', '范数'],
  ])('keeps formula pipes inside a single GFM cell in %j', (md, meaning) => {
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    const cells = host.querySelectorAll('tbody td')
    expect(cells).toHaveLength(3)
    expect(cells[1].querySelector('.katex')).not.toBeNull()
    expect(cells[2].textContent).toBe(meaning)
  })

  it('keeps formula pipes inside a GFM header cell without leading pipes', () => {
    const md = '> 名称 | \\(||x||\\) | 含义\n> --- | --- | ---\n> 样例 | 内容 | 范数'
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    const headers = host.querySelectorAll('blockquote thead th')
    expect(headers).toHaveLength(3)
    expect(headers[1].querySelector('.katex')).not.toBeNull()
    expect(headers[2].textContent).toBe('含义')
  })

  it('renders inline math containing vertical bars inside GFM tables without splitting cells', () => {
    const md = '| 符号 | 含义 |\n|---|---|\n| $|x|$ | 绝对值 |'
    act(() => root.render(<MarkdownView mode="chat">{md}</MarkdownView>))

    const cells = host.querySelectorAll('tbody td')
    expect(cells).toHaveLength(2)
    expect(cells[0].querySelector('.katex')).not.toBeNull()
    expect(cells[1].textContent).toBe('绝对值')
  })

  it('offers transfer-box saving on local artifact images only inside conclusions', async () => {
    const md = '![产物预览](/api/files-by-path?path=D%3A%2Ftemp%2Fchart.png)'
    act(() => root.render(
      <FileLinkContext.Provider value={{ sessionId: 'anti-session', project: 'docs', engine: 'anti' }}>
        <MarkdownView mode="chat">{md}</MarkdownView>
      </FileLinkContext.Provider>,
    ))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/files-by-path?path=D%3A%2Ftemp%2Fchart.png')
    expect(host.querySelector('button[aria-label="将图片放入中转箱"]')).toBeNull()

    act(() => root.render(
      <FileLinkContext.Provider value={{ sessionId: 'anti-session', project: 'docs', engine: 'anti' }}>
        <FileTransferConclusion.Provider value={{ engine: 'anti', project: 'docs' }}>
          <MarkdownView mode="chat">{md}</MarkdownView>
        </FileTransferConclusion.Provider>
      </FileLinkContext.Provider>,
    ))
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="将图片放入中转箱"]')
    expect(btn).not.toBeNull()
    await act(async () => { btn!.click() })
    expect(mocks.addTransferFile).toHaveBeenCalledWith({
      path: 'D:/temp/chart.png',
      engine: 'anti',
      session_id: 'anti-session',
      project: 'docs',
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已放入中转箱')
  })
})
