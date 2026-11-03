"""Per-user supervisor; no secrets in command arguments or files."""
import os, socket, subprocess, sys, time
from pathlib import Path
import win32cred
ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ['LOCALAPPDATA']) / 'GA-Hub-Remote'
STATE.mkdir(exist_ok=True)
lock = socket.socket()
try:
    lock.bind(('127.0.0.1',47833))
except OSError:
    raise SystemExit('Remote access supervisor already running')

def main():
    env = os.environ.copy()
    env['TUNNEL_TOKEN'] = win32cred.CredRead('GA-Hub/remote-access/tunnel-token',1)['CredentialBlob'].decode('utf-16-le')
    env['PYTHONIOENCODING'] = 'utf-8'
    specs = {
        'gateway': [sys.executable,'-u',str(ROOT/'gateway.py')],
        'tunnel': [str(STATE/'cloudflared.exe'),'tunnel','--no-autoupdate','--protocol','http2','run'],
    }
    children = {}
    try:
        while True:
            for name, command in specs.items():
                if name not in children or children[name].poll() is not None:
                    path = STATE/(name+'.log')
                    if path.exists() and path.stat().st_size > 5_000_000:
                        path.replace(STATE/(name+'.previous.log'))
                    with path.open('ab') as log:
                        children[name] = subprocess.Popen(command, cwd=ROOT, env=env if name=='tunnel' else os.environ.copy(), stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            time.sleep(5)
    finally:
        for child in children.values():
            if child.poll() is None: child.terminate()
if __name__ == '__main__':
    main()
