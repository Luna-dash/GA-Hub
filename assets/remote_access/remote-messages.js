// Physical stream/logical IDs are local to a run, never global identities.
export function sameMessage(a, b) {
  if (a.role !== b.role) return false;
  if (a.run_id || b.run_id) return Boolean(a.run_id && a.run_id === b.run_id);
  // Without a run scope only the exact stream can establish overlap.
  return Boolean(a.stream_id && a.stream_id === b.stream_id);
}

export function visibleMessages(history, live) {
  // Match only the newest message per run/role. Never replace every archived
  // message sharing a reused logical_id, or consume a user's own request.
  const out = history.map(item => ({...item}));
  for (const current of live) {
    let index = -1;
    for (let n = out.length - 1; n >= 0; n--) {
      if (sameMessage(out[n], current)) { index = n; break; }
    }
    if (index < 0) out.push(current);
    else if (current.role === 'assistant' && current.streaming && !out[index].outcome)
      out[index] = {...current, ordinal:out[index].ordinal};
  }
  return out;
}
