// Keep one request identity across retries, including a partially bound session.
export function initNewSession({ api, loadSessions, select, notice }) {
  const $ = id => document.getElementById(id);
  const dialog = $('newSessionDialog'), project = $('newSessionProject');
  const confirm = $('newSessionConfirm'), cancel = $('newSessionCancel'), state = $('newSessionState');
  let pending = null, busy = false, loading = false;
  const lock = value => { busy = value; confirm.disabled = value; cancel.disabled = value; project.disabled = value || !!pending; };
  const close = () => { if (!busy) dialog.close(); };
  cancel.onclick = close;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  $('newSession').onclick = async () => {
    if (dialog.open || loading) return;
    dialog.showModal();
    if (pending) { state.textContent = '上次创建尚未确认，请重试；不会重复创建。'; confirm.textContent = '重试'; lock(false); return; }
    loading = true; lock(true); state.textContent = '正在读取项目…'; confirm.textContent = '确定';
    project.replaceChildren(new Option('自由会话', ''));
    try {
      const catalog = await api('/api/projects');
      for (const item of catalog.items) project.add(new Option(item.name, item.id));
      state.textContent = '';
    } catch (error) {
      state.textContent = '项目读取失败，可创建自由会话；重新打开可重试读取。';
    } finally { loading = false; lock(false); project.focus(); }
  };
  $('newSessionForm').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    pending ||= { request_id: crypto.randomUUID(), project_id: project.value || null };
    lock(true); state.textContent = '正在创建…';
    let session;
    try {
      const response = await fetch('/api/sessions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(pending) });
      if (response.status === 401) { location.href = '/_gateway/login'; return; }
      if (!response.ok) throw Error((await response.text()).slice(0, 280) || '创建失败，请重试');
      session = await response.json();
      if (!session.id) throw Error('创建结果未确认，请重试');
      pending = null;
    } catch (error) {
      state.textContent = String(error.message || error); confirm.textContent = '重试';
    } finally { lock(false); }
    if (!session) return;
    dialog.close();
    // The creation has succeeded; a list refresh error must not offer another creation.
    try { await loadSessions(); } catch (error) { notice(error); }
    try { await select(session.id); } catch (error) { notice(error); }
  };
}
