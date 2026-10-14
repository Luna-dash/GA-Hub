import { parseAssistantTranscript, stripFinalResponseMarker } from './assistantTranscript'
import { scanTranscript } from './transcriptProtocol'

/** A theme report is the final reply, never an earlier turn or execution dump.
 * Keep the raw report on the server so the history entry remains lossless. */
export function themeReportConclusion(raw: string): string {
  const transcript = parseAssistantTranscript(raw)
  if (transcript.stopped) return ''
  const last = transcript.turns.at(-1)
  // Do not resurrect an earlier response when the final turn is empty.
  const nodes = scanTranscript(stripFinalResponseMarker(last ? last.content : raw))
  let lastTool = -1
  nodes.forEach((node, index) => { if (node.kind === 'tool') lastTool = index })
  return nodes.slice(lastTool + 1)
    .filter(node => node.complete && (node.kind === 'text' || node.kind === 'code'))
    .map(node => node.raw).join('')
    .replace(/^[ \t]*\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\][^\r\n]*$/gim, '')
    .trim()
}
