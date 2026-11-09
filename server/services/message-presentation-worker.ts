/** Hub-owned adapter; message interpretation lives in the desktop shared core. */
import { createInterface } from 'node:readline'
import { remoteMessagePage, remoteProgress } from '../../webui/src/utils/messagePresentation'
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let id: string | undefined
  try {
    const request = JSON.parse(line)
    id = request.id
    process.stdout.write(JSON.stringify({ id, data: (request.kind === 'progress' ? remoteProgress(request.data) : remoteMessagePage(request.data)) }) + '\n')
  } catch {
    process.stdout.write(JSON.stringify({ id, error: 'message_presentation_failed' }) + '\n')
  }
})
