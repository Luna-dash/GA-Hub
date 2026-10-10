import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import liveChatSource from './LiveChat.tsx?raw'

const source = ts.createSourceFile(
  'LiveChat.tsx',
  liveChatSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function element(name: string): ts.JsxElement | ts.JsxSelfClosingElement {
  let result: ts.JsxElement | ts.JsxSelfClosingElement | undefined
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === name) result = node
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name) result = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!result) throw new Error(`Missing ${name}`)
  return result
}

function classes(node: ts.Node): string[] {
  if (!ts.isJsxElement(node)) throw new Error('Expected a layout element')
  const attribute = node.openingElement.attributes.properties.find(
    (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className',
  ) as ts.JsxAttribute | undefined
  const value = attribute?.initializer
  if (!value || !ts.isStringLiteral(value)) throw new Error('Expected static layout classes')
  return value.text.split(/\s+/)
}

describe('LiveChat column layout', () => {
  it('keeps the transcript and composer in the same shrinkable column', () => {
    const column = element('LiveChatComposer').parent
    expect(element('LiveChatTranscript').parent).toBe(column)
    expect(classes(column)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0', 'min-w-0']))
  })

  it('places the rail beside the entire chat column, with a stacked mobile layout', () => {
    const column = element('LiveChatComposer').parent
    const layout = element('SessionRail').parent
    expect(column.parent).toBe(layout)
    expect(classes(layout)).toEqual(expect.arrayContaining(['flex', 'h-full', 'min-h-0', 'flex-col', 'md:flex-row']))
  })
})
