// Scroll provenance: scroll events carry no reliable "user vs programmatic"
// flag, so every piece of code that assigns scrollTop / calls scrollTo marks
// itself here first. The reading-position capture only persists a position
// when the newest real input gesture is newer than the newest programmatic
// scroll, so restore landing, bottom pinning and measurement compensation
// can never be mistaken for the reader's chosen spot.
let lastProgrammaticAt = 0

/** Call immediately before assigning scrollTop or calling scrollTo. */
export function markProgrammaticScroll(): void {
  lastProgrammaticAt = performance.now()
}

export function lastProgrammaticScrollAt(): number {
  return lastProgrammaticAt
}
