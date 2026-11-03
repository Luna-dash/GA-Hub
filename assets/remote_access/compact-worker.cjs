var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// assets/remote_access/compact-worker.ts
var compact_worker_exports = {};
__export(compact_worker_exports, {
  compactMessages: () => compactMessages
});
module.exports = __toCommonJS(compact_worker_exports);
var import_node_readline = require("node:readline");

// webui/src/utils/transcriptProtocol.ts
var TOOL = /^🛠️?\s*Tool\s*[:：]\s*`([\w.-]+)`(?:[ \t]*📥[ \t]*args:)?/i;
var COMPACT = /^🛠️?\s*([\w.-]+)\s*\(/;
var TURN = /^(?:\*\*)?LLM Running \(Turn (\d+)\) \.\.\.(?:\*\*)?/i;
var EDGE = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/;
function balancedCall(source, start) {
  let depth = 1, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i + 1;
  }
  return null;
}
function fence(source, start, tool) {
  const open = EDGE.exec(source.slice(start));
  const size = open[1].length, char = open[1][0];
  let pos = start + open[0].length;
  while (pos < source.length) {
    const newline = source.indexOf("\n", pos);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(pos, end).replace(/\r?\n$/, "");
    const close = new RegExp(`^[ \\t]*${char === "`" ? "`" : "~"}{${size},}[ \\t]*$`).exec(line);
    if (close) return { end, complete: true, repair: null };
    if (tool && char === "`") {
      const glued = new RegExp(`(?<!\`)\`{${size}}[ \\t]*$`).exec(line);
      if (glued && glued.index > 0) return { end, complete: true, repair: pos + glued.index };
    }
    pos = end;
  }
  return { end: source.length, complete: false, repair: null };
}
function scanTranscript(source) {
  const nodes = [];
  let pos = 0, textStart = 0;
  const push = (kind, start, end, extra = {}) => {
    nodes.push({ kind, start, end, raw: source.slice(start, end), complete: true, ...extra });
  };
  const flush = () => {
    if (pos > textStart) push("text", textStart, pos);
  };
  while (pos < source.length) {
    const rest = source.slice(pos);
    const lineStart = pos === 0 || source[pos - 1] === "\n";
    const turn = TURN.exec(rest);
    if (turn) {
      flush();
      push("turn", pos, pos + turn[0].length, { turn: Number(turn[1]) });
      pos += turn[0].length;
      textStart = pos;
      continue;
    }
    const meta = /^<(summary|thinking|think|analysis)>/i.exec(rest);
    if (meta) {
      const close = new RegExp(`</${meta[1]}>`, "i").exec(rest.slice(meta[0].length));
      const end = close ? pos + meta[0].length + close.index + close[0].length : source.length;
      flush();
      push(meta[1].toLowerCase() === "summary" ? "summary" : "thinking", pos, end, { complete: !!close });
      pos = end;
      textStart = pos;
      continue;
    }
    let header = TOOL.exec(rest);
    if (header) {
      const suffix = rest.slice(header[0].length).trimStart();
      const argsPending = suffix.length > 0 && "\u{1F4E5} args:".startsWith(suffix);
      if (argsPending) header[0] = rest;
      else if (!/^(?:📥\s*args:|`{1,}|$)/.test(suffix)) header = null;
    }
    const adjacentTool = nodes.at(-1)?.kind === "tool" && nodes.at(-1)?.end === pos;
    const compact = header || !lineStart && !adjacentTool ? null : COMPACT.exec(rest);
    if (header || compact) {
      flush();
      const start = pos, name = header?.[1] || compact[1];
      const headerEnd = header ? pos + header[0].length : balancedCall(source, pos + compact[0].length);
      let end = headerEnd ?? source.length, complete = headerEnd !== null;
      const opaque = [], repairs = [];
      while (complete) {
        const white = /^\s*/.exec(source.slice(end))[0].length;
        const next = end + white, edge = EDGE.exec(source.slice(next));
        if (edge && edge[1][0] === "`" && edge[1].length >= 4) {
          const block = fence(source, next, true);
          opaque.push({ start: next, end: block.end });
          if (block.repair !== null) repairs.push(block.repair);
          end = block.end;
          complete = block.complete;
          continue;
        }
        if (next < source.length && /^`{1,3}$/.test(source.slice(next))) {
          opaque.push({ start: next, end: source.length });
          end = source.length;
          complete = false;
        }
        break;
      }
      push("tool", start, end, { name, headerEnd: compact ? start + compact[0].length : headerEnd ?? void 0, complete, opaque, repairs });
      pos = end;
      textStart = pos;
      continue;
    }
    if (lineStart && EDGE.test(rest)) {
      flush();
      const block = fence(source, pos, false);
      push("code", pos, block.end, { complete: block.complete });
      pos = block.end;
      textStart = pos;
      continue;
    }
    if (rest.startsWith("<") && ["<thinking>", "<think>", "<analysis>"].some((tag) => tag.startsWith(rest.toLowerCase()))) {
      flush();
      push("pending", pos, source.length, { complete: false });
      pos = source.length;
      textStart = pos;
      break;
    }
    if (/^(?:🛠️?\s*(?:T(?:o(?:o(?:l(?::\s*(?:`[\w.]*)?)?)?)?)?)?|<(?:s(?:u(?:m(?:m(?:a(?:r(?:y)?)?)?)?)?)?)?)$/i.test(rest)) {
      flush();
      push("pending", pos, source.length, { complete: false });
      pos = source.length;
      textStart = pos;
      break;
    }
    pos++;
  }
  flush();
  return nodes;
}

// webui/src/utils/archiveTurnSegments.ts
function validTurnSegments(value, content) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.trim().length > 0) && value.join("") === content ? [...value] : void 0;
}

// webui/src/utils/assistantTranscript.ts
var FINAL_MARKER_RE = /\n*(?:`{3,5}[^\r\n]*\r?\n?)?\[Info\]\s*Final response to user\.\s*(?:\r?\n?`{3,5})?\s*$/i;
function stripFinalResponseMarker(text) {
  return (text || "").replace(FINAL_MARKER_RE, "").trim();
}
function extractSummary(text) {
  const node = scanTranscript(text).find((node2) => node2.kind === "summary" && node2.complete);
  return (node?.raw.replace(/^<summary>\s*|\s*<\/summary>$/gi, "") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" \xB7 ");
}
function stripTraceMeta(text) {
  return scanTranscript(text || "").filter((node) => node.kind !== "thinking" && (!node.complete || node.kind !== "summary")).map((node) => node.raw).join("").trim();
}
function readJsonObjectAfter(text, offset) {
  const start = text.indexOf("{", offset);
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}
function candidateLabel(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const row = value;
  const label = [row.label, row.title, row.value].find((item) => typeof item === "string");
  const description = typeof row.description === "string" ? row.description.trim() : "";
  return `${typeof label === "string" ? label.trim() : ""}${label && description ? "\uFF1A" : ""}${description}`;
}
function readLenientStringField(source, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`, "i").exec(source);
  if (!match) return "";
  let index = match.index + match[0].length;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      const next = source[index + 1];
      if (next === "n") value += "\n";
      else if (next === "t") value += "	";
      else value += next;
      index += 2;
      continue;
    }
    if (char === '"') break;
    value += char;
    index += 1;
  }
  return value.trim();
}
function readLenientStringArrayField(source, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`, "i").exec(source);
  if (!match) return [];
  let index = match.index + match[0].length;
  const items = [];
  while (index < source.length) {
    const char = source[index];
    if (char === "]") break;
    if (char === '"') {
      index += 1;
      let value = "";
      while (index < source.length) {
        const itemChar = source[index];
        if (itemChar === "\\" && index + 1 < source.length) {
          const next = source[index + 1];
          if (next === "n") value += "\n";
          else if (next === "t") value += "	";
          else value += next;
          index += 2;
          continue;
        }
        if (itemChar === '"') break;
        value += itemChar;
        index += 1;
      }
      index += 1;
      if (value.trim()) items.push(value);
      continue;
    }
    index += 1;
  }
  return items;
}
function askUserPayloadFromObject(payload) {
  const question = typeof payload.question === "string" ? payload.question.trim() : typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!question) return null;
  const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : Array.isArray(payload.options) ? payload.options : [];
  return { question, candidates: rawCandidates.map(candidateLabel).filter(Boolean) };
}
function renderAskUserPayload(payload) {
  return payload.candidates.length > 0 ? `${payload.question}

\u53EF\u9009\u9879\uFF1A
${payload.candidates.map((candidate) => `- ${candidate}`).join("\n")}` : payload.question;
}
function lastAskUserMatch(text) {
  const node = scanTranscript(text).filter((node2) => node2.kind === "tool" && node2.name?.split(".").at(-1)?.toLowerCase() === "ask_user").at(-1);
  if (!node) return null;
  const match = [text.slice(node.start, node.headerEnd ?? node.end)];
  match.index = node.start;
  return match;
}
function extractAskUserPayload(text) {
  const match = lastAskUserMatch(text);
  if (!match) return null;
  const node = scanTranscript(text).find((node2) => node2.kind === "tool" && node2.start === match.index);
  const tail = text.slice(node.headerEnd ?? node.end, node.end);
  const encoded = readJsonObjectAfter(tail, 0);
  if (encoded) {
    try {
      const parsed = askUserPayloadFromObject(JSON.parse(encoded));
      if (parsed) return parsed;
    } catch {
    }
  }
  let question = readLenientStringField(tail, "question") || readLenientStringField(tail, "prompt");
  question = question.trim();
  if (!question) {
    return /\(\s*$/.test(match[0]) ? parseCompactAskUser(tail) : null;
  }
  let candidates = readLenientStringArrayField(tail, "candidates");
  if (!candidates.length) candidates = readLenientStringArrayField(tail, "options");
  return { question, candidates: candidates.map(candidateLabel).filter(Boolean) };
}
function parseCompactAskUser(tail) {
  const sep = /\n[ \t]*candidates:[ \t]*(\r?\n|$)/i.exec(tail);
  let question = "";
  const candidates = [];
  if (sep) {
    question = tail.slice(0, sep.index).replace(/\)\s*$/, "").trim();
    const itemRe = /^[ \t]*-[ \t]?(.*)$/;
    for (const line of tail.slice(sep.index + sep[0].length).split(/\r?\n/)) {
      const item = itemRe.exec(line);
      if (!item) break;
      const closing = /\)\s*$/.exec(item[1]);
      const text = (closing ? item[1].slice(0, closing.index) : item[1]).trim();
      if (text) candidates.push(text);
      if (closing) break;
    }
  } else {
    const lines = [];
    let closed = false;
    for (const line of tail.split(/\r?\n/)) {
      const closing = /\)\s*$/.exec(line);
      if (closing) {
        const text2 = line.slice(0, closing.index).trimEnd();
        if (text2) lines.push(text2);
        closed = true;
        break;
      }
      const text = line.trim();
      if (text) lines.push(text);
    }
    if (!closed) return null;
    question = lines.join("\n").trim();
  }
  if (!question) return null;
  return { question, candidates: candidates.map(candidateLabel).filter(Boolean) };
}
function projectFinalBody(content, askReplacement = null) {
  const withoutMeta = stripTraceMeta(content).trim();
  if (!withoutMeta) return "";
  const askMatch = lastAskUserMatch(withoutMeta);
  if (!askMatch) return withoutMeta;
  const rendered = askReplacement !== null ? askReplacement : (() => {
    const payload = extractAskUserPayload(withoutMeta);
    return payload ? renderAskUserPayload(payload) : "";
  })();
  if (askReplacement === null && !rendered) return withoutMeta;
  const start = askMatch.index ?? 0;
  const end = scanTranscript(withoutMeta).find((node) => node.kind === "tool" && node.start === start).end;
  const before = withoutMeta.slice(0, start).trimEnd();
  const after = withoutMeta.slice(end).trim();
  return [before, rendered, after].filter(Boolean).join("\n\n");
}
function isDanglingToolTurn(content) {
  const nodes = scanTranscript(content);
  if (nodes.some((node) => node.kind === "tool" && node.name?.split(".").at(-1) === "ask_user")) return false;
  let lastCall = -1;
  nodes.forEach((node, index) => {
    if (node.kind === "tool") lastCall = index;
  });
  if (lastCall < 0) {
    const visible = nodes.filter((node) => !["summary", "thinking"].includes(node.kind) && node.raw.trim());
    return visible.length > 0 && visible.every((node) => node.kind === "code" && /^\s*`{4,}/.test(node.raw));
  }
  const tail = nodes.slice(lastCall + 1).filter((node) => node.kind === "text" || node.kind === "code").map((node) => node.kind === "code" ? "MARKDOWN_CODE" : node.raw).join("").replace(/^[ \t]*\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\][^\r\n]*$/gim, "");
  return tail.trim() === "";
}
var FALLBACK_SUMMARY_LIMIT = 80;
var fallbackToolCutRes = [
  /`{4,}/,
  // multiline tool fence (only its start matters)
  /🛠️/,
  // GA tool-call glyph
  /<\/arg_value>|<\/parameter>/,
  // escaped tool-call houses
  /^\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\]/m
  // GA log lines
];
var fallbackErrorRe = /^\s*(?:[!！]{1,4}\s*)?(?:\[(?:ERROR|DANGER)\]|\[\s*!{2,}|流异常中断|Incomplete response|上一条回复|Error[:：])/i;
function fallbackStripMarkdown(text) {
  return text.replace(/\*\*|__|`|~~/g, "");
}
function fallbackTrimTail(text, hard = false) {
  let value = text.replace(/\s+$/, "");
  const strip = hard ? "\uFF0C\u3001\uFF1B,;:\u2014\uFF5E~-" : "\uFF0C\u3001\uFF1B,;\u2014\uFF5E~-";
  const dropTrailing = () => {
    for (; ; ) {
      value = value.replace(/\s+$/, "");
      if (!value || !strip.includes(value.slice(-1))) return;
      value = value.slice(0, -1);
    }
  };
  dropTrailing();
  for (let round = 0; round < 2; round += 1) {
    const open = [];
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if ("\uFF08({[\u3010".includes(char)) open.push(index);
      else if ("\uFF09)}]\u3011".includes(char) && open.length) open.pop();
    }
    if (!open.length) break;
    value = value.slice(0, open[0]);
    dropTrailing();
  }
  return value;
}
function fallbackLeadLine(raw) {
  let text = raw;
  text = scanTranscript(text).filter((node) => node.kind !== "thinking" && node.kind !== "pending").map((node) => node.raw).join("");
  text = text.replace(/(?:\s*(?:<\/?)?\s*[｜|]+\s*DSML[^>]*>?)+/gi, " ");
  text = text.replace(/^(?:\s*<[A-Za-z][^<>]{0,80}>)+\s*/, "");
  text = text.replace(/^(\s*<thinking>[\s\S]*?<\/thinking>)+\s*/i, "");
  let cut = -1;
  for (const pattern of fallbackToolCutRes) {
    const match = pattern.exec(text);
    if (match && (cut < 0 || match.index < cut)) cut = match.index;
  }
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/(?:\s*<\/[A-Za-z][^<>]{0,80}>)+\s*$/, "");
  text = text.replace(/\s*[｜|]+\s*DSML.*$/i, "");
  text = text.replace(/<\/?(?:summary|parameter|arg_value|antml:[a-z_]+)(?:\s[^<>]{0,200})?>/gi, " ");
  text = text.replace(/(?:\s*(?:<\/?)?\s*[｜|]+\s*DSML[^>]*>?)+/gi, " ");
  let line = "";
  for (const candidate of text.split(/\r?\n/)) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (/^[|>#*=\-•·`]+\s*$/.test(trimmed)) continue;
    line = trimmed;
    break;
  }
  if (!line) return "";
  return line.replace(/^\s*[#>*\-•·]+\s*/, "").replace(/\s+/g, " ").trim();
}
function fallbackColonTail(text) {
  if (text.endsWith("\uFF1A") || text.endsWith(":")) return `${text.slice(0, -1)}\u3002`;
  return text;
}
function fallbackDerive(text) {
  if (text.length < 2 || !/[0-9A-Za-z\u4e00-\u9fff]/.test(text)) return "";
  if (text.length <= FALLBACK_SUMMARY_LIMIT) {
    const whole2 = fallbackColonTail(fallbackTrimTail(fallbackStripMarkdown(text)));
    if (whole2.length >= 2 && /[0-9A-Za-z\u4e00-\u9fff]/.test(whole2)) return whole2;
    return "";
  }
  const positions = [];
  const sentinelRe = /[。！？]/g;
  for (let hit = sentinelRe.exec(text); hit; hit = sentinelRe.exec(text)) positions.push(hit.index);
  const inLimit = positions.filter((index) => index < FALLBACK_SUMMARY_LIMIT);
  const cut = inLimit.length ? inLimit[inLimit.length - 1] : positions[0];
  if (cut !== void 0) {
    const derived = fallbackTrimTail(fallbackStripMarkdown(text.slice(0, cut + 1)));
    if (derived.length >= 15) return fallbackColonTail(derived);
  }
  const whole = fallbackColonTail(fallbackTrimTail(fallbackStripMarkdown(text)));
  if (whole.length >= 2 && /[0-9A-Za-z\u4e00-\u9fff]/.test(whole)) return whole;
  return "";
}
function fallbackSummary(raw) {
  const trimmed = scanTranscript(raw).filter((node) => node.kind !== "thinking" && node.kind !== "pending").map((node) => node.raw).join("").trim();
  if (fallbackErrorRe.test(trimmed)) return "";
  const lead = fallbackLeadLine(trimmed);
  if (!lead) return "";
  return fallbackDerive(lead);
}
function parseAssistantTranscript(text, streaming = false, turnSegments) {
  let trusted = validTurnSegments(turnSegments, text);
  if (trusted) {
    const opaque = scanTranscript(text).filter((node) => !["text", "turn"].includes(node.kind) && !(node.kind === "thinking" && !node.complete));
    let offset = 0;
    if (trusted.slice(0, -1).some((part) => {
      offset += part.length;
      return opaque.some((node) => node.start < offset && offset < node.end);
    })) trusted = void 0;
  }
  if (trusted) return selectTranscriptTurns("", trusted.map((part, index) => {
    const rawContent = stripFinalResponseMarker(part).trim().replace(/^\*?\*?LLM Running \(Turn \d+\) \.\.\.\*?\*?[^\S\r\n]*(?:\r?\n|$)/i, "").trim();
    return {
      turn: index + 1,
      summary: extractSummary(rawContent) || fallbackSummary(rawContent),
      content: stripTraceMeta(rawContent),
      ...scanTranscript(rawContent).some((node) => node.kind === "thinking") ? { rawContent } : {}
    };
  }));
  const source = stripFinalResponseMarker(text);
  const safe = scanTranscript(source).filter((node) => !streaming || !(!node.complete && ["summary", "pending"].includes(node.kind))).map((node) => node.raw).join("");
  const restore = (value) => value;
  const matches = scanTranscript(safe).filter((node) => node.kind === "turn");
  if (!matches.length) {
    const cleanedSource = restore(safe);
    const payload = extractAskUserPayload(cleanedSource);
    const finalAskUser = payload && payload.candidates.length > 0 ? payload : null;
    return {
      leading: "",
      turns: [],
      finalBody: projectFinalBody(cleanedSource, finalAskUser ? "" : null),
      finalTurnIndex: null,
      finalAskUser,
      stopped: false
    };
  }
  const leading = stripTraceMeta(restore(safe.slice(0, matches[0].start)));
  const turns = matches.map((match, index) => {
    const start = match.end;
    const end = index + 1 < matches.length ? matches[index + 1].start : safe.length;
    const rawContent = restore(safe.slice(start, end)).trim();
    return {
      turn: match.turn,
      summary: extractSummary(rawContent) || fallbackSummary(rawContent),
      content: stripTraceMeta(rawContent),
      ...scanTranscript(rawContent).some((node) => node.kind === "thinking") ? { rawContent } : {}
    };
  });
  return selectTranscriptTurns(leading, turns);
}
function selectTranscriptTurns(leading, turns) {
  let finalBody = "";
  let finalTurnIndex = null;
  let finalAskUser = null;
  let stopped = false;
  let terminalIndex = turns.length - 1;
  while (terminalIndex >= 0 && !turns[terminalIndex].content.trim()) terminalIndex -= 1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!turns[index].content.trim()) continue;
    if (index === terminalIndex && isDanglingToolTurn(turns[index].content)) {
      stopped = true;
      continue;
    }
    const payload = lastAskUserMatch(turns[index].content) ? extractAskUserPayload(turns[index].content) : null;
    finalAskUser = payload && payload.candidates.length > 0 ? payload : null;
    finalBody = projectFinalBody(turns[index].content, finalAskUser ? "" : null);
    finalTurnIndex = lastAskUserMatch(turns[index].content) ? index : null;
    break;
  }
  return { leading, turns, finalBody, finalTurnIndex, finalAskUser, stopped };
}

// assets/remote_access/compact-worker.ts
function prose(text) {
  return scanTranscript(text).map((n) => {
    if (n.kind === "text" || n.kind === "code") return n.raw;
    if (n.kind === "tool" && n.complete && n.name?.split(".").at(-1)?.toLowerCase() === "ask_user") {
      const q = extractAskUserPayload(n.raw);
      return q ? "\n\n" + renderAskUserPayload(q) + "\n\n" : "";
    }
    return "";
  }).join("").trim();
}
function compactMessages(data) {
  return { ...data, items: data.items.map((item) => {
    const { turn_segs, turn_segments, ...rest } = item;
    if (item.role !== "assistant") return { ...rest, compact: true };
    const raw = String(item.content ?? "");
    const parsed = parseAssistantTranscript(raw, Boolean(item.streaming), turn_segs ?? turn_segments);
    const turns = parsed.turns.map((t) => ({ turn: t.turn, summary: t.summary || "", content: prose(t.content) }));
    return { ...rest, content: prose(raw), compact: true, progress: {
      turns,
      turn_count: turns.length,
      final_body: prose(parsed.finalBody),
      question: parsed.finalAskUser
    } };
  }) };
}
if (require.main === module) {
  (0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    try {
      process.stdout.write(JSON.stringify(compactMessages(JSON.parse(line))) + "\n");
    } catch {
      process.stdout.write('{"error":"compact_projection_failed"}\n');
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compactMessages
});
