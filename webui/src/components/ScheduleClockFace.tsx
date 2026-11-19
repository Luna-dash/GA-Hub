import clsx from 'clsx'

export const scheduleClockButtonClass = 'relative shrink-0 rounded-full bg-bg-card shadow-sm transition-colors hover:bg-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

export function ScheduleClockFace({ pending = false }: { pending?: boolean }) {
  return (
    <span aria-hidden="true" data-schedule-clock className="pointer-events-none absolute inset-0">
      <span className={clsx('absolute inset-0 rounded-full border', pending ? 'border-accent/40' : 'border-line')} />
      {pending && (
        <span
          data-schedule-flow-border
          className="absolute inset-0 animate-spin rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,transparent_205deg,#60a5fa_245deg,#a78bfa_285deg,#f472b6_325deg,transparent_360deg)] [mask-image:radial-gradient(closest-side,transparent_calc(100%_-_2px),black_calc(100%_-_1px),black_calc(100%_-_0.5px),transparent_100%)] motion-reduce:animate-none"
          style={{ animationDuration: '3s' }}
        />
      )}
      <span data-schedule-minute-hand className="absolute bottom-1/2 left-1/2 h-1/4 w-0.5 -translate-x-1/2 rounded-full bg-current" />
      <span data-schedule-hour-hand className="absolute left-1/2 top-1/2 h-0.5 w-[24%] origin-left -translate-y-1/2 rotate-[32deg] rounded-full bg-current" />
    </span>
  )
}
