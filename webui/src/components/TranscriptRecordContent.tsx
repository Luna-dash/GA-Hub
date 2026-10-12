import { MessageContent } from './MessageContent'

/** Raw process content shared by live expansion and archived replay.
 * Never apply the compact running projection here. */
export function TranscriptRecordContent({ content, cache = true }: { content: string; cache?: boolean }) {
  return <MessageContent content={content} format="markdown" markdownMode="plain" cache={cache} />
}
