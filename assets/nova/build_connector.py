"""Build source connector bundle without credentials or local configuration."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent

def build(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ('connector.py', 'setup.cmd', 'pair.cmd', 'run.cmd', 'CONNECTOR.md'):
            z.write(ROOT / name, 'nova/' + name)
        for name in ('gateway.py', 'artifacts.py', 'remote_progress.py', 'compact-worker.cjs'):
            z.write(ROOT.parent / 'remote_access' / name, 'remote_access/' + name)
    return output

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(); p.add_argument('output')
    print(build(p.parse_args().output))
