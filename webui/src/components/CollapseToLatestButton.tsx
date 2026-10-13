/** Answer-local action, floating in the left gutter without adding transcript height. */
export function CollapseToLatestButton({ onClick }: { onClick: () => void }) {
  const label = '收起全部并回到最新'
  return <div className="pointer-events-none sticky bottom-3 z-20 -ml-10 h-0 w-6 md:-ml-12 md:w-7">
    <button type="button" data-collapse-to-latest onClick={onClick} title={label} aria-label={label}
      className="pointer-events-auto absolute bottom-0 flex h-6 w-6 items-center justify-center md:h-7 md:w-7 rounded-full border border-line bg-bg-card text-accent shadow-sm transition-colors hover:bg-bg-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
      </svg>
    </button>
  </div>
}
