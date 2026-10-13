/** Answer-local action: collapse process records, then reveal its latest position. */
export function CollapseToLatestButton({ onClick }: { onClick: () => void }) {
  return <div className="pointer-events-none sticky bottom-2 z-10 mt-2 flex justify-end">
    <button type="button" data-collapse-to-latest onClick={onClick}
      className="pointer-events-auto rounded-md border border-line bg-bg-card px-2 py-1 text-xs text-accent shadow-sm hover:bg-bg-soft">
      收起全部并回到最新
    </button>
  </div>
}
