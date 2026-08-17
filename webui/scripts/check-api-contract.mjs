import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const webuiRoot = path.resolve(import.meta.dirname, '..')
const clientPath = path.join(webuiRoot, 'src/api/client.ts')
const openapiPath = path.resolve(webuiRoot, '../docs/api/openapi.json')

const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'))
const sourceText = fs.readFileSync(clientPath, 'utf8')
const generatedPath = path.join(webuiRoot, 'src/api/generated/schema.d.ts')
const generatedBefore = fs.existsSync(generatedPath)
  ? fs.readFileSync(generatedPath, 'utf8')
  : null
const sourceFile = ts.createSourceFile(
  clientPath,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

function staticPath(argument) {
  return argument.text.split('?')[0]
}

function templatePath(argument) {
  let value = argument.head.text
  for (const span of argument.templateSpans) {
    value += '{*}' + span.literal.text
  }
  return value.split('?')[0]
}

const calls = []

function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'http' &&
    node.arguments.length >= 2 &&
    (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
    (ts.isStringLiteral(node.arguments[1]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[1]) || ts.isTemplateExpression(node.arguments[1]))
  ) {
    const method = node.arguments[0].text
    const routeArgument = node.arguments[1]
    const route = ts.isTemplateExpression(routeArgument)
      ? templatePath(routeArgument)
      : staticPath(routeArgument)
    calls.push({
      method,
      route,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    })
  }
  ts.forEachChild(node, visit)
}

visit(sourceFile)

const backendRoutes = new Set()
for (const [route, operations] of Object.entries(openapi.paths ?? {})) {
  for (const method of Object.keys(operations)) {
    if (['get', 'put', 'post', 'patch', 'delete'].includes(method)) {
      backendRoutes.add(`${method.toUpperCase()} ${route.replace(/\{[^}]+\}/g, '{*}')}`)
    }
  }
}

function backendCandidates(route) {
  const segments = route.split('/')
  const candidates = [route]
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === '{*}') {
      const withoutSegment = [...segments.slice(0, index), ...segments.slice(index + 1)].join('/')
      candidates.push(withoutSegment)
      for (let next = index + 1; next < segments.length; next += 1) {
        if (segments[next] === '{*}') {
          candidates.push([...segments.slice(0, index), ...segments.slice(index + 1, next), ...segments.slice(next + 1)].join('/'))
        }
      }
    }
  }
  return candidates
}

const unknown = []
const matched = new Set()
for (const call of calls) {
  const key = `${call.method} ${call.route}`
  if (backendRoutes.has(key)) {
    matched.add(key)
    continue
  }

  if (call.route.includes('{*}')) {
    const optionalMatch = backendCandidates(call.route).find(candidate => backendRoutes.has(`${call.method} ${candidate}`))
    if (optionalMatch) {
      matched.add(key)
      continue
    }
  }

  unknown.push(`${clientPath}:${call.line}: ${key}`)
}

if (unknown.length > 0) {
  console.error('Frontend HTTP calls missing from docs/api/openapi.json:')
  for (const item of unknown) console.error(`  ${item}`)
  console.error('Regenerate the artifact with: python scripts/export_openapi.py')
  process.exitCode = 1
} else {
  console.log(
    `API contract check passed: ${calls.length} frontend HTTP call shapes match ${backendRoutes.size} OpenAPI operations.`,
  )
}

const generation = spawnSync(
  process.execPath,
  [path.join(webuiRoot, 'node_modules/openapi-typescript/bin/cli.js'), openapiPath, '--output', generatedPath],
  { encoding: 'utf8' },
)
if (generation.error || generation.status !== 0) {
  console.error('Generated TypeScript API contract could not be refreshed:')
  console.error(generation.stderr || generation.error)
  process.exitCode = 1
} else if (generation.stdout.trim()) {
  // The generator prints a short success banner on every run.
  process.stdout.write(generation.stdout)
}

if (!process.exitCode) {
  const generatedAfter = fs.readFileSync(generatedPath, 'utf8')
  if (generatedBefore !== generatedAfter) {
    console.error(`Generated TypeScript API contract is stale: ${generatedPath}`)
    console.error('Refresh it with: npm run api:generate')
    process.exitCode = 1
  }
}
