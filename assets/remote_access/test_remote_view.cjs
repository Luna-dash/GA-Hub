// Run: node assets/remote_access/test_remote_view.cjs
const path = require('node:path');
const assert = require('node:assert/strict');
const modules = path.resolve(__dirname, '../../webui/node_modules');
const { JSDOM } = require(path.join(modules, 'jsdom'));
const dom = new JSDOM('', { url: 'https://remote.test/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
const source = require(path.join(modules, 'esbuild')).buildSync({
  entryPoints: [path.join(__dirname, 'remote-view.js')], bundle: true,
  platform: 'node', format: 'cjs', write: false, nodePaths: [modules],
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', source)(loaded, loaded.exports, require);
const { messageCard, sessionTitle, renderRail } = loaded.exports;
let count = 0;
const test = (label, fn) => { fn(); count++; console.log('PASS', label); };
const compact = (n, ordinal = 1) => ({
  role: 'assistant', ordinal, compact: true, content: '',
  progress: { turn_count: n, final_body: '最终回复', turns: Array.from({length:n}, (_,i) => ({turn:i+1, summary:`摘要 ${i+1}`, content:`正文 ${i+1}`})) },
});
const recent = card => [...card.querySelector('.process-content').children].filter(n => n.matches('.turn'));
const numbers = rows => rows.map(n => n.querySelector('.turn-number').textContent);

test('0/1/5 turns do not show a history button', () => {
  for (const n of [0,1,5]) {
    const card = messageCard(compact(n), 'short'+n, true);
    assert.equal(card.querySelector('.turn-history-toggle'), null);
    assert.equal(card.querySelectorAll('.turn').length, n);
  }
});
test('12 turns default to only latest 5, numbers without Turn prefix', () => {
  const card = messageCard(compact(12), 'latest', true);
  assert.deepEqual(numbers(recent(card)), ['8','9','10','11','12']);
  assert.equal(card.querySelectorAll('.turn').length, 5);
  assert.equal(card.querySelector('.turn-history-toggle').getAttribute('aria-label'), '展开更早的 7 条');
  assert.equal(card.querySelector('.turn-history-toggle').getAttribute('aria-expanded'), 'false');
  assert.ok(card.textContent.includes('最终回复'));
});
test('expand older summaries in order; collapse keeps latest 5', () => {
  const card = messageCard(compact(12), 'toggle', true);
  const b = card.querySelector('.turn-history-toggle'); b.click();
  const older = card.querySelector('.turn-history-content');
  assert.equal(older.hidden, false);
  assert.deepEqual(numbers([...older.children]), ['1','2','3','4','5','6','7']);
  assert.equal(b.getAttribute('aria-label'), '收起更早的 7 条');
  b.click(); assert.equal(older.hidden, true);
  assert.deepEqual(numbers(recent(card)), ['8','9','10','11','12']);
});
test('polling preserves expanded choice and updates latest window', () => {
  let card = messageCard(compact(12), 'poll', true);
  card.querySelector('.turn-history-toggle').click();
  card = messageCard(compact(13), 'poll', true);
  assert.equal(card.querySelector('.turn-history-content').hidden, false);
  assert.deepEqual(numbers(recent(card)), ['9','10','11','12','13']);
  assert.equal(card.querySelector('.turn-history-content').children.length, 8);
  card.querySelector('.turn-history-toggle').click();
  card = messageCard(compact(14), 'poll', false);
  assert.equal(card.querySelector('.turn-history-content').hidden, true);
  assert.equal(card.querySelectorAll('.turn').length, 5);
});
test('history choices are isolated by reply and session', () => {
  const card = messageCard(compact(12), 'isolation', true);
  card.querySelector('.turn-history-toggle').click();
  for (const [sid, ordinal] of [['other',1], ['isolation',2]]) {
    const other = messageCard(compact(12,ordinal), sid, true);
    assert.equal(other.querySelector('.turn-history-toggle').getAttribute('aria-expanded'), 'false');
  }
});
test('full transcript path also limits and expands summaries', () => {
  const content = Array.from({length:12}, (_,i) => `**LLM Running (Turn ${i+1}) ...**\n<summary>摘要 ${i+1}</summary>\n🛠️ code_run({})\n`).join('');
  const card = messageCard({role:'assistant',ordinal:1,content}, 'full', true);
  assert.deepEqual(numbers(recent(card)), ['8','9','10','11','12']);
  card.querySelector('.turn-history-toggle').click();
  assert.equal(card.querySelectorAll('.turn').length, 12);
  assert.deepEqual(numbers([...card.querySelector('.turn-history-content').children]), ['1','2','3','4','5','6','7']);
});
test('history action is an icon in the first line, not a separate row', () => {
  const card = messageCard(compact(12), 'icon', true);
  const button = card.querySelector('.turn-history-toggle');
  assert.equal(button.parentElement, card.querySelector('.process>summary'));
  assert.ok(button.querySelector('svg'));
  assert.equal(button.querySelector('svg path').getAttribute('d'), 'M6 9l6 6 6-6');
  assert.equal(button.textContent, '');
  assert.equal(card.querySelector('.process-content .turn-history-toggle'), null);
});
test('final reply has no redundant reply label', () => {
  for (const streaming of [false, true]) {
    const card = messageCard(compact(12), 'no-label', streaming);
    assert.equal(card.querySelector('.reply-label'), null);
    assert.ok(card.textContent.includes('最终回复'));
  }
});
test('artifact cards show safe filenames, sizes and session-bound downloads', () => {
  const message = compact(1);
  const url = '/api/sessions/files/artifacts/' + 'a'.repeat(43);
  message.artifacts = [{name:'报告 <img>.txt',size:2048,extension:'.txt',url}];
  const card = messageCard(message, 'files', false);
  assert.equal(card.querySelector('.artifact-name').textContent, '报告 <img>.txt');
  assert.equal(card.querySelector('.artifact-name img'), null);
  assert.equal(card.querySelector('.artifact-meta').textContent, 'TXT · 2.0 KiB');
  assert.equal(card.querySelector('.artifact-download').getAttribute('href'), url);
  assert.equal(card.querySelector('.artifact-download').download, '报告 <img>.txt');
});
test('artifact cards reject external, malformed and cross-session URLs', () => {
  const message = compact(1);
  message.artifacts = ['https://evil.test/', 'javascript:alert(1)', '/api/sessions/other/artifacts/'+'a'.repeat(43), '/api/sessions/files/artifacts/short'].map(url => ({name:'bad',size:1,url}));
  const card = messageCard(message, 'files', false);
  assert.equal(card.querySelector('.artifact-list'), null);
});
test('artifact cards are capped at eight and absent from plain user messages', () => {
  const message = compact(1);
  message.artifacts = Array.from({length:10}, (_,i) => ({name:`file${i}.txt`,size:0,extension:'.txt',url:'/api/sessions/files/artifacts/'+'a'.repeat(43)}));
  assert.equal(messageCard(message, 'files', false).querySelectorAll('.artifact-card').length, 8);
  assert.equal(messageCard({role:'user',ordinal:2,content:'hi',artifacts:message.artifacts}, 'files', false).querySelector('.artifact-card'), null);
});
test('unnamed session titles never fall back to their IDs', () => {
  for (const title of [undefined, null, '', '   ']) {
    assert.equal(sessionTitle({id:'802b34070f6c4a43b7e55b92a8d00461',title}), '未命名会话');
  }
  assert.equal(sessionTitle(undefined), '未命名会话');
  assert.equal(sessionTitle({title:'工作讨论'}), '工作讨论');
});
test('rail uses unnamed label in display, tooltip, accessibility and search', () => {
  document.body.innerHTML = '<input id="search"><span id="sessionCount"></span><div id="sessions"></div>';
  const sessions = [{id:'802b34070f6c4a43b7e55b92a8d00461',title:'',status:'idle'}];
  let chosen;
  const draw = () => renderRail(sessions, '', id => { chosen = id; }, draw);
  draw();
  assert.equal(document.querySelector('.session .label').textContent, '未命名会话');
  assert.equal(document.querySelector('.session').title, '未命名会话');
  assert.equal(document.querySelector('.star-button').getAttribute('aria-label'), '收藏 未命名会话');
  document.querySelector('.session').click();
  assert.equal(chosen, sessions[0].id);
  document.getElementById('search').value = '未命名会话'; draw();
  assert.equal(document.querySelectorAll('.session').length, 1);
});
console.log(`${count} tests passed`);
dom.window.close();
