import { LiveProgress } from './remote-live.js';
import { initNewSession } from './remote-new-session.js';
import { visibleMessages } from './remote-messages.js';
import { initMobile, navigateChat, closePanels, resizeInput, updateLatest } from './remote-mobile.js';
import { sessionTitle, renderRail, messageCard, initFilters } from './remote-view.js';
const $ = id => document.getElementById(id);
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const label = dark ? '切换到亮色主题' : '切换到暗色主题';
  $('themeToggle').setAttribute('aria-label', label);
  $('themeToggle').setAttribute('aria-pressed', String(dark));
  $('themeToggle').title = label;
  document.querySelector('meta[name="color-scheme"]').content = dark ? 'dark' : 'light';
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('ga-remote-theme') || 'light'; } catch {}
applyTheme(savedTheme);
$('themeToggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('ga-remote-theme', theme); } catch {}
};

let sessions = [], selected = '', messages = [], nextBefore = null;
let generation = 0, expanded = false;
let historyRequest = null, progressRequest = null, settleTimer = null;
const historyCache = new Map();
let uploading = false, stopping = false;
const attachmentDrafts = new Map();
let sending = false, runtimeStatus = 'unknown', liveMessages = [];
const acceptedMessages = new Map();
let models = [], modelsLoading = false, modelSaving = false;
function renderModel() {
  const control = $('modelSelect'), current = sessions.find(s => s.id === selected);
  const key = current?.llm_key || '';
  control.replaceChildren();
  if (!models.some(m => m.key === key)) {
    const option = new Option(key ? '原模型已不可用，请重新选择' : '请选择模型', '');
    option.disabled = true; control.add(option);
  }
  for (const model of models) control.add(new Option(model.name, model.key));
  control.value = models.some(m => m.key === key) ? key : '';
  control.disabled = !selected || modelsLoading || modelSaving || sending || !models.length || !['idle','error'].includes(runtimeStatus);
}
async function loadModels() {
  modelsLoading = true; renderModel();
  try { models = (await api('/api/llms')).llms; $('modelState').textContent = models.length ? '选择后自动保存，下条指令生效' : '本机未配置可用模型'; }
  catch (error) { $('modelState').textContent = '模型列表加载失败，请重新打开设置重试'; throw error; }
  finally { modelsLoading = false; renderModel(); }
}
async function changeModel() {
  if ($('modelSelect').disabled) return;
  const sid = selected, key = $('modelSelect').value;
  modelSaving = true; updateComposer(); $('modelState').textContent = '正在保存…';
  try {
    const response = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/model', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({llm_key:key})});
    if (response.status === 401) { location.href = '/_gateway/login'; return; }
    if (!response.ok) throw Error('切换失败 (' + response.status + ')：' + (await response.text()).slice(0,140));
    const updated = await response.json();
    sessions = sessions.map(s => s.id === sid ? updated : s);
    if (selected === sid) { $('modelState').textContent = '已保存，下条指令使用此模型'; closePanels(); }
  } catch (error) {
    if (selected === sid) { $('modelState').textContent = '保存失败，请刷新确认后重试'; notice(error); }
  } finally { modelSaving = false; updateComposer(); }
}
const drafts = new Map(), pending = new Map();
function currentAttachments() { return attachmentDrafts.get(selected) || []; }
function renderAttachments() {
  const box = $('attachments'); box.replaceChildren();
  for (const file of currentAttachments()) {
    const chip = document.createElement('span'); chip.className = 'attachment-chip';
    const name = document.createElement('span'); name.textContent = file.name; name.title = file.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
    remove.setAttribute('aria-label', '移除附件 ' + file.name); remove.disabled = sending || uploading;
    remove.onclick = () => { attachmentDrafts.set(selected, currentAttachments().filter(f => f.upload_id !== file.upload_id)); updateComposer(); };
    chip.append(name, remove); box.append(chip);
  }
  box.hidden = !box.childElementCount;
}
function updateComposer() {
  const active = ['starting','running','recovering','aborting'].includes(runtimeStatus);
  const stop = active;
  $('instruction').disabled = !selected || sending;
  $('attach').disabled = !selected || sending || uploading || currentAttachments().length >= 8;
  $('send').disabled = !selected || sending || stopping || modelSaving || (stop ? runtimeStatus === 'aborting' : uploading || !['idle','error'].includes(runtimeStatus) || (!$('instruction').value.trim() && !currentAttachments().length));
  const label = stop ? (runtimeStatus === 'aborting' || stopping ? '正在停止' : '停止任务') : '发送指令';
  $('send').classList.toggle('is-stop', stop);
  $('send').setAttribute('aria-label', label); $('send').title = label;
  $('send').innerHTML = stop ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  renderAttachments(); renderModel();
}
async function uploadFiles(files) {
  if (!selected || uploading || sending) return;
  const sid = selected;
  uploading = true; updateComposer(); notice(null);
  try {
    for (const file of files) {
      if ((attachmentDrafts.get(sid) || []).length >= 8) throw Error('每条消息最多 8 个附件');
      if (file.size > 20 * 1024 * 1024) throw Error('单个附件不能超过 20 MB');
      const body = new FormData(); body.append('file', file);
      const response = await fetch('/api/upload', {method:'POST', body});
      if (response.status === 401) { location.href = '/_gateway/login'; return; }
      if (!response.ok) throw Error('上传失败 (' + response.status + ')：' + (await response.text()).slice(0,140));
      const uploaded = await response.json();
      attachmentDrafts.set(sid, [...(attachmentDrafts.get(sid) || []), uploaded]);
      if (selected === sid) renderAttachments();
    }
  } catch (error) { notice(error); }
  finally { uploading = false; $('fileInput').value = ''; updateComposer(); }
}
async function stopRun() {
  const sid = selected; stopping = true; updateComposer(); notice(null);
  try {
    const response = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/abort', {method:'POST'});
    if (response.status === 401) { location.href = '/_gateway/login'; return; }
    if (!response.ok) throw Error('停止失败 (' + response.status + ')：' + (await response.text()).slice(0,140));
    const runtime = await response.json();
    if (selected === sid) { runtimeStatus = runtime.status || 'aborting'; await loadMessages(); }
  } catch (error) { notice(error); }
  finally { stopping = false; updateComposer(); }
}

async function api(path, signal) {
  const response = await fetch(path, {cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)});
  if (response.status === 401) { location.href = '/_gateway/login'; throw Error('请重新登录'); }
  if (!response.ok) throw Error('请求失败 (' + response.status + ')：' + (await response.text()).slice(0, 140));
  return response.json();
}
function notice(error) { $('notice').textContent = error ? String(error.message || error) : ''; }
function renderSessions() { renderRail(sessions, selected, select, renderSessions); }

function toLatest() { const box = $('conversation');box.scrollTop = box.scrollHeight; updateLatest(); }
let rendered = new Map(), firstLoad = true;
async function loadSessions() {
  const [data, runtimes] = await Promise.all([
    api('/api/sessions'),
    api('/api/session-runtimes').catch(() => ({})),
  ]);
  sessions = data.items.map(session => {
    const runtime = runtimes?.[session.id];
    return runtime?.status ? { ...session, status: runtime.status } : session;
  });
  renderSessions();
  if (!selected && sessions.length && !(matchMedia('(max-width:760px)').matches && !new URL(location.href).searchParams.has('session'))) {
    const wanted = new URL(location.href).searchParams.get('session');
    await select(sessions.some(s => s.id === wanted) ? wanted : sessions[0].id, false);
  }
  $('listState').textContent = '已同步 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
  if (!sessions.length) $('empty').textContent = '暂无会话，请在本机 GA-Hub 中创建会话。';
}
function renderMessages(older = false) {
  const box = $('conversation'), top = box.scrollTop, height = box.scrollHeight;
  const follow = firstLoad || height - top - box.clientHeight < 130;
  const visible = visibleMessages(messages, [...(acceptedMessages.get(selected) || []), ...liveMessages]);
  const host = $('messages'), keep = new Set();
  visible.forEach((message, position) => {
    const key = String(message.ordinal), streaming = Boolean(message.streaming);
    const signature = JSON.stringify([message,streaming]); keep.add(key);
    const existing = rendered.get(key);
    if (existing?.signature === signature) {
      if (host.children[position] !== existing.node) host.insertBefore(existing.node, host.children[position] || null);
      return;
    }
    const node = messageCard(message, selected, streaming);
    if (existing) existing.node.replaceWith(node);
    else host.insertBefore(node, host.children[position] || null);
    node.dataset.ordinal = key; rendered.set(key,{signature,node});
  });
  for (const [key,value] of rendered) if (!keep.has(key)) { value.node.remove();rendered.delete(key); }
  $('empty').textContent = visible.length ? '' : selected ? '此会话暂无消息' : '选择左侧会话开始';
  $('older').hidden = nextBefore === null;
  if (older) box.scrollTop = top + box.scrollHeight - height;
  else if (follow) toLatest();
  else box.scrollTop = top;
  firstLoad = false; updateLatest();
}
function mergeMessages(previous, incoming) {
  const byOrdinal = new Map(previous.map(m => [m.ordinal, m]));
  for (const message of incoming) byOrdinal.set(message.ordinal, message);
  return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
}
const live = new LiveProgress({
  onData: applyProgress,
  onState: state => { if (selected && !sending) $('sendState').textContent = state + ' · 会话状态：' + runtimeStatus; },
  onReconnect: sid => { if (sid === selected) loadMessages().catch(quietNotice); },
});
function quietNotice(error) { if (error.name !== 'AbortError') notice(error); }
function cancelReads() {
  historyRequest?.abort(); progressRequest?.abort();
  historyRequest = progressRequest = null;
  clearTimeout(settleTimer); live.close();
}
function cacheHistory() {
  if (!selected) return;
  historyCache.delete(selected);
  historyCache.set(selected, {messages, nextBefore, expanded});
  if (historyCache.size > 12) historyCache.delete(historyCache.keys().next().value);
}
function applyProgress(progress, sid = selected) {
  if (sid !== selected) return;
  const wasActive = ['starting','running','recovering','aborting'].includes(runtimeStatus);
  runtimeStatus = progress.runtime.status;
  liveMessages = progress.items;
  if (!sending) $('sendState').textContent = (live.connected ? '实时同步 · ' : '') + (runtimeStatus === 'idle' ? '可发送指令' : '会话状态：' + runtimeStatus);
  updateComposer(); renderMessages();
  if (wasActive && ['idle','error'].includes(runtimeStatus)) {
    // Keep terminal live messages visible while the archive catches up.
    loadMessages().catch(quietNotice);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (selected === sid) loadMessages().catch(quietNotice); }, 1500);
    loadSessions().catch(quietNotice);
  }
}
async function loadProgress() {
  if (!selected || progressRequest) return;
  const sid = selected, gen = generation, controller = new AbortController();
  progressRequest = controller;
  try {
    const data = await api('/api/sessions/' + encodeURIComponent(sid) + '/progress', controller.signal);
    // Never let a slower polling snapshot overwrite an established live connection.
    if (gen === generation && !live.connected) applyProgress(data, sid);
  } finally { if (progressRequest === controller) progressRequest = null; }
}
async function loadMessages(older = false) {
  if (!selected || historyRequest || (older && nextBefore === null)) return;
  const sid = selected, gen = generation, controller = new AbortController();
  historyRequest = controller; $('older').disabled = true;
  try {
    const suffix = older ? '&before=' + encodeURIComponent(nextBefore) : '';
    const data = await api('/api/sessions/' + encodeURIComponent(sid) + '/messages?view=compact&limit=40' + suffix, controller.signal);
    if (gen !== generation) return;
    messages = older || expanded ? mergeMessages(messages, data.items) : data.items;
    acceptedMessages.set(sid, (acceptedMessages.get(sid) || []).filter(a => !messages.some(m => m.role === 'user' && m.run_id === a.run_id)));
    if (older || !expanded) nextBefore = data.has_more ? data.next_before : null;
    if (older) expanded = true;
    cacheHistory(); renderMessages(older);
  } finally {
    if (historyRequest === controller) { historyRequest = null; $('older').disabled = false; }
  }
}
function syncCurrent() {
  loadProgress().catch(quietNotice);
  return loadMessages();
}
async function select(sid, navigate = true) {
  if (navigate) navigateChat(sid);
  if (sid === selected) return;
  if (selected) drafts.set(selected, $('instruction').value);
  cacheHistory(); cancelReads();
  generation++; selected = sid;
  const cached = historyCache.get(sid);
  messages = cached?.messages || []; liveMessages = []; nextBefore = cached?.nextBefore ?? null; expanded = cached?.expanded || false;
  window.dispatchEvent(new CustomEvent('remote-session-selected', {detail: sid}));
  rendered.clear(); $('messages').replaceChildren(); firstLoad = true;
  runtimeStatus = 'unknown'; $('instruction').value = drafts.get(sid) || '';
  $('sendState').textContent = '正在读取会话状态…'; updateComposer();
  resizeInput();
  const current = sessions.find(s => s.id === sid);
  $('title').textContent = sessionTitle(current);
  notice(null); renderSessions(); $('empty').textContent = '正在加载消息…'; $('older').hidden = true;
  if (cached) renderMessages();
  live.open(sid);
  try { await syncCurrent(); } catch (error) { if (selected === sid) quietNotice(error); }
}
async function sendInstruction(event) {
  event.preventDefault();
  if ($('send').disabled) return;
  if (['starting','running','recovering','aborting'].includes(runtimeStatus)) { await stopRun(); return; }
  const sid = selected, text = $('instruction').value;
  const upload_ids = currentAttachments().map(f => f.upload_id);
  let submission = pending.get(sid);
  if (!submission || submission.text !== text || JSON.stringify(submission.upload_ids || []) !== JSON.stringify(upload_ids)) submission = {text, request_id: crypto.randomUUID(), upload_ids};
  pending.set(sid, submission);
  sending = true; updateComposer(); notice(null);
  $('sendState').textContent = '正在提交，请勿重复发送…';
  try {
    const response = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/runs', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(submission)
    });
    if (response.status === 401) { location.href = '/_gateway/login'; return; }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      if (response.status < 500) pending.delete(sid);
      throw Error('发送未成功 (' + response.status + ')：' + detail);
    }
    const state = await response.json();
    if (state.run_id) {
      const previous = acceptedMessages.get(sid) || [];
      if (!previous.some(m => m.run_id === state.run_id)) previous.push({
        role:'user', run_id:state.run_id, content:text, compact:true,
        ordinal:2e12 + Date.now(), timestamp:new Date().toISOString()
      });
      acceptedMessages.set(sid, previous);
    }
    pending.delete(sid); drafts.delete(sid); attachmentDrafts.delete(sid);
    if (selected === sid) {
      $('instruction').value = ''; resizeInput(); $('instruction').blur(); runtimeStatus = state.status; toLatest();
      $('sendState').textContent = '已提交，等待会话回复…';
      renderMessages();
    }
    if (selected === sid) syncCurrent().catch(quietNotice);
    loadSessions().catch(quietNotice);
  } catch (error) {
    notice(error);
    if (selected === sid) $('sendState').textContent = '草稿已保留；网络异常时先查消息，勿盲目重复发送';
  } finally { sending = false; updateComposer(); }
}
$('composer').onsubmit = sendInstruction;
$('attach').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => uploadFiles([...$('fileInput').files]);
$('instruction').oninput = () => { if (selected) drafts.set(selected, $('instruction').value); resizeInput(); updateComposer(); };
$('instruction').onkeydown = event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault(); $('composer').requestSubmit();
  }
};
$('search').oninput = renderSessions;
initFilters(renderSessions);
$('jumpLatest').onclick = toLatest;
$('headerRefresh').onclick = async () => { $('headerRefresh').disabled = true; try { await Promise.all([loadSessions(), syncCurrent()]); } catch (error) { notice(error); } finally { $('headerRefresh').disabled = false; } };
$('headerModel').onclick = () => {
  loadModels().catch(notice);
  if (window.matchMedia('(max-width:760px)').matches) document.dispatchEvent(new CustomEvent('remote-open-model-settings'));
  else { $('modelSelect').scrollIntoView({behavior: 'smooth', block: 'center'}); $('modelSelect').focus({preventScroll: true}); }
};
window.addEventListener('remote-session-cleared', () => {
  if (selected) drafts.set(selected, $('instruction').value);
  cacheHistory(); cancelReads();
  generation++; selected = ''; messages = []; liveMessages = []; nextBefore = null; expanded = false;
  runtimeStatus = 'unknown'; firstLoad = true;
  rendered.clear(); $('messages').replaceChildren();
  $('instruction').value = ''; $('older').hidden = true;
  $('empty').textContent = '请选择会话';
  $('sendState').textContent = '选择会话后可发送';
  notice(null); resizeInput(); updateComposer(); renderSessions(); updateLatest();
});
initMobile(sid => select(sid, false), () => selected);
initNewSession({ api, loadSessions, select, notice });
$('refreshList').onclick = async () => { $('refreshList').disabled = true; try { await loadSessions(); } catch (error) { $('listState').textContent = '同步失败，请重试'; notice(error); } finally { $('refreshList').disabled = false; } };
$('older').onclick = () => loadMessages(true).catch(notice);
$('modelSelect').onchange = changeModel;
loadModels().catch(notice);
loadSessions().catch(notice);
setInterval(() => { if (!document.hidden && !live.connected) loadProgress().catch(quietNotice); }, 3000);
setInterval(() => { if (!document.hidden) loadMessages().catch(quietNotice); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelReads(); }
  else if (selected) { live.open(selected); syncCurrent().catch(quietNotice); loadSessions().catch(quietNotice); }
});
window.addEventListener('online', () => { if (!document.hidden && selected) { live.open(selected); syncCurrent().catch(quietNotice); } });
setInterval(() => { if (!document.hidden) loadSessions().catch(notice); }, 5000);
