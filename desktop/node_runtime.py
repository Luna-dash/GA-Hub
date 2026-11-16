"""Stage the build machine's Node runtime, with version/target and license checks."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request


def stage_node(staging: Path, target: str) -> Path:
    executable = shutil.which('node')
    if not executable:
        raise RuntimeError('Node 20+ is required to build the self-contained sidecar')
    result = subprocess.run(
        [executable, '-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],
        capture_output=True, text=True, encoding='utf-8', check=True, timeout=15,
    )
    info = json.loads(result.stdout)
    platform = 'win32' if 'windows' in target else 'darwin' if 'apple' in target else 'linux'
    arch = 'x64' if target.startswith('x86_64-') else 'arm64' if target.startswith('aarch64-') else None
    if not arch or (info['platform'], info['arch']) != (platform, arch):
        raise RuntimeError(f'Node runtime {info} does not match target {target}; cross compilation is not supported')
    if int(info['version'].lstrip('v').split('.')[0]) < 20:
        raise RuntimeError('Packaged Node runtime must be Node 20+')
    # Node's LICENSE includes third-party notices. Never redistribute just the EXE.
    local_license = os.environ.get('GA_HUB_NODE_LICENSE')
    if local_license:
        license_bytes = Path(local_license).read_bytes()
    else:
        url = f"https://raw.githubusercontent.com/nodejs/node/{info['version']}/LICENSE"
        with urllib.request.urlopen(url, timeout=30) as response:
            license_bytes = response.read()
    if b'Node.js' not in license_bytes or b'Permission' not in license_bytes:
        raise RuntimeError('Missing or invalid Node LICENSE; set GA_HUB_NODE_LICENSE to the matching official LICENSE')
    staging.mkdir(parents=True, exist_ok=True)
    destination = staging / ('node.exe' if platform == 'win32' else 'node')
    shutil.copy2(executable, destination)
    (staging / 'LICENSE').write_bytes(license_bytes)
    info['sha256'] = hashlib.sha256(destination.read_bytes()).hexdigest()
    (staging / 'runtime.json').write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
    return staging
