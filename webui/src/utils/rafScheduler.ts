export interface RafScheduler {
  schedule: () => void
  cancel: () => void
}

export function createRafScheduler(
  callback: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): RafScheduler {
  let frame: number | null = null
  let generation = 0

  return {
    schedule: () => {
      if (frame !== null) return
      const scheduledGeneration = generation
      frame = requestFrame(() => {
        frame = null
        if (scheduledGeneration === generation) callback()
      })
    },
    cancel: () => {
      generation += 1
      if (frame === null) return
      cancelFrame(frame)
      frame = null
    },
  }
}
