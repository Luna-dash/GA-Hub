// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QRCodeDisplay } from './QRCodeDisplay'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('QRCodeDisplay', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders login material into a local SVG without a third-party request', () => {
    act(() => root.render(<QRCodeDisplay url="https://login.example/short-lived-token" />))

    expect(host.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('img')).toBeNull()
    expect(host.innerHTML).not.toContain('qrserver.com')
  })
})
