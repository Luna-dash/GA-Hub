import { CollapseChevronsIcon } from './ActionIcons'

/** Shared icon; the conversation supplies a viewport-fixed placement. */
export function CollapseToLatestButton({ onClick, fixedToViewport = false }: { onClick: () => void; fixedToViewport?: boolean }) {
  const label = '收起全部并回到最新'
  return <div data-conversation-collapse={fixedToViewport || undefined} className={fixedToViewport
    ? 'pointer-events-none absolute bottom-[calc(35%+48px)] left-1 z-20 h-0 w-6 md:bottom-[calc(15%+56px)] md:left-2 md:w-7'
    : 'pointer-events-none sticky bottom-[calc(35%+48px)] z-20 -ml-10 h-0 w-6 md:bottom-[calc(15%+56px)] md:-ml-12 md:w-7'}>
    <button type="button" data-collapse-to-latest onClick={onClick} title={label} aria-label={label}
      className="ga-floating-handle pointer-events-auto absolute bottom-0 flex h-6 w-6 items-center justify-center rounded-full md:h-7 md:w-7">
      <CollapseChevronsIcon direction="collapse" className="h-4 w-4" />
    </button>
  </div>
}
