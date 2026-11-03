import { markdown, transcript, visibleProcess } from './remote-render.jsx';
export const sessionTitle = session => typeof session?.title === 'string' && session.title.trim() ? session.title.trim() : '未命名会话';
export const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
export const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem('ga-remote-' + key)) ?? fallback; } catch { return fallback; } };
export const saveStore = (key, value) => { try { localStorage.setItem('ga-remote-' + key, JSON.stringify(value)); } catch {} };
const folds = readStore('folds', {});
const stars = new Set(readStore('stars', []));
let filter = 'all';
const expandedGroups = new Set();
const recency = session => {
  for (const stamp of [session.updated_at, session.created_at]) {
    const value = Date.parse(stamp ?? ''); if (Number.isFinite(value)) return value;
  }
  return 0;
};
const labels = {idle:'空闲',running:'运行中',starting:'启动中',error:'异常',stopping:'停止中',unknown:'读取中'};
export const statusLabel = status => labels[status] || status || '未知';
function detail(key, title, cls, initiallyOpen = false) {
  const node = el('details', cls); node.dataset.foldKey = key;
  node.open = Object.hasOwn(folds, key) ? !!folds[key] : initiallyOpen;
  node.append(el('summary', '', title));
  node.addEventListener('toggle', () => { folds[key] = node.open; const keys = Object.keys(folds); if (keys.length > 1000) delete folds[keys[0]]; saveStore('folds', folds); });
  return node;
}
// Keep each reply compact; older summaries are rendered only when requested.
function appendRecentTurns(body, turns, key, renderTurn, process) {
  const split = Math.max(0, turns.length - 5);
  if (split) {
    const historyKey = key + ':older-turns';
    const group = el('div', 'turn-history');
    const toggle = el('button', 'turn-history-toggle'); toggle.type = 'button';
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>';
    const older = el('div', 'turn-history-content');
    let populated = false;
    const update = open => {
      const label = `${open ? '收起' : '展开'}更早的 ${split} 条`;
      toggle.setAttribute('aria-label', label); toggle.title = label;
      toggle.setAttribute('aria-expanded', String(open)); older.hidden = !open;
      if (open && !populated) { populated = true; turns.slice(0, split).forEach(turn => older.append(renderTurn(turn))); }
    };
    update(!!folds[historyKey]);
    toggle.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (!process.open) process.open = true;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      folds[historyKey] = open; saveStore('folds', folds); update(open);
    };
    process.firstChild.append(toggle);
    group.append(older); body.append(group);
  }
  turns.slice(split).forEach(turn => body.append(renderTurn(turn)));
}
export function setProcessOpen(open) {
  document.querySelectorAll('#messages details.process, #messages details.turn').forEach(d => { d.open = open; folds[d.dataset.foldKey] = open; });
  saveStore('folds', folds);
}
export function initFilters(render) {
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    render();
  });
}
export function renderRail(sessions, selected, choose, refresh) {
  const host = document.getElementById('sessions'), term = document.getElementById('search').value.trim().toLowerCase();
  const oldScroll = host.scrollTop;
  const filtered = sessions.filter(s => `${sessionTitle(s)} ${s.project_name?.trim() || '自由会话'} ${s.project_path || ''}`.toLowerCase().includes(term)
    && (filter !== 'running' || ['running','starting','stopping'].includes(s.status)) && (filter !== 'starred' || stars.has(s.id)));
  document.getElementById('sessionCount').textContent = `${filtered.length} / ${sessions.length}`;
  const groups = new Map();
  const hasProjects = sessions.some(s => s.project_name?.trim());
  for (const s of filtered.sort((a,b) => recency(b) - recency(a))) {
    const name = s.project_name?.trim(), key = name ? 'project:' + name : 'free';
    if (!groups.has(key)) groups.set(key, {name: name || '自由会话', rows: [], path: s.project_path});
    groups.get(key).rows.push(s);
  }
  const fragment = document.createDocumentFragment();
  for (const [key, {name, rows, path}] of groups) {
    const group = detail('rail-group:' + key, '', 'session-group', true);
    group.dataset.groupKey = key;
    if (term) group.open = true;
    group.firstChild.title = key === 'free' ? '未绑定项目的会话' : `绑定项目：${name}${path ? '\n' + path : ''}`;
    group.firstChild.append(el('span', 'group-name', name), el('small', 'group-kind', key === 'free' ? '未绑定' : '项目'), el('span', 'group-count', String(rows.length)));
    const expandable = hasProjects && rows.length > 3 && !term;
    const showAll = expandedGroups.has(key);
    const visible = expandable && !showAll ? rows.slice(0, 3) : rows;
    const current = rows.find(s => s.id === selected);
    if (current && !visible.includes(current)) visible[visible.length - 1] = current;
    for (const s of visible) {
      const row = el('div', 'session-row' + (selected === s.id ? ' active' : ''));
      const button = el('button', 'session'); button.type = 'button'; button.dataset.sessionId = s.id;
      button.setAttribute('aria-current', selected === s.id ? 'page' : 'false');
      const title = el('div', 'session-title'); title.append(el('span', 'dot ' + s.status), el('span', 'label', sessionTitle(s)), el('span', 'session-status', statusLabel(s.status)));
      const meta = el('div', 'session-meta'); const date = new Date(s.updated_at || s.created_at);
      meta.append(el('span','session-status-detail',statusLabel(s.status)),el('span','session-date',Number.isNaN(+date) ? '' : date.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})));
      button.append(title,meta); button.title = sessionTitle(s); button.onclick = () => choose(s.id);
      const star = el('button', 'star-button', stars.has(s.id) ? '★' : '☆'); star.type = 'button';
      star.setAttribute('aria-label',(stars.has(s.id) ? '取消收藏 ' : '收藏 ') + (sessionTitle(s))); star.setAttribute('aria-pressed', String(stars.has(s.id)));
      star.onclick = () => { stars.has(s.id) ? stars.delete(s.id) : stars.add(s.id); saveStore('stars',[...stars]); refresh(); };
      row.append(button,star);group.append(row);
    }
    if (expandable) {
      const more = el('button', 'group-more', showAll ? '收起为最近 3 条' : `展开全部 ${rows.length} 个会话`);
      more.type = 'button'; more.setAttribute('aria-expanded', String(showAll));
      more.onclick = () => { if (showAll) expandedGroups.delete(key); else expandedGroups.add(key); refresh(); };
      group.append(more);
    }
    fragment.append(group);
  }
  if (!filtered.length) fragment.append(el('div','no-sessions','没有匹配的会话'));
  host.replaceChildren(fragment);host.scrollTop = oldScroll;
}

export function messageCard(message, sid, streaming) {
  const isUser = message.role === 'user', raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
  const key = `${sid}:${message.ordinal}`, article = el('article','message ' + (isUser ? 'user-message' : 'assistant-message'));
  article.dataset.messageKey = key;
  const header = el('div','message-header');
  header.append(el('span','avatar',isUser ? '你' : 'GA'),el('span','',isUser ? '你' : message.role === 'assistant' ? 'GA 助手' : message.role));
  const time = el('time','',message.timestamp ? new Date(message.timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '');
  header.append(time);
  const copy = el('button','message-copy','复制');copy.type = 'button';copy.setAttribute('aria-label','复制消息');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(raw);copy.textContent='已复制'; } catch { copy.textContent='复制失败'; } };
  header.append(copy);article.append(header);
  if (isUser) {
    const body = el('div','user-body');
    if (raw.length > 700) { body.append(el('div','',raw.slice(0,260) + '…'));const full=detail(key+':user','展开完整指令 · '+raw.length+' 字','user-full');full.append(el('pre','',raw));body.append(full); }
    else body.textContent = raw;
    article.append(body);return article;
  }
  if (Array.isArray(message.artifacts)) {
    const files = el('div','artifact-list');
    for (const file of message.artifacts.slice(0,8)) {
      if (typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 ||
          typeof file.url !== 'string' || !/^\/api\/sessions\/[A-Za-z0-9_-]+\/artifacts\/[A-Za-z0-9_-]{43}$/.test(file.url) ||
          file.url.split('/')[3] !== String(sid)) continue;
      const card = el('div','artifact-card'), info = el('div','artifact-info');
      info.append(el('span','artifact-name',file.name));
      const size = file.size < 1024 ? `${file.size} B` : file.size < 1048576 ? `${(file.size/1024).toFixed(1)} KiB` : `${(file.size/1048576).toFixed(1)} MiB`;
      info.append(el('span','artifact-meta',`${(file.extension || '').slice(1).toUpperCase() || 'FILE'} · ${size}`));
      const download = el('a','artifact-download','下载');
      download.href = file.url; download.download = file.name;
      download.setAttribute('aria-label',`下载 ${file.name}`);
      card.append(info,download); files.append(card);
    }
    if (files.childElementCount) article.append(files);
  }
  if (message.compact) {
    const p = message.progress;
    if (p?.turns?.length) {
      const process = detail(key+':process', `执行进度 · ${p.turn_count} 轮${streaming ? ' · 进行中' : ''}`, 'process');
      // Live progress is visible by default, but a user's fold choice survives polling.
      if (streaming && !Object.hasOwn(folds, key+':process')) process.open = true;
      const body = el('div','process-content');
      appendRecentTurns(body, p.turns, key, turn => {
        const row = detail(key+':turn:'+turn.turn, '', 'turn');
        row.firstChild.append(el('span','turn-number',String(turn.turn)), el('span','turn-title',turn.summary || '本轮处理中'));
        if (turn.content) row.append(markdown(turn.content));
        return row;
      }, process);
      process.append(body); article.append(process);
    }
    const reply = p ? p.final_body : raw;
    if (reply?.trim()) article.append(markdown(reply));
    if (p?.question) article.append(el('div','pending-note',[p.question.question,...p.question.candidates].join('\n')));
    if (streaming) article.append(el('div','message-progress','正在执行 · 自动同步进度'));
    else if (!reply?.trim() && !p?.turns?.length) article.append(markdown(raw || '本轮无对话正文'));
    return article;
  }
  const parsed = transcript(raw, streaming, message.turn_segs ?? message.turn_segments);
  const turns = parsed.turns.filter((_, index) => index !== parsed.finalTurnIndex);
  if (turns.length || (!parsed.finalBody && raw.trim())) {
    const process = detail(key+':process',`执行过程 · ${turns.length || parsed.turns.length || 1} 轮${streaming ? ' · 进行中' : ''}`,'process');
    const body = el('div','process-content');
    const renderTurn = turn => {
      const row = detail(key+':turn:'+turn.turn,'','turn');
      row.firstChild.append(el('span','turn-number',String(turn.turn)),el('span','turn-title',turn.summary || '查看本轮过程'));
      // Expensive process rendering is lazy; raw tools/reasoning remain opt-in.
      let populated = false;
      const populate = () => {
        if (!row.open || populated) return;populated=true;
        const visible = visibleProcess(turn.content);
        if (visible.prose.trim()) row.append(markdown(visible.prose));
        if (visible.tools.length) row.append(el('div','tool-hint',`工具调用 ${visible.tools.length} 次 · ${[...new Set(visible.tools)].join('、')}`));
        const full=detail(key+':raw:'+turn.turn,'完整记录（含工具输入输出 / 推理）','raw-toggle');
        full.append(el('pre','raw-record',turn.rawContent || turn.content));row.append(full);
      };
      row.addEventListener('toggle',populate);populate();return row;
    };
    appendRecentTurns(body, turns, key, renderTurn, process);
    if (!turns.length) { const full=detail(key+':raw','查看完整记录','raw-toggle');full.append(el('pre','raw-record',raw));body.append(full); }
    process.append(body);article.append(process);
  }
  if (parsed.finalBody) {
    article.append(markdown(parsed.finalBody));
  } else if (streaming) article.append(el('div','pending-note','正在执行，展开过程查看进展…'));
  if (parsed.finalAskUser) { const q=parsed.finalAskUser;article.append(el('div','pending-note',[q.question,...q.candidates].join('\n'))); }
  return article;
}
