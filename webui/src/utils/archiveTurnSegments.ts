/** Trusted archive boundaries are metadata, not a new event/tool protocol. */
export function validTurnSegments(value: unknown, content: string): string[] | undefined {
  return Array.isArray(value) && value.length > 0
    && value.every(part => typeof part === 'string' && part.trim().length > 0)
    && value.join('') === content
    ? [...value] : undefined
}
