"""Read-only remote deliverables. No path-addressable public file endpoint."""
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import time
from urllib.parse import quote

from aiohttp import web

HUB = Path(__file__).resolve().parents[2]
DEFAULT_ROOTS = (HUB / 'temp', HUB.parent / 'GA' / 'temp')
REFERENCE = re.compile(r'\[FILE:([^\]\r\n]{1,2048})\]', re.I)
SENSITIVE = re.compile(r'(?:^|[._\-\s])(?:secrets?|credentials?|passwords?|passwd|tokens?|cookies?|keychain|private|session[-_]state|storage[-_]state)(?:$|[._\-\s])', re.I)
FORBIDDEN_EXT = {'.pem', '.key', '.pfx', '.p12', '.kdbx', '.db', '.sqlite', '.sqlite3', '.log', '.har'}
TTL = 1800
LIMIT = 1024
MAX_FILE = 256 * 1024 * 1024


class ArtifactStore:
    def __init__(self, roots=DEFAULT_ROOTS):
        self.roots = tuple(Path(root).resolve() for root in roots)
        self.entries = {}
        self.index = {}

    def _safe(self, path):
        """Resolve locally, reject escapes and sensitive names, never read content."""
        try:
            original = Path(path).absolute()
            root = next((root for root in self.roots if original.is_relative_to(root)), None)
            if root is None or not root.is_dir():
                return None
            path = original.resolve(strict=True)
            if not path.is_relative_to(root):
                return None
            parts = path.relative_to(root).parts
            if any(part.startswith('.') or SENSITIVE.search(part) or part.lower() in {'memory', 'config', 'configuration', 'credentials', 'id_rsa', 'id_ed25519'} for part in parts):
                return None
            if path.suffix.lower() in FORBIDDEN_EXT:
                return None
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
                return None
            return path, info
        except (OSError, ValueError, RuntimeError):
            return None

    def resolve(self, raw):
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 2048:
            return None
        raw = raw.strip().replace('\\', '/')
        if raw.startswith(('//', '\\')) or any(ord(char) < 32 for char in raw):
            return None
        # Disallow traversal, drive-relative paths, ADS, environment expansion.
        if '..' in raw.split('/') or ':' in raw[2:] or (':' in raw and not re.match(r'^[A-Za-z]:/', raw)):
            return None
        candidate = Path(raw)
        if candidate.is_absolute():
            return self._safe(candidate)
        if raw.startswith('/'):
            return None
        matches = []
        for root in self.roots:
            # Relative citations must begin with temp/, not an arbitrary filename.
            if not raw.startswith(root.name + '/'):
                continue
            result = self._safe(root.parent / candidate)
            if result and result[0] not in [item[0] for item in matches]:
                matches.append(result)
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    def _prune(self):
        now = time.monotonic()
        for token, entry in list(self.entries.items()):
            if now - entry['created'] >= TTL:
                self.entries.pop(token, None)
                self.index.pop(entry['key'], None)
        while len(self.entries) >= LIMIT:
            token = next(iter(self.entries))
            entry = self.entries.pop(token)
            self.index.pop(entry['key'], None)

    def decorate(self, data, sid, owner):
        """Only compact, assistant-visible prose may publish a file capability."""
        self._prune()
        for message in data.get('items', []):
            message.pop('artifacts', None)  # Never trust upstream-supplied URLs.
            if message.get('role') != 'assistant' or not message.get('compact'):
                continue
            progress = message.get('progress') or {}
            prose = progress.get('final_body') or ''
            found = []
            for raw in dict.fromkeys(REFERENCE.findall(prose)):
                if len(found) >= 8:
                    break
                result = self.resolve(raw)
                if not result:
                    continue
                path, info = result
                key = (owner, sid, str(path), self.identity(info))
                token = self.index.get(key)
                if token not in self.entries:
                    self._prune()
                    token = secrets.token_urlsafe(32)
                    self.entries[token] = {'created': time.monotonic(), 'key': key, 'path': path, 'identity': self.identity(info)}
                    self.index[key] = token
                found.append({'name': path.name, 'size': info.st_size, 'extension': path.suffix.lower(),
                              'url': '/api/sessions/' + sid + '/artifacts/' + token,
                              'expires_in': max(0, int(TTL - (time.monotonic() - self.entries[token]['created'])))})
            if found:
                message['artifacts'] = found
        return data

    async def download(self, request, sid, token, owner):
        entry = self.entries.get(token)
        if not entry or entry['key'][:2] != (owner, sid) or time.monotonic() - entry['created'] >= TTL:
            raise web.HTTPNotFound(text='File link expired or unavailable; refresh the conversation.')
        result = self._safe(entry['path'])
        if not result or self.identity(result[1]) != entry['identity']:
            raise web.HTTPGone(text='File changed or was removed; refresh the conversation.')
        fd = None
        try:
            fd = os.open(entry['path'], os.O_RDONLY | getattr(os, 'O_BINARY', 0))
            info = os.fstat(fd)
            if self.identity(info) != entry['identity'] or info.st_nlink != 1:
                raise web.HTTPGone(text='File changed; refresh the conversation.')
            if os.name == 'nt':
                import msvcrt
                import win32file
                actual = win32file.GetFinalPathNameByHandle(msvcrt.get_osfhandle(fd), 0)
                if actual.startswith('\\\\?\\'):
                    actual = actual[4:]
                checked = self._safe(actual)
                if not checked or checked[0] != entry['path']:
                    raise web.HTTPGone(text='File location changed; refresh the conversation.')
            name = quote(entry['path'].name, safe='')
            response = web.StreamResponse(headers={'Content-Type': 'application/octet-stream',
                'Content-Disposition': "attachment; filename=\"download\"; filename*=UTF-8''" + name,
                'Content-Length': str(info.st_size), 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
                'Referrer-Policy': 'no-referrer'})
            await response.prepare(request)
            if request.method != 'HEAD':
                remaining = info.st_size
                while remaining:
                    chunk = await __import__('asyncio').to_thread(os.read, fd, min(65536, remaining))
                    if not chunk:
                        break
                    await response.write(chunk)
                    remaining -= len(chunk)
            await response.write_eof()
            return response
        except (FileNotFoundError, PermissionError):
            raise web.HTTPGone(text='File is no longer available.')
        finally:
            if fd is not None:
                os.close(fd)
