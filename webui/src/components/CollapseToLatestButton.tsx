/** Answer-local action in the left gutter, held in the lower-middle of the scrollport. */
export function CollapseToLatestButton({ onClick }: { onClick: () => void }) {
  const label = '收起全部并回到最新'
  return <div className="pointer-events-none sticky bottom-[35%] z-20 -ml-10 h-0 w-6 md:bottom-[15%] md:-ml-12 md:w-7">
    <button type="button" data-collapse-to-latest onClick={onClick} title={label} aria-label={label}
      className="pointer-events-auto absolute bottom-0 flex h-6 w-6 items-center justify-center md:h-7 md:w-7 rounded-full border border-line/70 bg-[var(--c-scrollbar-thumb)] bg-gradient-to-b from-bg-card/20 to-transparent text-bg-card shadow-[inset_0_1px_0_rgb(255_255_255_/_0.3),0_2px_5px_rgb(0_0_0_/_0.16)] transition-[filter,background-color,box-shadow] hover:bg-[var(--c-scrollbar-thumb-hover)] hover:brightness-105 hover:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.4),0_3px_7px_rgb(0_0_0_/_0.2)] active:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
      </svg>
    </button>
  </div>
}
