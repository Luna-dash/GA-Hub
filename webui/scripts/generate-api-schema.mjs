// Regenerate src/api/generated/schema.d.ts from the exported OpenAPI spec.
//
// Anchored to this script's location so the output lands in the same place
// no matter the caller's cwd (a redirect once produced a stray webui/webui/
// tree when the npm-script-relative paths resolved against the wrong root).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const webuiRoot = path.resolve(import.meta.dirname, '..')
const spec = path.resolve(webuiRoot, '../docs/api/openapi.json')
const out = path.join(webuiRoot, 'src/api/generated/schema.d.ts')

const result = spawnSync(
  'npx',
  ['openapi-typescript', spec, '--output', out],
  { stdio: 'inherit', cwd: webuiRoot, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
