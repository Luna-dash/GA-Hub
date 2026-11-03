// Gateway projection: desktop turn boundaries, no tool payloads cross the wire.
import { createInterface } from 'node:readline';
import { scanTranscript } from '../../webui/src/utils/transcriptProtocol';
import { extractAskUserPayload, renderAskUserPayload, parseAssistantTranscript } from '../../webui/src/utils/assistantTranscript';
function prose(text: string) {
  return scanTranscript(text).map(n => {
    if (n.kind === 'text' || n.kind === 'code') return n.raw;
    if (n.kind === 'tool' && n.complete && n.name?.split('.').at(-1)?.toLowerCase() === 'ask_user') {
      const q = extractAskUserPayload(n.raw);
      return q ? '\n\n' + renderAskUserPayload(q) + '\n\n' : '';
    }
    return '';
  }).join('').trim();
}
export function compactMessages(data: any) {
  return {...data, items: data.items.map((item: any) => {
    const {turn_segs, turn_segments, ...rest} = item;
    if (item.role !== 'assistant') return {...rest, compact: true};
    const raw = String(item.content ?? '');
    const parsed = parseAssistantTranscript(raw, Boolean(item.streaming), turn_segs ?? turn_segments);
    // Include the final response turn in the count; its body is displayed separately.
    const turns = parsed.turns.map(t => ({turn: t.turn, summary: t.summary || '', content: prose(t.content)}));
    return {...rest, content: prose(raw), compact: true, progress: {
      turns, turn_count: turns.length,
      final_body: prose(parsed.finalBody),
      question: parsed.finalAskUser,
    }};
  })};
}
if (require.main === module) {
  createInterface({input:process.stdin, crlfDelay:Infinity}).on('line', line => {
    try { process.stdout.write(JSON.stringify(compactMessages(JSON.parse(line))) + '\n'); }
    catch { process.stdout.write('{"error":"compact_projection_failed"}\n'); }
  });
}
