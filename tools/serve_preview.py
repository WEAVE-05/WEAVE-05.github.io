#!/usr/bin/env python3
"""Local-only website preview, with MP4 ranges and private paths blocked."""
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        self.remaining = None
        parts = Path(unquote(urlsplit(self.path).path)).parts
        if any(p.startswith('.') or p == '_local' for p in parts if p != '/'):
            self.send_error(404)
            return None
        path = Path(self.translate_path(self.path)).resolve()
        if not path.is_relative_to(ROOT):
            self.send_error(404)
            return None
        if path.is_dir():
            path = path / 'index.html'
        if not path.is_file():
            self.send_error(404)
            return None
        f = path.open('rb')
        size = path.stat().st_size
        start, end, code = 0, size - 1, 200
        header = self.headers.get('Range')
        if header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
            if not match or not any(match.groups()):
                f.close(); self.send_error(416); return None
            a, b = match.groups()
            if a:
                start = int(a)
                end = min(int(b), size - 1) if b else size - 1
            else:
                start = max(0, size - int(b))
            if start > end or start >= size:
                f.close(); self.send_error(416); return None
            code = 206
        self.send_response(code)
        self.send_header('Content-Type', self.guess_type(str(path)))
        self.send_header('Content-Length', str(max(0, end - start + 1)))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store' if path.suffix in ('.html', '.json', '.css', '.js') else 'private, max-age=3600')
        if code == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        f.seek(start)
        self.remaining = max(0, end - start + 1)
        return f

    def copyfile(self, source, outputfile):
        try:
            while self.remaining:
                chunk = source.read(min(262144, self.remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                self.remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]) not in ('200', '206', '304'):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8766), Handler)
    print('WEAVE website preview: http://127.0.0.1:8766/', flush=True)
    server.serve_forever()
