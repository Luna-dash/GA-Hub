"""Project-scoped citation resolution. No recursive search of shared GA temp."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .. import _paths

PRUNE = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea',
         '.vscode', 'binaries', 'target', 'dist', 'build', '.cache', 'archives'}
MAX_DEPTH = 4
MAX_DIRS = 200
MAX_ENTRIES = 5000
MAX_RESULTS = 20
SECONDS = .15


def normalize(raw: str) -> str:
    value = (raw or '').strip().strip('"').replace('\\', '/')
    # Strip citation metadata before URI decoding: encoded colons are filename data.
    value = re.sub(r'(?<=\S):\d+(?::\d+)?$', '', value)
    if value.lower().startswith('file:'):
        try:
            url = urlsplit(value)
        except ValueError:
            return ''
        value = ('//' + url.netloc if url.netloc and url.netloc.lower() != 'localhost' else '') + unquote(url.path)
    # Raw filesystem paths are not URLs. Decoding can silently select a different
    # file when both "a%20b.txt" and "a b.txt" exist.
    if re.match(r'^/[a-zA-Z]:/', value):
        value = value[1:]
    while value.startswith('./'):
        value = value[2:]
    return value.strip()


def _key(path: Path) -> str:
    return os.path.normcase(str(path))


def resolve(raw: str, project_path: str | None = None, project_name: str | None = None) -> dict:
    started = time.monotonic()
    info = dict(raw=raw, resolved=None, exists=False, is_dir=False, ambiguous=False,
                candidates=[], incomplete=False, scope=project_path or '未绑定项目（仅精确路径与 temp 根层）')
    value = normalize(raw)
    if not value or '\x00' in value:
        return info
    path = Path(value).expanduser()
    ga = Path(_paths.GA_ROOT) if _paths.GA_ROOT else None
    temp = _paths.ga_layout_path('temp', root=ga) if ga else None
    project = Path(project_path) if project_path else None
    artifacts = (temp / 'project_artifacts' / project_name
                 if temp and project_name and Path(project_name).name == project_name else None)

    def finish(hits: list[Path], incomplete: bool = False) -> dict:
        info['candidates'] = [str(p) for p in hits]
        info['ambiguous'] = len(hits) > 1
        info['incomplete'] = incomplete
        if len(hits) == 1 and not incomplete:
            info.update(resolved=str(hits[0]), exists=True, is_dir=hits[0].is_dir())
        return info

    # Absolute references never silently degrade to basename searches.
    if path.is_absolute() or re.match(r'^[a-zA-Z]:/', value):
        return finish([path.resolve()] if path.exists() else [])

    explicit = False
    candidates: list[Path] = []
    parts = path.parts
    if ga and parts and parts[0] in {'temp', 'memory', 'project_artifacts', 'projects'}:
        explicit = True
        candidates = [(temp / Path(*parts[1:])) if parts[0] == 'temp' else
                      (temp / path) if parts[0] in {'project_artifacts', 'projects'} else ga / path]
    else:
        candidates = [root / path for root in (project, artifacts, temp) if root]
        # Keep legacy exact GA/L4/admin references, never recursively scan them.
        if ga:
            candidates += [ga / path, _paths.ga_l4_sessions_dir(root=ga) / path]
        candidates.append(_paths.ADMIN_ROOT / path)
    hits: dict[str, Path] = {}
    for candidate in candidates:
        if candidate.exists():
            target = candidate.resolve()
            hits[_key(target)] = target
    if hits or explicit or '..' in parts:
        return finish(list(hits.values()))

    # Shared temp: direct children only. Project roots: bounded DFS, without
    # following descendant symlinks/junctions or escaping the canonical root.
    roots = [r for r in (project, artifacts) if r and r.is_dir()]
    if not roots:
        return info
    tail = os.path.normcase(value).replace('\\', '/')
    dirs = entries = 0
    incomplete = False
    visited: set[str] = set()
    stack = [(r.resolve(), 0) for r in roots]
    while stack:
        if dirs >= MAX_DIRS or entries >= MAX_ENTRIES or time.monotonic() - started >= SECONDS:
            incomplete = True
            break
        directory, depth = stack.pop()
        canonical = directory.resolve()
        if _key(canonical) in visited:
            continue
        visited.add(_key(canonical))
        dirs += 1
        try:
            with os.scandir(directory) as children:
                for child in children:
                    entries += 1
                    if entries > MAX_ENTRIES or time.monotonic() - started >= SECONDS:
                        incomplete = True
                        break
                    item = Path(child.path)
                    if child.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
                        continue
                    # Python <3.12 on Windows: junction/reparse directories.
                    if getattr(child.stat(follow_symlinks=False), 'st_file_attributes', 0) & 0x400:
                        continue
                    name = os.path.normcase(item.as_posix()).replace('\\', '/')
                    if name == tail or name.endswith('/' + tail):
                        target = item.resolve()
                        hits[_key(target)] = target
                        if len(hits) >= MAX_RESULTS:
                            incomplete = True
                            break
                    if child.is_dir(follow_symlinks=False) and child.name.lower() not in PRUNE:
                        if depth < MAX_DEPTH:
                            stack.append((item, depth + 1))
                        # Depth defines the supported search domain; budget
                        # exhaustion within that domain is reported separately.
        except OSError:
            incomplete = True
        if incomplete:
            break
    return finish(list(hits.values()), incomplete)
