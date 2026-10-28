import { decodeDetector } from './shared/detector-codec'
import { analyzeSharedOutputs } from './shared/shared-detector'
import { generateChallenges } from './shared/challenge-browser.js'
import bank from './bank.json'

interface Env { DETECTOR: { get(key:string, type:"arrayBuffer"): Promise<ArrayBuffer|null> }; SCORING_TOKEN: string; RATE_LIMITER: { limit(input: {key:string}): Promise<{success:boolean}> } }
let detector: ReturnType<typeof decodeDetector> | undefined
const json = (data: unknown, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}})
async function authorized(request: Request, token: string) {
  if (!token) return false
  const encoder = new TextEncoder()
  const digest = async (value:string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  const a = await digest(request.headers.get('authorization') || '')
  const b = await digest(`Bearer ${token}`)
  return a.reduce((v, x, i) => v | (x ^ b[i]), 0) === 0
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/health' && request.method === 'GET') return json({status:'ok', service:'model-fingerprint', models:bank.models.length, bank_built_at:bank.built_at})
    if (path === '/' && request.method === 'GET') return new Response('GA-Hub model fingerprint scoring service. API credentials remain on the sampling host. Statistical similarity is not model identity verification.', {headers:{'Content-Type':'text/plain; charset=utf-8'}})
    if (!['/v1/fingerprint/challenges','/v1/fingerprint/analyze'].includes(path)) return json({error:'not_found'},404)
    if (!await authorized(request, env.SCORING_TOKEN)) return json({error:'unauthorized'},401)
    if (!await env.RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') || 'shared'}).then(x=>x.success)) return json({error:'rate_limited'},429)
    if (path.endsWith('/challenges')) {
      if (request.method !== 'GET') return json({error:'method_not_allowed'},405)
      return json({challenges:generateChallenges(3), bank_built_at:bank.built_at})
    }
    if (request.method !== 'POST') return json({error:'method_not_allowed'},405)
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({error:'json_required'},415)
    // Read at most 64 KiB, even when Content-Length is absent or dishonest.
    const reader = request.body?.getReader()
    if (!reader) return json({error:'invalid_payload'},400)
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const {value,done} = await reader.read(); if (done) break
        size += value.length
        if (size > 65536) { await reader.cancel(); return json({error:'payload_too_large'},413) }
        chunks.push(value)
      }
      const data = new Uint8Array(size); let offset = 0
      for (const c of chunks) { data.set(c,offset); offset += c.length }
      const body = JSON.parse(new TextDecoder().decode(data))
      if (Object.keys(body).some(k=>k!=='outputs') || !Array.isArray(body.outputs) || body.outputs.length !== 3 || !body.outputs.every((o:any)=>o && Object.keys(o).every(k=>['text','expected_count'].includes(k)) && typeof o.text==='string' && o.text.length<=16000 && /^[0-9 ,\s]+$/.test(o.text) && Number.isInteger(o.expected_count) && o.expected_count>=292 && o.expected_count<=332)) return json({error:'invalid_outputs'},400)
      if (!detector) {
        const bytes = await env.DETECTOR.get('detector-v2', 'arrayBuffer')
        if (!bytes) return json({error:'detector_unavailable'},503)
        detector = decodeDetector(new Uint8Array(bytes))
      }
      const analysis = analyzeSharedOutputs(body.outputs, bank as any, detector)
      return json({analysis, bank_built_at:bank.built_at})
    } catch (error) {
      if (error instanceof SyntaxError) return json({error:'invalid_json'},400)
      // Never include submitted text or request metadata in logs/responses.
      return json({error:'scoring_failed'},500)
    }
  }
}
