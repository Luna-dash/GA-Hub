import { describe, expect, it } from 'vitest'
import { filterAntiSlashCommands } from './antiSlashCommands'

describe('antiSlashCommands', () => {
  const upstream = [
    { name: 'browser', description: 'Interact with web pages via headless browser' },
    { name: 'schedule', description: 'Run a scheduled recurring prompt' },
    { name: 'exit', description: 'Quit the CLI session' },
    { name: 'clear', description: 'Clear terminal history' },
    { name: 'login', description: 'Sign in with Google' },
    { name: 'model', description: 'Switch active model' },
    { name: 'help', description: 'Show TUI help' },
    { name: 'teamwork', description: 'Coordinate multiple autonomous agents together' },
    { name: 'plan', description: 'Enter planning mode carefully before coding' },
    { name: 'my-deploy', description: 'Deploy service to staging' },
    { name: 'compact', description: 'Compact conversation history to save quota' },
    { name: 'swarm', description: 'Start multi-agent swarm board' },
    { name: 'review', description: '已有的中文审查说明' },
  ]

  it('blocks TUI-only and /schedule commands even when explicitly searched', () => {
    for (const blocked of ['schedule', 'exit', 'clear', 'login', 'model', 'help']) {
      const bare = filterAntiSlashCommands(upstream, '')
      expect(bare.items.some((item) => item.name === blocked)).toBe(false)

      const searched = filterAntiSlashCommands(upstream, blocked)
      expect(searched.items.some((item) => item.name === blocked)).toBe(false)
    }
  })

  it('shows core commands in priority order plus custom commands and folds secondary ones on bare /', () => {
    const res = filterAntiSlashCommands(upstream, '')
    expect(res.items.map((item) => item.name)).toEqual(['compact', 'plan', 'review', 'my-deploy'])
    expect(res.hiddenCount).toBe(3)
    expect(res.totalAvailable).toBe(7)
    expect(res.items.find((item) => item.name === 'compact')?.description).toBe('压缩当前对话上下文，节省额度')
    expect(res.items.find((item) => item.name === 'plan')?.hint).toBe('<目标>')
    // Preserves upstream Chinese description verbatim.
    expect(res.items.find((item) => item.name === 'review')?.description).toBe('已有的中文审查说明')
  })

  it('reveals folded secondary commands when user types name or Chinese/English keywords', () => {
    const byName = filterAntiSlashCommands(upstream, 'team')
    expect(byName.hiddenCount).toBe(0)
    expect(byName.items.map((item) => item.name)).toEqual(['teamwork'])
    expect(byName.items[0].description).toBe('多 Agent 协作拆解大型任务')

    const byPrefix = filterAntiSlashCommands(upstream, 'br')
    expect(byPrefix.items.map((item) => item.name)).toEqual(['browser'])

    const byChineseDesc = filterAntiSlashCommands(upstream, '浏览器')
    expect(byChineseDesc.items.map((item) => item.name)).toEqual(['browser'])

    const byUpstreamEnglish = filterAntiSlashCommands(upstream, 'headless')
    expect(byUpstreamEnglish.items.map((item) => item.name)).toEqual(['browser'])
  })

  it('handles empty command lists and secondary-only command lists safely', () => {
    expect(filterAntiSlashCommands([], '')).toEqual({
      items: [],
      hiddenCount: 0,
      totalAvailable: 0,
    })

    const onlySecondary = filterAntiSlashCommands(
      [
        { name: 'swarm', description: 'Run swarm' },
        { name: 'browser', description: 'Browse web' },
      ],
      '',
    )
    expect(onlySecondary.items.map((item) => item.name)).toEqual(['swarm', 'browser'])
    expect(onlySecondary.hiddenCount).toBe(0)
    expect(onlySecondary.totalAvailable).toBe(2)
  })
})
