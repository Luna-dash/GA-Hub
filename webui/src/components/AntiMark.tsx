// Redrawn from the Antigravity favicon’s arched silhouette (antigravity.google/favicon.svg).
// Hub navigation uses rounded, currentColor strokes instead of the native gradient.
export function AntiMark() {
  return <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
    d="M3.1 19.2C7.4 15.3 6.4 4 12 4s4.6 11.3 8.9 15.2C16.4 17.2 16.2 13 12 13s-4.4 4.2-8.9 6.2Z" />
}

export function AntiIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><AntiMark /></svg>
}
