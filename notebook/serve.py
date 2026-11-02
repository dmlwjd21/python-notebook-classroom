"""로컬 테스트용 서버: python serve.py 실행 후 http://localhost:8000 접속"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".ipynb": "application/json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # vercel.json과 같게: /teacher → teacher.html, 예전 주소(/review.html)는 /teacher로 이동
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/review.html", "/review"):
            self.send_response(308)
            self.send_header("Location", "/teacher" + (f"?{query}" if query else ""))
            self.end_headers()
            return
        if path == "/teacher":
            self.path = "/teacher.html" + (f"?{query}" if query else "")
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"http://localhost:{PORT} 에서 실행 중 (종료: Ctrl+C)")
        httpd.serve_forever()
