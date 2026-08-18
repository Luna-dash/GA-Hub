// Render login material locally. Sending the URL to a public QR endpoint
// would disclose a short-lived credential and also break offline desktop use.

import { QRCodeSVG } from 'qrcode.react'

interface Props {
  url: string
  size?: number
}

export function QRCodeDisplay({ url, size = 220 }: Props) {
  if (!url) return null
  return (
    <div className="inline-flex flex-col items-center gap-2">
      <div
        role="img"
        aria-label="WeChat QR"
        className="rounded-lg border border-line bg-white p-2"
      >
        <QRCodeSVG value={url} size={size} level="M" marginSize={1} />
      </div>
      <div className="text-xs text-slate-500 break-all max-w-[260px] text-center">{url}</div>
    </div>
  )
}
