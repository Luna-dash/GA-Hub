const $ = id => document.getElementById(id);
let mobileReady = false;
let listOpen = false;
let toolsOpen = false;
let selectedSession = '';
let restoringPopState = false;

function isMobile() {
  return window.matchMedia('(max-width:760px)').matches;
}

function setList(open) {
  listOpen = Boolean(open && isMobile());
  document.body.classList.toggle('sidebar-open', listOpen);
  $('sidebarBackdrop').hidden = !listOpen;
  $('openSidebar').setAttribute('aria-expanded', String(listOpen));
  if (listOpen) closeTools();
}

function setTools(open) {
  toolsOpen = Boolean(open && isMobile() && selectedSession);
  document.body.classList.toggle('tools-open', toolsOpen);
  $('toolsBackdrop').hidden = !toolsOpen;
  $('headerModel').setAttribute('aria-expanded', String(toolsOpen));
  if (toolsOpen) setList(false);
}

export function closePanels() {
  setList(false);
  setTools(false);
}

function closeList() { setList(false); }
function closeTools() { toolsOpen = false; document.body.classList.remove('tools-open'); $('toolsBackdrop').hidden = true; $('headerModel').setAttribute('aria-expanded', 'false'); }

export function navigateChat(sid) {
  selectedSession = sid;
  if (!isMobile() || restoringPopState) return;
  const url = new URL(location.href);
  if (url.searchParams.get('session') !== sid) {
    url.searchParams.set('session', sid);
    history.pushState({chat: sid}, '', url);
  }
  closePanels();
}

function showListFromHistory() {
  restoringPopState = true;
  selectedSession = '';
  const url = new URL(location.href);
  if (url.searchParams.has('session')) {
    url.searchParams.delete('session');
    history.replaceState({}, '', url);
  }
  document.body.classList.remove('chat-visible');
  closePanels();
  $('title').textContent = '选择一个会话';
  window.dispatchEvent(new CustomEvent('remote-session-cleared'));
  setTimeout(() => { restoringPopState = false; }, 0);
}

function goBackToList() {
  if (!isMobile()) return;
  if (history.state?.chat) history.back();
  else showListFromHistory();
}

function updateViewState() {
  const hasChat = Boolean(selectedSession || new URL(location.href).searchParams.get('session'));
  document.body.classList.toggle('chat-visible', hasChat);
  if (hasChat) $('openSidebar').setAttribute('aria-label', '返回会话列表');
}

export function resizeInput() {
  const input = $('instruction');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, isMobile() ? 132 : 150) + 'px';
}

export function updateLatest() {
  const conversation = $('conversation');
  const button = $('jumpLatest');
  if (!conversation || !button) return;
  const away = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight > 90;
  button.hidden = !away;
}

function bindMobile() {
  $('openSidebar').onclick = () => {
    if (document.body.classList.contains('chat-visible')) goBackToList();
    else setList(true);
  };
  $('sidebarBackdrop').onclick = closeList;
  document.addEventListener('remote-open-model-settings', () => setTools(true));
  $('toolsBackdrop').onclick = closeTools;
  $('conversation').addEventListener('scroll', updateLatest, {passive: true});
  window.addEventListener('resize', () => { resizeInput(); updateLatest(); });
  window.visualViewport?.addEventListener('resize', resizeInput);
  window.addEventListener('popstate', event => {
    const sid = event.state?.chat || new URL(location.href).searchParams.get('session');
    if (sid) {
      selectedSession = sid;
      updateViewState();
      window.dispatchEvent(new CustomEvent('remote-session-from-history', {detail: sid}));
    } else showListFromHistory();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePanels();
  });
}

export function initMobile(onSelect, getSelected) {
  mobileReady = true;
  selectedSession = getSelected() || new URL(location.href).searchParams.get('session') || '';
  bindMobile();
  updateViewState();
  window.addEventListener('remote-session-selected', event => {
    selectedSession = event.detail || getSelected();
    updateViewState();
  });
  window.addEventListener('remote-session-from-history', event => {
    if (event.detail) onSelect(event.detail);
  });
}

window.addEventListener('remote-session-selected', event => {
  if (mobileReady) { selectedSession = event.detail || selectedSession; updateViewState(); }
});
