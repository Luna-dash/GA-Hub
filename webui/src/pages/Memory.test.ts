import { describe, expect, it } from 'vitest'
import { filterSops } from './Memory'

describe('filterSops', () => {
  const sops = [
    { name: 'scheduled_task_sop' },
    { name: 'desktop_ga_automation_sop' },
    { name: 'SOP_testing' },
  ]

  it('matches SOP names by case-insensitive prefix', () => {
    expect(filterSops(sops, 's').map((sop) => sop.name)).toEqual([
      'scheduled_task_sop',
      'SOP_testing',
    ])
    expect(filterSops(sops, 'DESK').map((sop) => sop.name)).toEqual([
      'desktop_ga_automation_sop',
    ])
  })

  it('does not match a query found only in the middle of a name', () => {
    expect(filterSops(sops, 'task')).toEqual([])
  })

  it('trims the query and returns all SOPs for a blank query', () => {
    expect(filterSops(sops, '  ')).toEqual(sops)
  })
})
