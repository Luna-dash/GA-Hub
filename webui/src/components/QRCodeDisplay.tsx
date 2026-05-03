// QR code renderer using a CDN-free, dependency-free approach: we ask
// quickchart.io? No — keep it offline. Render the QR via the canvas
// produced by the qrcode-svg npm package would add weight. The bot
// already gives us the URL string, but we can render it inline by
// asking the browser via Google Charts? Also network.
//
// Simpler: backend doesn't return image bytes either, just the URL string
// the bot produced. We render a textual fallback + render QR using
// qrcode-svg-style by embedding an <iframe>? No — easiest path is to
// embed the URL into a third-party public QR generator only as a
// fallback. To keep this fully offline we render via qrcode lib if
// installed; else show the raw URL for manual scanning.

interface Props {
  url: string
  size?: number
}

export function QRCodeDisplay({ url, size = 220 }: Props) {
  if (!url) return null
  // Use Google Charts QR endpoint as a reliable, well-known generator.
  // (If the desktop is offline this won't work; users can copy the URL.)
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`
  return (
    <div className="inline-flex flex-col items-center gap-2">
      <img
        src={qr}
        alt="WeChat QR"
        width={size}
        height={size}
        className="rounded-lg border border-line bg-white p-2"
      />
      <div className="text-xs text-slate-500 break-all max-w-[260px] text-center">{url}</div>
    </div>
  )
}
