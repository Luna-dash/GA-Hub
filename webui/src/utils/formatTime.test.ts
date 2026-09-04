import { describe, expect, it } from 'vitest'
import { formatDateTime } from './formatTime'

describe('formatDateTime', () => {
  it('accepts epoch seconds and Date inputs interchangeably', () => {
    const epochSeconds = 1_700_000_000
    expect(formatDateTime(epochSeconds)).toBe(formatDateTime(new Date(epochSeconds * 1000)))
  })

  it('renders a full local date-time (never an empty string)', () => {
    const rendered = formatDateTime(0)
    expect(rendered).not.toBe('')
    expect(rendered).toMatch(/\d/)
  })
})
