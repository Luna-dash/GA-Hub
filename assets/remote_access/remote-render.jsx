import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseAssistantTranscript } from '../../webui/src/utils/assistantTranscript';
import { scanTranscript } from '../../webui/src/utils/transcriptProtocol';

export function markdown(source) {
  const host = document.createElement('div');
  host.className = 'markdown';
  // No raw HTML, remote images, or executable URL protocols. React escapes text.
  host.innerHTML = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({children, href}) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({alt}) => <span className="image-placeholder">[图片：{alt || '未加载远程图片'}]</span>,
    th: ({children, style}) => <th className={'align-' + (style?.textAlign || 'left')}>{children}</th>,
    td: ({children, style}) => <td className={'align-' + (style?.textAlign || 'left')}>{children}</td>,
  }}>{source}</Markdown>);
  return host;
}
export function transcript(source, streaming, segments) {
  return parseAssistantTranscript(source, streaming, segments);
}
export function visibleProcess(source) {
  const nodes = scanTranscript(source);
  const prose = nodes.filter(n => !['tool','thinking','summary','pending','turn'].includes(n.kind)).map(n => n.raw).join('');
  const tools = nodes.filter(n => n.kind === 'tool').map(n => n.name || '工具');
  return { prose, tools };
}
