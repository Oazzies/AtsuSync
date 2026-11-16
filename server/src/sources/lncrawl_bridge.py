"""Lightweight local HTTP bridge exposing lightnovel-crawler (lncrawl) sources to AtsuSync."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import traceback
from typing import Any

from lncrawl.context import ctx
from lncrawl.core.models import Chapter


def _load_sources() -> None:
    try:
        ctx.sources.load(sync_remote=True)
    except Exception:
        ctx.sources.load(sync_remote=False)
    ctx.sources.ensure_load()


def _init_crawler(url: str):
    crawler = ctx.sources.init_crawler(url)
    crawler.novel_url = url
    return crawler


def _close_quietly(crawler: Any) -> None:
    close = getattr(crawler, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    return json.loads(raw.decode("utf-8"))


class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        try:
            if self.path == "/health":
                _json_response(self, 200, {"ok": True})
                return

            if self.path == "/sources":
                ctx.sources.ensure_load()
                items = ctx.sources.list(include_rejected=False, has_manga=False)
                out = []
                for item in items:
                    info = ctx.sources.info.get(item.crawler_id)
                    lang = (getattr(info, "language", None) or getattr(item, "language", None) or "").strip()
                    out.append(
                        {
                            "domain": item.domain,
                            "url": item.url,
                            "language": lang,
                            "canSearch": bool(item.can_search),
                            "hasMtl": bool(item.has_mtl),
                            "hasManga": bool(item.has_manga),
                        }
                    )
                _json_response(self, 200, {"sources": out})
                return

            _json_response(self, 404, {"error": "Not found"})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _json_response(self, 500, {"error": str(exc)})

    def do_POST(self) -> None:
        try:
            body = _read_json(self)

            if self.path == "/search":
                base_url = str(body.get("url") or "").strip()
                query = str(body.get("query") or "").strip()
                if not base_url or not query:
                    _json_response(self, 400, {"error": "Missing url or query"})
                    return
                crawler = _init_crawler(base_url)
                try:
                    results = crawler.search_novel(query) or []
                    hits = [
                        {
                            "title": str(getattr(r, "title", "") or "").strip(),
                            "url": str(getattr(r, "url", "") or "").strip(),
                            "info": str(getattr(r, "info", "") or "").strip() or None,
                        }
                        for r in results
                        if getattr(r, "title", None) and getattr(r, "url", None)
                    ]
                    _json_response(self, 200, {"hits": hits})
                finally:
                    _close_quietly(crawler)
                return

            if self.path == "/series":
                url = str(body.get("url") or "").strip()
                if not url:
                    _json_response(self, 400, {"error": "Missing url"})
                    return
                crawler = _init_crawler(url)
                try:
                    crawler.read_novel_info()
                    chapters = []
                    for ch in getattr(crawler, "chapters", []) or []:
                        ch_url = str(getattr(ch, "url", "") or "").strip()
                        if not ch_url:
                            continue
                        chapters.append(
                            {
                                "id": getattr(ch, "id", None),
                                "title": str(getattr(ch, "title", "") or "").strip(),
                                "url": ch_url,
                                "volume": getattr(ch, "volume", None),
                            }
                        )
                    _json_response(
                        self,
                        200,
                        {
                            "title": str(getattr(crawler, "novel_title", "") or "").strip(),
                            "url": str(getattr(crawler, "novel_url", "") or url).strip(),
                            "cover": str(getattr(crawler, "novel_cover", "") or "").strip() or None,
                            "author": str(getattr(crawler, "novel_author", "") or "").strip() or None,
                            "synopsis": str(getattr(crawler, "novel_synopsis", "") or "").strip() or None,
                            "chapters": chapters,
                        },
                    )
                finally:
                    _close_quietly(crawler)
                return

            if self.path == "/chapter":
                novel_url = str(body.get("novelUrl") or "").strip()
                chapter_url = str(body.get("chapterUrl") or "").strip()
                chapter_id = body.get("chapterId")
                if not chapter_url:
                    _json_response(self, 400, {"error": "Missing chapterUrl"})
                    return
                crawler = _init_crawler(novel_url or chapter_url)
                try:
                    ch_kwargs: dict[str, Any] = {"url": chapter_url}
                    if chapter_id is not None:
                        ch_kwargs["id"] = chapter_id
                    chapter = Chapter(**ch_kwargs)
                    html = crawler.download_chapter_body(chapter) or ""
                    _json_response(
                        self,
                        200,
                        {
                            "title": str(getattr(chapter, "title", "") or "").strip() or None,
                            "html": str(html),
                        },
                    )
                finally:
                    _close_quietly(crawler)
                return

            _json_response(self, 404, {"error": "Not found"})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _json_response(self, 500, {"error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4568)
    args = parser.parse_args()

    _load_sources()
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
