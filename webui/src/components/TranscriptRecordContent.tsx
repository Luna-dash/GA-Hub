import { MessageContent } from './MessageContent'
import { transcriptRecordMarkdown } from '../utils/transcriptProtocol'

/** Raw process content shared by live expansion and archived replay.
 * Never apply the compact running projection here. */
export function TranscriptRecordContent({ content, cache = true }: { content: string; cache?: boolean }) {
  return <MessageContent content={transcriptRecordMarkdown(content)} format="markdown" markdownMode="plain" cache={cache} />
}
