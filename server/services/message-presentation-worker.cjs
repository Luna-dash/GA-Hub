// server/services/message-presentation-worker.ts
var import_node_readline = require("node:readline");

// webui/src/utils/archiveTurnSegments.ts
function validTurnSegments(value, content) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.trim().length > 0) && value.join("") === content ? [...value] : void 0;
}

// webui/src/utils/transcriptProtocol.ts
var TOOL_Y = /🛠️?\s*Tool\s*[:：]\s*`([\w.-]+)`(?:[ \t]*📥[ \t]*args:)?/iy;
var COMPACT_Y = /🛠️?\s*([\w.-]+)\s*\(/y;
var TURN_Y = /(?:\*\*)?LLM Running \(Turn (\d+)\) \.\.\.(?:\*\*)?/iy;
var META_Y = /<(summary|thinking|think|analysis)>/iy;
var EDGE_Y = /[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/y;
var WS_Y = /\s*/y;
var ARGS_PREFIX_Y = /(?:📥\s*args:|`{1,})/y;
var PENDING_TAIL_RE = /^(?:🛠️?\s*(?:T(?:o(?:o(?:l(?::\s*(?:`[\w.]*)?)?)?)?)?)?|<(?:s(?:u(?:m(?:m(?:a(?:r(?:y)?)?)?)?)?)?)?)$/i;
var BACKTICK_TAIL_RE = /^`{1,3}$/;
var PENDING_OPEN_TAGS = ["<thinking>", "<think>", "<analysis>"];
function isWsCode(ch) {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 160;
}
function skipWs(source, pos) {
  while (pos < source.length && isWsCode(source.charCodeAt(pos))) pos++;
  return pos;
}
function skipInlineSpaces(source, pos) {
  while (pos < source.length) {
    const ch = source.charCodeAt(pos);
    if (ch !== 32 && ch !== 9) break;
    pos++;
  }
  return pos;
}
function isWordOrToolCode(ch) {
  return ch === 55357 || ch === 95 || ch === 46 || ch === 45 || ch >= 48 && ch <= 57 || ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122;
}
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
  EDGE_Y.lastIndex = start;
  const open = EDGE_Y.exec(source);
  const size = open[1].length, char = open[1][0];
  const closeRe = new RegExp(`^[ \\t]*${char === "`" ? "`" : "~"}{${size},}[ \\t]*$`);
  const gluedRe = tool && char === "`" ? new RegExp(`(?<!\`)\`{${size}}[ \\t]*$`) : null;
  let pos = start + open[0].length;
  while (pos < source.length) {
    const newline = source.indexOf("\n", pos);
    const end = newline < 0 ? source.length : newline + 1;
    let lineEnd = end;
    if (lineEnd > pos && source[lineEnd - 1] === "\n") lineEnd--;
    if (lineEnd > pos && source[lineEnd - 1] === "\r") lineEnd--;
    const line = source.slice(pos, lineEnd);
    if (closeRe.test(line)) return { end, complete: true, repair: null };
    if (gluedRe) {
      const glued = gluedRe.exec(line);
      if (glued && glued.index > 0) return { end, complete: true, repair: pos + glued.index };
    }
    pos = end;
  }
  return { end: source.length, complete: false, repair: null };
}
function scanTranscript(source) {
  const nodes = [];
  const len = source.length;
  let pos = 0, textStart = 0;
  const push = (kind, start, end, extra = {}) => {
    nodes.push({ kind, start, end, raw: source.slice(start, end), complete: true, ...extra });
  };
  const flush = () => {
    if (pos > textStart) push("text", textStart, pos);
  };
  while (pos < len) {
    const ch = source.charCodeAt(pos);
    const lineStart = pos === 0 || source.charCodeAt(pos - 1) === 10;
    if (ch === 42 || ch === 76 || ch === 108) {
      TURN_Y.lastIndex = pos;
      const turn = TURN_Y.exec(source);
      if (turn) {
        flush();
        push("turn", pos, pos + turn[0].length, { turn: Number(turn[1]) });
        pos += turn[0].length;
        textStart = pos;
        continue;
      }
    }
    if (ch === 60) {
      META_Y.lastIndex = pos;
      const meta = META_Y.exec(source);
      if (meta) {
        const closeRe = new RegExp(`</${meta[1]}>`, "ig");
        closeRe.lastIndex = pos + meta[0].length;
        const close = closeRe.exec(source);
        const end = close ? close.index + close[0].length : len;
        flush();
        push(meta[1].toLowerCase() === "summary" ? "summary" : "thinking", pos, end, { complete: !!close });
        pos = end;
        textStart = pos;
        continue;
      }
    }
    const ws = isWsCode(ch);
    let header = null;
    if (ch === 55357 || ch === 84 || ch === 116 || ws) {
      const probe = ws ? skipWs(source, pos) : pos;
      const probeCh = probe < len ? source.charCodeAt(probe) : 0;
      if (probeCh === 55357 || probeCh === 84 || probeCh === 116) {
        TOOL_Y.lastIndex = pos;
        header = TOOL_Y.exec(source);
        if (header) {
          const afterHeader = pos + header[0].length;
          WS_Y.lastIndex = afterHeader;
          const suffixStart = afterHeader + WS_Y.exec(source)[0].length;
          const remLen = len - suffixStart;
          if (remLen > 0 && remLen <= 8 && "\u{1F4E5} args:".startsWith(source.slice(suffixStart))) {
            header[0] = source.slice(pos);
          } else if (remLen > 0) {
            ARGS_PREFIX_Y.lastIndex = suffixStart;
            if (!ARGS_PREFIX_Y.test(source)) header = null;
          }
        }
      }
    }
    const adjacentTool = nodes.at(-1)?.kind === "tool" && nodes.at(-1)?.end === pos;
    let compact = null;
    if (!header && (lineStart || adjacentTool) && (ws || isWordOrToolCode(ch))) {
      COMPACT_Y.lastIndex = pos;
      compact = COMPACT_Y.exec(source);
    }
    if (header || compact) {
      flush();
      const start = pos, name = header?.[1] || compact[1];
      const headerEnd = header ? pos + header[0].length : balancedCall(source, pos + compact[0].length);
      let end = headerEnd ?? len, complete = headerEnd !== null;
      const opaque = [], repairs = [];
      while (complete) {
        WS_Y.lastIndex = end;
        const next = end + WS_Y.exec(source)[0].length;
        EDGE_Y.lastIndex = next;
        const edge = EDGE_Y.exec(source);
        if (edge && edge[1][0] === "`" && edge[1].length >= 4) {
          const block = fence(source, next, true);
          opaque.push({ start: next, end: block.end });
          if (block.repair !== null) repairs.push(block.repair);
          end = block.end;
          complete = block.complete;
          continue;
        }
        if (next < len && len - next <= 3 && BACKTICK_TAIL_RE.test(source.slice(next))) {
          opaque.push({ start: next, end: len });
          end = len;
          complete = false;
        }
        break;
      }
      push("tool", start, end, { name, headerEnd: compact ? start + compact[0].length : headerEnd ?? void 0, complete, opaque, repairs });
      pos = end;
      textStart = pos;
      continue;
    }
    if (lineStart && (ch === 96 || ch === 126 || ch === 32 || ch === 9)) {
      const fenceCheck = ch === 32 || ch === 9 ? skipInlineSpaces(source, pos) : pos;
      const fenceCh = fenceCheck < len ? source.charCodeAt(fenceCheck) : 0;
      if (fenceCh === 96 || fenceCh === 126) {
        EDGE_Y.lastIndex = pos;
        if (EDGE_Y.test(source)) {
          flush();
          const block = fence(source, pos, false);
          push("code", pos, block.end, { complete: block.complete });
          pos = block.end;
          textStart = pos;
          continue;
        }
      }
    }
    if (ch === 60 && len - pos <= 10) {
      const tailLower = source.slice(pos).toLowerCase();
      if (PENDING_OPEN_TAGS.some((tag) => tag.startsWith(tailLower))) {
        flush();
        push("pending", pos, len, { complete: false });
        pos = len;
        textStart = pos;
        break;
      }
    }
    if (len - pos <= 256 && (ch === 60 || ch === 55357 || ch === 84 || ch === 116 || ws)) {
      if (PENDING_TAIL_RE.test(source.slice(pos))) {
        flush();
        push("pending", pos, len, { complete: false });
        pos = len;
        textStart = pos;
        break;
      }
    }
    pos++;
  }
  flush();
  return nodes;
}

// webui/src/utils/replySegments.ts
function updateReplySegments(previous, streamId, phase, content, turnSegments) {
  const index = previous.findIndex((part2) => part2.streamId === streamId);
  const old = index < 0 ? void 0 : previous[index];
  if (old?.archived && phase === "started") return previous.slice();
  if (old?.done && !old.archived && phase !== "done") return previous.slice();
  if (old && !old.archived && content !== void 0 && old.content !== content && old.content.startsWith(content)) return previous.slice();
  const part = {
    streamId,
    content: phase === "started" ? old?.content ?? "" : content ?? old?.content ?? "",
    done: phase === "done" || !!old?.done && !old.archived,
    turnSegments: validTurnSegments(turnSegments, content ?? old?.content ?? "") ?? (content === void 0 || content === old?.content ? old?.turnSegments : void 0)
  };
  if (index < 0) return [...previous, part];
  const next = previous.slice();
  next[index] = part;
  return next;
}
function replySegmentsContent(parts) {
  return parts.map((part) => part.content).filter(Boolean).join("\n\n");
}
function replySegmentsTurns(parts) {
  if (!parts.some((part) => validTurnSegments(part.turnSegments, part.content))) return void 0;
  const result = [];
  for (const part of parts.filter((part2) => part2.content)) {
    const trusted = validTurnSegments(part.turnSegments, part.content);
    const starts = trusted ? [] : scanTranscript(part.content).filter((node) => node.kind === "turn").map((node) => node.start);
    const cuts = [.../* @__PURE__ */ new Set([0, ...starts, part.content.length])];
    const turns = trusted ?? cuts.slice(0, -1).map((start, i) => part.content.slice(start, cuts[i + 1]));
    if (result.length) turns[0] = "\n\n" + turns[0];
    result.push(...turns);
  }
  return result.length ? result : void 0;
}

// webui/src/utils/messageModel.ts
var HIDDEN_SOURCES = /* @__PURE__ */ new Set(["wechat"]);
var isHiddenSource = (s) => !!s && HIDDEN_SOURCES.has(s);
function epochMilliseconds(value) {
  if (!value || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1e3 : value;
}
function belongsToRun(message, runId) {
  return message.runId === runId;
}
function upsertRetryNotice(prev, retryKey, content, timestamp, retryStreamId, runId) {
  const idx = prev.findIndex((m) => m.role === "assistant" && belongsToRun(m, runId) && (m.logicalId === retryKey || m.streamId === retryKey || m.segments?.some((part) => part.streamId === retryKey)));
  const recoveryNotice = content.replace(/^_|_$/g, "");
  if (idx === -1) {
    return [
      ...prev,
      {
        role: "assistant",
        content: "",
        streamId: retryKey,
        logicalId: retryKey,
        runId,
        recoveryNotice,
        recoveryOffset: 0,
        recoveryStreamId: retryStreamId,
        segments: [],
        timestamp
      }
    ];
  }
  const next = prev.slice();
  const old = prev[idx];
  const partIndex = retryStreamId ? old.segments?.findIndex((part) => part.streamId === retryStreamId) ?? -1 : -1;
  const offset = partIndex >= 0 ? replySegmentsContent(old.segments.slice(0, partIndex)).length : old.content.length;
  next[idx] = {
    ...old,
    recoveryNotice,
    recoveryOffset: retryStreamId && old.recoveryStreamId === retryStreamId ? old.recoveryOffset ?? offset : offset,
    recoveryStreamId: retryStreamId
  };
  return next;
}
function applySnapshot(streams) {
  const out = [];
  const retryNoticeEntries = /* @__PURE__ */ new Map();
  const retryNoticeLabel = (s, attempt) => `_\u81EA\u52A8\u91CD\u8BD5\u8BF7\u6C42${s.done ? "\u5DF2\u5B8C\u6210" : "\u8FDB\u884C\u4E2D"}\uFF08${attempt || "?"}${s.retry_max ? `/${s.retry_max}` : ""}${s.retry_reason ? ` \xB7 ${s.retry_reason}` : ""}\uFF09\u3002_`;
  for (const s of streams) {
    if (isHiddenSource(s.source)) continue;
    if (s.source === "chat_error_retry" || s.source === "auto_continue") {
      const attempt = s.retry_attempt || 0;
      const done = !!s.done;
      const retryKey = s.logical_id || s.retry_of || s.stream_id || "";
      const noticeKey = `${s.run_id || "legacy"}:${retryKey}`;
      const meta = retryNoticeEntries.get(noticeKey);
      if (!done && (meta === void 0 || attempt > meta.attempt)) {
        retryNoticeEntries.set(noticeKey, { idx: 0, attempt, done });
        const withNotice = upsertRetryNotice(
          out,
          retryKey,
          retryNoticeLabel(s, attempt),
          epochMilliseconds(s.started_at) ?? void 0,
          s.stream_id,
          s.run_id
        );
        out.splice(0, out.length, ...withNotice);
      }
      if (s.content || !s.done) {
        const merged = updateLogicalReply(out, {
          type: s.done ? "done" : "next",
          stream_id: s.stream_id,
          logical_id: s.logical_id,
          run_id: s.run_id,
          retry_of: s.retry_of,
          source: s.source,
          content: s.content,
          turn_segs: s.turn_segs
        }, epochMilliseconds(s.done ? s.finished_at : s.started_at) ?? Date.now());
        out.splice(0, out.length, ...merged);
      }
      continue;
    }
    if (s.query) {
      out.push({
        role: "user",
        content: s.query,
        logicalId: s.logical_id,
        runId: s.run_id,
        streamId: s.stream_id,
        source: s.source,
        timestamp: epochMilliseconds(s.started_at)
      });
    }
    if (s.content || !s.done) {
      out.push({
        role: "assistant",
        content: s.content,
        logicalId: s.logical_id,
        runId: s.run_id,
        outcome: s.outcome,
        turnSegments: validTurnSegments(s.turn_segs, s.content),
        segments: [{
          streamId: s.stream_id,
          content: s.content,
          done: s.done,
          turnSegments: validTurnSegments(s.turn_segs, s.content)
        }],
        streamId: s.stream_id,
        source: s.source,
        streaming: !s.done,
        startedAt: epochMilliseconds(s.started_at),
        timestamp: epochMilliseconds(s.done ? s.finished_at : s.started_at)
      });
    }
  }
  return out;
}
var ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS = 2 * 60 * 1e3;
function timestampsOverlap(archived, snapshot) {
  if (archived.timestamp == null || snapshot.timestamp == null) return true;
  return Math.abs(archived.timestamp - snapshot.timestamp) <= ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS;
}
function removeArchivedSnapshotOverlap(base, live) {
  const archived = base.filter((msg) => msg.source === "history");
  const skipped = /* @__PURE__ */ new Set();
  for (let index = 0; index + 1 < live.length; index += 1) {
    const query = live[index];
    const answer = live[index + 1];
    if (query.role !== "user" || answer.role !== "assistant" || query.streamId == null || query.streamId !== answer.streamId || answer.streaming !== false) continue;
    for (let historyIndex = archived.length - 2; historyIndex >= 0; historyIndex -= 1) {
      if (pairsDescribeSameTurn(archived[historyIndex], archived[historyIndex + 1], query, answer)) {
        skipped.add(index);
        skipped.add(index + 1);
        break;
      }
    }
  }
  return live.filter((_, index) => !skipped.has(index));
}
function pairsDescribeSameTurn(archivedQuery, archivedAnswer, query, answer) {
  if (archivedQuery.role !== "user" || archivedAnswer.role !== "assistant") return false;
  if (archivedQuery.runId || query.runId) return !!archivedQuery.runId && archivedQuery.runId === query.runId;
  if (archivedQuery.logicalId || query.logicalId) return !!archivedQuery.logicalId && archivedQuery.logicalId === query.logicalId;
  if (archivedQuery.content !== query.content) return false;
  if (!timestampsOverlap(archivedQuery, query) || !timestampsOverlap(archivedAnswer, answer)) return false;
  const temporalEvidence = archivedQuery.timestamp != null && query.timestamp != null && archivedAnswer.timestamp != null && answer.timestamp != null;
  if (!temporalEvidence && archivedAnswer.content !== answer.content) return false;
  return true;
}
function livePositionKey(msg) {
  const identity = msg.runId || msg.logicalId || msg.streamId;
  if (!identity) return null;
  return `${identity}\0${msg.role}`;
}
function mergeRunReply(old, incoming) {
  const segments = [...old.segments ?? []];
  let archiveCursor = 0;
  for (const part of incoming.segments ?? []) {
    let index = segments.findIndex((previous) => previous.streamId === part.streamId);
    if (index < 0 && part.content) {
      index = segments.findIndex((previous, i) => i >= archiveCursor && previous.streamId.startsWith("history:") && !!previous.content && (part.content.startsWith(previous.content) || previous.content.startsWith(part.content)));
      if (index >= 0) archiveCursor = index + 1;
    }
    if (index < 0) segments.push(part);
    else {
      const previous = segments[index];
      const fromArchive = previous.archived || previous.streamId.startsWith("history:");
      const keepPrevious = fromArchive ? !part.content : previous.content.startsWith(part.content);
      segments[index] = {
        ...part,
        content: keepPrevious ? previous.content : part.content,
        turnSegments: previous.content === part.content ? part.turnSegments ?? previous.turnSegments : keepPrevious ? previous.turnSegments : part.turnSegments,
        archived: keepPrevious ? previous.archived : part.archived,
        // Archive completion is not physical-stream completion for an active run.
        done: part.done || !fromArchive && previous.done
      };
    }
  }
  return { ...old, ...incoming, segments, content: replySegmentsContent(segments), turnSegments: replySegmentsTurns(segments) };
}
function mergeLive(base, live) {
  const out = [...base];
  const adopted = /* @__PURE__ */ new Set();
  for (let i = 0; i + 1 < live.length; i += 1) {
    const query = live[i];
    const answer = live[i + 1];
    if (query.role !== "user" || answer.role !== "assistant" || !answer.streaming || !query.streamId || query.streamId !== answer.streamId || query.timestamp == null) continue;
    for (let j = out.length - 2; j >= 0; j -= 1) {
      const archivedQuery = out[j];
      const archivedAnswer = out[j + 1];
      if (archivedQuery.source !== "history" || archivedAnswer.source !== "history" || archivedQuery.role !== "user" || archivedAnswer.role !== "assistant" || archivedQuery.runId || query.runId || archivedQuery.logicalId || query.logicalId || archivedQuery.content !== query.content || archivedQuery.timestamp == null || !timestampsOverlap(archivedQuery, query)) continue;
      out[j] = { ...archivedQuery, ...query };
      out[j + 1] = { ...archivedAnswer, ...answer };
      adopted.add(query);
      adopted.add(answer);
      break;
    }
  }
  const positions = /* @__PURE__ */ new Map();
  out.forEach((m, index) => {
    const key = livePositionKey(m);
    if (key) positions.set(key, index);
  });
  for (const msg of removeArchivedSnapshotOverlap(base, live)) {
    if (adopted.has(msg)) continue;
    const key = livePositionKey(msg);
    if (key && positions.has(key)) {
      const index = positions.get(key);
      const old = out[index];
      if (old.outcome) continue;
      if (old.content.startsWith(msg.content) && old.content.length > msg.content.length) continue;
      out[index] = old.role === "assistant" && old.runId && old.runId === msg.runId ? mergeRunReply(old, msg) : {
        ...old,
        ...msg,
        // Snapshot retries may carry a later query timestamp for the same run.
        timestamp: old.role === "user" && old.runId && old.runId === msg.runId ? Math.min(old.timestamp ?? Infinity, msg.timestamp ?? Infinity) === Infinity ? null : Math.min(old.timestamp ?? Infinity, msg.timestamp ?? Infinity) : msg.timestamp
      };
      continue;
    }
    out.push(msg);
    if (key) positions.set(key, out.length - 1);
  }
  return orderConversationTurns(out);
}
function orderConversationTurns(messages) {
  const turns = [];
  const runs = /* @__PURE__ */ new Map();
  let legacy;
  for (const message of messages) {
    let turn;
    if (message.runId && !message.pendingWebui) {
      turn = runs.get(message.runId);
      if (!turn) {
        turn = { messages: [] };
        runs.set(message.runId, turn);
        turns.push(turn);
      }
      legacy = void 0;
    } else if (message.role === "assistant" && !message.runId && message.source !== "system" && message.source !== "runtime_error_notice" && legacy && (message.source === "history" || message.streamId != null && legacy.messages[0].streamId === message.streamId)) {
      turn = legacy;
    } else {
      turn = { messages: [] };
      turns.push(turn);
      legacy = message.role === "user" && !message.runId && !message.pendingWebui ? turn : void 0;
    }
    turn.messages.push(message);
    if (message.role === "user" && !message.pendingWebui && message.timestamp != null && Number.isFinite(message.timestamp)) {
      turn.anchor = turn.anchor == null ? message.timestamp : Math.min(turn.anchor, message.timestamp);
    }
  }
  for (const turn of turns) {
    if (turn.anchor != null) continue;
    for (const message of turn.messages) {
      if (message.role === "assistant" && message.startedAt != null && Number.isFinite(message.startedAt) && message.source !== "system" && message.source !== "runtime_error_notice") {
        turn.anchor = turn.anchor == null ? message.startedAt : Math.min(turn.anchor, message.startedAt);
      }
    }
  }
  const dated = turns.filter((turn) => turn.anchor != null).sort((a, b) => a.anchor - b.anchor);
  let index = 0;
  const ordered = turns.flatMap((turn) => {
    const selected = turn.anchor == null ? turn : dated[index++];
    return selected.messages.some((message) => message.role === "user") ? [
      ...selected.messages.filter((message) => message.role === "user"),
      ...selected.messages.filter((message) => message.role !== "user")
    ] : selected.messages;
  });
  return ordered.length === messages.length && ordered.every((message, i) => message === messages[i]) ? messages : ordered;
}
function mergeSessionSnapshot(base, event) {
  base = base.map((message) => message.source === "history" ? settleSnapshot([message], event)[0] : message);
  const active = event.active_message;
  if (active?.query && active.ts != null) {
    const existing = event.streams?.find((s) => s.stream_id === active.stream_id);
    const streams = [...(event.streams ?? []).filter((s) => s.stream_id !== active.stream_id), {
      ...existing,
      run_id: active.run_id || event.run_id || void 0,
      logical_id: active.logical_id || existing?.logical_id,
      retry_of: active.retry_of || existing?.retry_of,
      retry_attempt: active.retry_attempt ?? existing?.retry_attempt,
      retry_max: active.retry_max ?? existing?.retry_max,
      retry_reason: active.retry_reason || existing?.retry_reason,
      stream_id: active.stream_id,
      source: active.source ?? existing?.source ?? "webui",
      query: active.query,
      started_at: active.ts,
      finished_at: existing?.finished_at ?? 0,
      content: active.content,
      turn_segs: active.turn_segs ?? (active.content === existing?.content ? existing.turn_segs : void 0),
      done: active.done
    }];
    return orderConversationTurns(settleSnapshot(mergeLive(base, applySnapshot(streams)), event));
  }
  let msgs = event.streams ? mergeLive(base, applySnapshot(event.streams)) : base;
  if (active) msgs = applyEvent(msgs, {
    type: active.done ? "done" : "next",
    stream_id: active.stream_id,
    content: active.content,
    turn_segs: active.turn_segs,
    run_id: active.run_id,
    logical_id: active.logical_id,
    source: active.source,
    retry_of: active.retry_of
  });
  return orderConversationTurns(settleSnapshot(msgs, event));
}
function settleSnapshot(msgs, event) {
  const state = { ...event, ...event.runtime };
  const completedRunId = event.runtime?.completed_run_id ?? event.completed_run_id;
  const outcome = event.runtime?.outcome ?? event.outcome;
  const settled = applyEvent(msgs, {
    type: "session_runtime",
    session_id: event.session_id || "",
    status: state.status || "",
    run_id: state.run_id || "",
    stream_id: state.stream_id || null,
    completed_run_id: completedRunId,
    outcome
  });
  if (event.runtime?.status !== "idle" || event.active_message && !event.active_message.done || event.streams?.some((stream) => !stream.done)) return settled;
  return settled.map((message) => message.role === "assistant" && message.streaming ? {
    ...message,
    streaming: false,
    finishedAt: message.finishedAt ?? Date.now(),
    recoveryNotice: void 0,
    recoveryOffset: void 0,
    recoveryStreamId: void 0
  } : message);
}
function updateLogicalReply(prev, evt, now) {
  const sid = evt.stream_id;
  const key = evt.logical_id || evt.retry_of || sid;
  const idx = prev.findIndex((m) => m.role === "assistant" && belongsToRun(m, evt.run_id) && (!!evt.run_id || m.logicalId === key || m.streamId === key || m.streamId === sid || m.segments?.some((part2) => part2.streamId === sid || part2.streamId === evt.retry_of)));
  const old = idx < 0 ? void 0 : prev[idx];
  if (old?.outcome) return prev;
  const initial = old?.segments ?? (old?.streamId ? [{
    streamId: old.streamId,
    content: old.content,
    done: !old.streaming && !old.stopped
  }] : []);
  if (evt.type === "started" && initial.some((part2) => part2.streamId === sid)) return prev;
  const part = updateReplySegments([], sid, evt.type, "content" in evt ? evt.content : void 0, evt.turn_segs);
  const segments = old?.runId ? mergeRunReply({ ...old, segments: initial }, { ...old, segments: part }).segments : updateReplySegments(initial, sid, evt.type, "content" in evt ? evt.content : void 0, evt.turn_segs);
  const latest = segments[segments.length - 1];
  const streaming = !old?.stopped && !latest.done;
  const message = {
    ...old,
    role: "assistant",
    logicalId: old?.logicalId || key,
    runId: evt.run_id || old?.runId,
    streamId: old?.streamId || sid,
    source: old?.source || evt.source,
    segments,
    content: replySegmentsContent(segments),
    turnSegments: replySegmentsTurns(segments),
    streaming,
    timestamp: old?.timestamp ?? now,
    startedAt: old?.startedAt ?? now,
    finishedAt: streaming ? null : old?.finishedAt ?? now,
    ...streaming ? {} : { recoveryNotice: void 0, recoveryOffset: void 0, recoveryStreamId: void 0 }
  };
  if (idx < 0) return [...prev, message];
  const next = prev.slice();
  next[idx] = message;
  return next;
}
function applyEvent(prev, evt, abortedStreams = /* @__PURE__ */ new Map()) {
  if (evt.type === "session_runtime") {
    if (evt.status === "running" && evt.run_id) {
      return prev.map((m) => m.role === "assistant" && m.runId === evt.run_id && !m.outcome && !m.stopped ? { ...m, streaming: true, finishedAt: null } : m);
    }
    if (evt.status !== "idle" || !evt.completed_run_id || !evt.outcome) return prev;
    return prev.map((m) => m.role === "assistant" && m.runId === evt.completed_run_id ? {
      ...m,
      streaming: false,
      recoveryNotice: void 0,
      recoveryOffset: void 0,
      recoveryStreamId: void 0,
      outcome: evt.outcome,
      stopped: evt.outcome === "cancelled",
      finishedAt: m.finishedAt ?? Date.now()
    } : m);
  }
  if ((evt.type === "next" || evt.type === "done") && (evt.run_id || evt.logical_id)) {
    if (isHiddenSource(evt.source)) return prev;
    return updateLogicalReply(prev, evt, Date.now());
  }
  const msgs = reduceEvent(prev, evt, abortedStreams);
  if (evt.type !== "started") return msgs;
  return msgs.map((m) => m.streamId === evt.stream_id && (!m.runId || belongsToRun(m, evt.run_id)) ? {
    ...m,
    runId: evt.run_id || m.runId,
    logicalId: evt.logical_id || m.logicalId
  } : m);
}
function reduceEvent(prev, evt, abortedStreams) {
  const now = Date.now();
  if (evt.type === "snapshot") {
    return mergeSessionSnapshot(prev, evt);
  }
  if (evt.type === "reset") {
    return [];
  }
  if (evt.type === "started") {
    const sid = evt.stream_id;
    const source = evt.source ?? "user";
    const query = evt.query ?? "";
    if (isHiddenSource(source)) return prev;
    const retryAttempt = evt.retry_attempt ?? 0;
    if (source === "chat_error_retry" || source === "auto_continue") {
      const retryKey = evt.logical_id || evt.retry_of || sid;
      const reason = evt.retry_reason === "truncated" ? "\u622A\u65AD\u7EED\u63A5" : "\u7F51\u7EDC\u91CD\u8BD5";
      const note = `_\u7CFB\u7EDF${reason}\uFF08${retryAttempt || "?"}${evt.retry_max ? `/${evt.retry_max}` : ""}\uFF09\u3002_`;
      const withNotice = upsertRetryNotice(prev, retryKey, note, now, sid, evt.run_id);
      return updateLogicalReply(withNotice, evt, epochMilliseconds(evt.ts) ?? now);
    }
    if (prev.some((m) => m.role === "assistant" && belongsToRun(m, evt.run_id) && (m.streamId === sid || !!evt.run_id || evt.logical_id && m.logicalId === evt.logical_id))) {
      return updateLogicalReply(prev, evt, epochMilliseconds(evt.ts) ?? now);
    }
    if (source === "webui") {
      const idx = [...prev].reverse().findIndex((m) => m.role === "user" && m.pendingWebui);
      if (idx !== -1) {
        const realIdx = prev.length - 1 - idx;
        const adopted = prev.slice();
        adopted[realIdx] = {
          ...adopted[realIdx],
          streamId: sid,
          runId: evt.run_id,
          logicalId: evt.logical_id,
          pendingWebui: false,
          // Keep the local identity as a receipt, even after WS adoption.
          pendingWebuiId: adopted[realIdx].pendingWebuiId
        };
        return [...adopted, { role: "assistant", content: "", streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null }];
      }
    }
    const next = prev.slice();
    if (!next.some((m) => m.role === "user" && belongsToRun(m, evt.run_id) && m.streamId === sid)) {
      next.push({ role: "user", content: query, streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, timestamp: now });
    }
    if (!next.some((m) => m.role === "assistant" && belongsToRun(m, evt.run_id) && m.streamId === sid)) {
      next.push({ role: "assistant", content: "", streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null });
    }
    return next;
  }
  if (evt.type === "next") {
    if (isHiddenSource(evt.source)) return prev;
    return updateLogicalReply(ensureRetryStartNotice(prev, evt), evt, now);
  }
  if (evt.type === "done") {
    const sid = evt.stream_id;
    if (isHiddenSource(evt.source)) return prev;
    abortedStreams.delete(sid);
    const next = ensureRetryStartNotice(prev, evt);
    if (evt.source !== "system") return updateLogicalReply(next, evt, now);
    const role = evt.source === "system" ? "system" : "assistant";
    const idx = next.findIndex((m) => (m.role === "assistant" || m.role === "system") && m.streamId === sid);
    if (idx === -1) {
      return [...next, { role, content: evt.content, streamId: sid, source: evt.source, streaming: false, timestamp: now, startedAt: now, finishedAt: now }];
    }
    const updated = next.slice();
    updated[idx] = { ...updated[idx], content: evt.content, streaming: false, timestamp: now, finishedAt: now };
    return updated;
  }
  if (evt.type === "retry") {
    if (isHiddenSource(evt.source)) return prev;
    const reason = evt.reason?.label || evt.retry_reason || "\u53EF\u6062\u590D\u9519\u8BEF";
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || "",
      `_\u68C0\u6D4B\u5230 ${reason}\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\uFF08${evt.attempt}/${evt.max_attempts}\uFF09\u3002_`,
      now,
      void 0,
      evt.run_id
    );
  }
  if (evt.type === "retry_exhausted") {
    if (isHiddenSource(evt.source)) return prev;
    const reason = evt.reason?.label || evt.retry_reason || "\u53EF\u6062\u590D\u9519\u8BEF";
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || "",
      `_\u68C0\u6D4B\u5230 ${reason}\uFF0C\u4F46\u81EA\u52A8\u91CD\u8BD5\u5DF2\u8FBE\u5230\u4E0A\u9650\uFF08${evt.max_attempts}/${evt.max_attempts}\uFF09\u3002_`,
      now,
      void 0,
      evt.run_id
    );
  }
  if (evt.type === "retry_scheduled") {
    if (isHiddenSource(evt.source)) return prev;
    const reason = evt.reason?.label || evt.retry_reason || "\u53EF\u6062\u590D\u9519\u8BEF";
    const secs = Math.max(1, Math.round(evt.delay_seconds ?? 0));
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || "",
      `_\u68C0\u6D4B\u5230 ${reason}\uFF0C\u7EA6 ${secs}s \u540E\u81EA\u52A8\u91CD\u8BD5\uFF08${evt.attempt}/${evt.max_attempts}\uFF09\u3002_`,
      now,
      void 0,
      evt.run_id
    );
  }
  if (evt.type === "error") {
    if (evt.stream_id && abortedStreams.has(evt.stream_id)) {
      return prev.map((m) => m.streaming ? { ...m, streaming: false, finishedAt: now } : m);
    }
    const noticeId = `${evt.stream_id}:error:${evt.code}`;
    const stopped = prev.map(
      (m) => m.streamId === evt.stream_id && m.streaming ? { ...m, streaming: false, finishedAt: now } : m
    );
    if (stopped.some((m) => m.streamId === noticeId)) return stopped;
    return [
      ...stopped,
      {
        role: "assistant",
        content: `_\u8FD0\u884C\u9519\u8BEF\uFF08${evt.code}\uFF09\uFF1A${evt.detail || "\u4F1A\u8BDD\u8FD0\u884C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"}_`,
        streamId: noticeId,
        source: "runtime_error_notice",
        timestamp: now
      }
    ];
  }
  if (evt.type === "aborted") {
    for (const m of prev) {
      if (m.streaming && m.streamId) abortedStreams.set(m.streamId, Date.now());
    }
    return prev.map((m) => m.streaming ? { ...m, streaming: false, finishedAt: now, stopped: true } : m);
  }
  if (evt.type === "rewound") {
    const sids = new Set(evt.removed_sids || []);
    if (sids.size === 0) return prev;
    return prev.filter((m) => {
      if (!m.streamId) return true;
      if (sids.has(m.streamId)) return false;
      const base = m.streamId.split(":")[0];
      return !sids.has(base);
    });
  }
  return prev;
}
function ensureRetryStartNotice(prev, evt) {
  if (evt.type !== "next" && evt.type !== "done") return prev;
  if (evt.source !== "chat_error_retry" && evt.source !== "auto_continue") return prev;
  if (prev.some((m) => belongsToRun(m, evt.run_id) && m.segments?.some((part) => part.streamId === evt.stream_id && part.done))) return prev;
  const attempt = evt.retry_attempt ?? 0;
  const retryKey = evt.logical_id || evt.retry_of || evt.stream_id || "";
  const reason = evt.retry_reason === "truncated" ? "\u622A\u65AD\u7EED\u63A5" : "\u7F51\u7EDC\u91CD\u8BD5";
  const note = `_\u7CFB\u7EDF${reason}\uFF08${attempt || "?"}${evt.retry_max ? `/${evt.retry_max}` : ""}\uFF09\u3002_`;
  return upsertRetryNotice(prev, retryKey, note, void 0, evt.stream_id, evt.run_id);
}

// webui/src/utils/assistantTranscript.ts
var FINAL_MARKER_RE = /\n*(?:`{3,5}[^\r\n]*\r?\n?)?\[Info\]\s*Final response to user\.\s*(?:\r?\n?`{3,5})?\s*$/i;
function stripFinalResponseMarker(text) {
  return (text || "").replace(FINAL_MARKER_RE, "").trim();
}
function extractSummary(text) {
  const node = scanTranscript(text).filter((node2) => node2.kind === "summary" && node2.complete).at(-1);
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

// webui/src/utils/messagePresentation.ts
function messagePresentation(content, streaming = false, segments) {
  return parseAssistantTranscript(content, streaming, segments);
}
function remoteMessagePresentation(source) {
  const content = String(source.content || "");
  const meta = { compact: true };
  for (const key of [
    "id",
    "role",
    "ordinal",
    "timestamp",
    "session_id",
    "run_id",
    "logical_id",
    "stream_id",
    "archive_generation",
    "outcome",
    "attachments",
    "artifacts",
    "streaming"
  ]) {
    if (source[key] !== void 0) meta[key] = source[key];
  }
  if (source.role !== "assistant") return { ...meta, content };
  const parsed = messagePresentation(content, !!source.streaming, source.turn_segs ?? source.turn_segments);
  const prose = (text) => scanTranscript(text).map((node) => {
    if (node.kind === "text" || node.kind === "code") return node.raw;
    if (node.kind === "tool" && node.complete && node.name?.split(".").at(-1)?.toLowerCase() === "ask_user") {
      const question = extractAskUserPayload(node.raw);
      return question ? "\n\n" + renderAskUserPayload(question) + "\n\n" : "";
    }
    return "";
  }).join("").trim();
  return { ...meta, content: prose(content), progress: {
    turns: parsed.turns.map((turn) => ({ turn: turn.turn, summary: turn.summary, content: prose(turn.content) })),
    turn_count: parsed.turns.length,
    final_body: prose(parsed.finalBody),
    question: parsed.finalAskUser
  } };
}
function remoteMessagePage(data) {
  return { ...data, presentation_version: 1, items: (data.items || []).map(remoteMessagePresentation) };
}
function remoteProgress(frame) {
  const runtime = frame.runtime || frame;
  const sid = frame.session_id;
  if (!sid || "session_id" in runtime && runtime.session_id !== sid || frame.streams?.some((row) => "session_id" in row && row.session_id !== sid) || frame.active_message && "session_id" in frame.active_message && frame.active_message.session_id !== sid) {
    throw new Error("Snapshot session mismatch");
  }
  const messages = mergeSessionSnapshot([], frame);
  const items = messages.map((message, index) => remoteMessagePresentation({
    id: `${sid}:${message.role}:${message.runId || message.logicalId || message.streamId || index}`,
    session_id: sid,
    role: message.role,
    content: message.content,
    run_id: message.runId,
    logical_id: message.logicalId,
    stream_id: message.streamId,
    timestamp: message.timestamp,
    streaming: message.streaming,
    turn_segs: message.turnSegments,
    outcome: message.outcome
  }));
  const state = { session_id: sid };
  for (const key of ["status", "run_id", "stream_id", "completed_run_id", "outcome", "error"]) {
    if (key in runtime) state[key] = runtime[key];
  }
  return { type: "progress", session_id: sid, runtime: state, items, presentation_version: 1, epoch: frame.epoch };
}

// server/services/message-presentation-worker.ts
(0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let id;
  try {
    const request = JSON.parse(line);
    id = request.id;
    process.stdout.write(JSON.stringify({ id, data: request.kind === "progress" ? remoteProgress(request.data) : remoteMessagePage(request.data) }) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({ id, error: "message_presentation_failed" }) + "\n");
  }
});
