import { CollapseChevronsIcon } from './ActionIcons'

/** Shared icon; the conversation supplies a viewport-fixed placement. */
export function CollapseToLatestButton({ onClick, fixedToViewport = false }: { onClick: () => void; fixedToViewport?: boolean }) {
  const label = '收起全部并回到最新'
  return <div data-conversation-collapse={fixedToViewport || undefined} className={fixedToViewport
    ? 'pointer-events-none absolute bottom-[calc(35%+48px)] left-1 z-20 h-0 w-6 md:bottom-[calc(15%+56px)] md:left-2 md:w-7'
    : 'pointer-events-none sticky bottom-[calc(35%+48px)] z-20 -ml-10 h-0 w-6 md:bottom-[calc(15%+56px)] md:-ml-12 md:w-7'}>
    <button type="button" data-collapse-to-latest onClick={onClick} title={label} aria-label={label}
      className="pointer-events-auto absolute bottom-0 flex h-6 w-6 items-center justify-center md:h-7 md:w-7 rounded-full border border-[#54432B]/70 bg-[#6B583D] bg-gradient-to-b from-bg-card/15 to-transparent text-[#FAF4E6] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.25),0_2px_5px_rgb(0_0_0_/_0.18)] transition-[background-color,box-shadow] hover:bg-[#5A4932] hover:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.3),0_3px_7px_rgb(0_0_0_/_0.22)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <CollapseChevronsIcon direction="collapse" className="h-4 w-4" />
    </button>
  </div>
}
