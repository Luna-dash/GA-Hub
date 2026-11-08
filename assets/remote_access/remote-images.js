// Page-memory image cache only. No storage API or cloud cache.
const cache = new Map(), active = new Set(), observed = new Set();
let bytes = 0, epoch = 0, running = 0, scope = '', queue = [], dialog;
const MAX_BYTES = 32 * 1024 * 1024;
export function clearImagePreviews() {
  epoch++;
  observer?.disconnect(); observed.clear();
  for (const controller of active) controller.abort();
  active.clear();
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear(); bytes = 0;
  for (const job of queue) job.reject(Error('图片加载已取消'));
  queue = [];
  if (dialog) { dialog.close(); dialog.remove(); dialog = null; }
}
export function setImageScope(value) {
  if (scope !== value) { clearImagePreviews(); scope = value; }
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift(); running++;
    job.run().then(job.resolve, job.reject).finally(() => { running--; pump(); });
  }
}
function imageURL(path) {
  if (cache.has(path)) {
    const entry = cache.get(path); cache.delete(path); cache.set(path, entry);
    return entry.promise;
  }
  const generation = epoch, entry = {};
  entry.promise = new Promise((resolve, reject) => {
    queue.push({resolve, reject, run: async () => {
      if (generation !== epoch) throw Error('图片加载已取消');
      const controller = new AbortController(); active.add(controller);
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await fetch(path, {credentials:'same-origin', cache:'no-store', signal:controller.signal});
        if (response.status === 401) { clearImagePreviews(); throw Error('登录已过期，请重新登录'); }
        if (!response.ok) throw Error(response.status === 404 || response.status === 410 ? '图片链接已过期，请刷新会话' : `图片加载失败 (${response.status})，可重试或下载查看`);
        if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(response.headers.get('Content-Type') || '')) throw Error('图片格式不支持，请下载查看');
        const blob = await response.blob();
        if (blob.size > 20 * 1024 * 1024) throw Error('图片过大，请下载查看');
        if (generation !== epoch) throw Error('图片加载已取消');
        entry.url = URL.createObjectURL(blob); entry.size = blob.size; bytes += blob.size;
        for (const [key, old] of cache) {
          if (bytes <= MAX_BYTES && cache.size <= 32) break;
          if (key !== path && old.url) { URL.revokeObjectURL(old.url); bytes -= old.size; cache.delete(key); }
        }
        return entry.url;
      } finally { clearTimeout(timer); active.delete(controller); }
    }});
  }).catch(error => { if (cache.get(path) === entry) cache.delete(path); throw error; });
  cache.set(path, entry); pump(); return entry.promise;
}
async function openOriginal(file, opener) {
  const generation = epoch;
  if (dialog) { dialog.close(); dialog.remove(); }
  const current = document.createElement('dialog'); dialog = current;
  current.className = 'image-dialog'; current.setAttribute('aria-label', file.name);
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  const status = document.createElement('p'); status.textContent = '正在加载原图…';
  const image = document.createElement('img'); image.alt = file.name;
  const download = document.createElement('a'); download.href = file.url; download.download = file.name; download.textContent = '下载原图';
  close.onclick = () => current.close();
  current.addEventListener('close', () => { current.remove(); if (dialog === current) dialog = null; opener?.focus(); });
  current.addEventListener('click', event => { if (event.target === current) current.close(); });
  current.append(close, download, status, image); document.body.append(current); current.showModal();
  try {
    const url = await imageURL(file.url + '/preview');
    if (generation !== epoch || dialog !== current || !current.isConnected) return;
    if (current.isConnected) { image.src = url; status.textContent = file.name; }
  } catch (error) { if (current.isConnected) status.textContent = error.message; }
}
const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); observed.delete(entry.target); entry.target.loadPreview?.(); }
}, {rootMargin:'100px'}) : null;
export function imagePreview(file) {
  const box = document.createElement('div'); box.className = 'artifact-preview';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'artifact-thumbnail';
  button.textContent = '显示图片预览'; button.setAttribute('aria-label', `预览 ${file.name}`);
  let loading = false, loaded = false;
  button.loadPreview = async () => {
    if (loading || loaded) return;
    loading = true; button.textContent = '正在加载缩略图…';
    try {
      const url = await imageURL(file.url + '/thumbnail');
      if (!button.isConnected) return;
      const image = document.createElement('img'); image.src = url; image.alt = file.name;
      image.width = 256; image.height = 160;
      button.replaceChildren(image); button.title = '点击查看原图'; loaded = true;
    } catch (error) { if (button.isConnected) button.textContent = error.message + ' · 点击重试'; }
    finally { loading = false; }
  };
  button.onclick = () => loaded ? openOriginal(file, button) : button.loadPreview();
  box.append(button);
  // Observe after the card has been attached by the renderer.
  queueMicrotask(() => {
    for (const old of observed) if (!old.isConnected) { observer?.unobserve(old); observed.delete(old); }
    if (button.isConnected && observer) { observer.observe(button); observed.add(button); }
  });
  return box;
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearImagePreviews);
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}
