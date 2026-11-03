// One selected-session connection; reconnect with a fresh authoritative snapshot.
export class LiveProgress {
  constructor({onData, onState, onReconnect}) {
    Object.assign(this, {onData, onState, onReconnect});
    this.epoch = 0; this.retry = 0; this.sid = '';
  }
  close() {
    this.epoch++; clearTimeout(this.timer); clearTimeout(this.watchdog); clearInterval(this.pinger);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
    this.socket = null; this.connected = false;
  }
  open(sid) {
    this.close(); this.sid = sid;
    if (!sid || document.hidden) return;
    const epoch = this.epoch;
    this.onState('连接中');
    const url = new URL('/api/sessions/' + encodeURIComponent(sid) + '/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    const current = () => epoch === this.epoch;
    const arm = () => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => { if (current()) socket.close(); }, 45000);
    };
    arm();
    socket.onopen = () => {
      if (!current()) return;
      this.pinger = setInterval(() => {
        if (current() && socket.readyState === 1) socket.send(JSON.stringify({type:'ping'}));
      }, 15000);
    };
    socket.onmessage = event => {
      if (!current()) return;
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => socket.close(), 45000);
      try {
        const data = JSON.parse(event.data);
        if (!data.runtime || !Array.isArray(data.items)) return;
        const first = !this.connected;
        this.connected = true; this.retry = 0; arm();
        this.onState('实时同步'); this.onData(data, sid);
        if (first) this.onReconnect(sid);
      } catch { socket.close(); }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (!current()) return;
      this.connected = false; clearTimeout(this.watchdog); clearInterval(this.pinger);
      this.onState('连接中断，正在重连');
      const delay = Math.min(15000, 1000 * 2 ** Math.min(this.retry++, 4));
      this.timer = setTimeout(() => { if (current()) this.open(sid); }, delay);
    };
  }
}
