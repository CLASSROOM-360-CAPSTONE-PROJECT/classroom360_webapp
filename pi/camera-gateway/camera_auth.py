#!/usr/bin/env python3
"""
Classroom360 camera gateway: who may watch a camera?

MediaMTX (the video relay on the parent Raspberry Pi) asks this small service about every request
before it sends any picture. The browser sends the signed-in person's Supabase access token as
"Authorization: Bearer <token>". This service asks Supabase whether that person can see the camera
named in the request:

    GET <SUPABASE_URL>/rest/v1/cameras?stream_path=eq.<name>&is_active=eq.true

sent WITH the person's own token. The database's row-level security answers: only an administrator
or a dean of the school can read a camera row, so only they get a row back. The rules therefore live
in one place (the database) and this service cannot be more generous than the database is.

Only the Python standard library is used, so there is nothing to install on the Pi.

Settings (environment variables, normally in /etc/classroom360/camera-gateway.env):
    SUPABASE_URL        https://<project>.supabase.co                 (required)
    SUPABASE_ANON_KEY   the publishable (anon) key, safe to keep here (required)
    AUTH_LISTEN         address to listen on, default 127.0.0.1:9120
    ALLOW_LOCAL_PUBLISH 1 (default) lets programs ON THE PI publish a stream (a Pi camera through
                        ffmpeg, for example); 0 refuses all publishing
    CACHE_SECONDS       how long a "yes" is remembered, default 60 (a "no" is remembered 5 seconds)
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# the same rule as the cameras.stream_path check in the database
STREAM_PATH = re.compile(r"[A-Za-z0-9_.~-]+(/[A-Za-z0-9_.~-]+)*")
MAX_BODY = 16 * 1024


def valid_stream_path(path: str) -> bool:
    if not isinstance(path, str) or not path or len(path) > 120 or not STREAM_PATH.fullmatch(path):
        return False
    return not any(part in (".", "..") for part in path.split("/"))


def is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


class Verdict:
    __slots__ = ("allowed", "reason")

    def __init__(self, allowed: bool, reason: str):
        self.allowed = allowed
        self.reason = reason


class Decider:
    """Turns one MediaMTX authentication request into yes or no."""

    def __init__(self, supabase_url: str, anon_key: str, allow_local_publish: bool = True,
                 cache_seconds: float = 60.0, timeout: float = 6.0, now=time.monotonic):
        self.base = supabase_url.rstrip("/")
        self.anon_key = anon_key
        self.allow_local_publish = allow_local_publish
        self.cache_seconds = cache_seconds
        self.timeout = timeout
        self._now = now
        self._cache: dict[str, tuple[float, Verdict]] = {}
        self._lock = threading.Lock()

    # -- the decision ------------------------------------------------------
    def decide(self, request: dict) -> Verdict:
        action = request.get("action")
        path = request.get("path") or ""
        ip = request.get("ip") or ""

        if action == "publish":
            if self.allow_local_publish and is_loopback(ip):
                return Verdict(True, "publish from this Pi")
            return Verdict(False, "publishing is only allowed from this Pi")
        if action != "read":
            return Verdict(False, f"{action or 'unknown'} is not allowed")
        if request.get("protocol") not in ("webrtc",):
            return Verdict(False, "only WebRTC playback is allowed")
        if not valid_stream_path(path):
            return Verdict(False, "bad stream name")

        token = request.get("token") or ""
        if not token:  # MediaMTX first asks without credentials; "no" makes the client send them
            return Verdict(False, "no access token")
        return self._cached(token, path)

    def _cached(self, token: str, path: str) -> Verdict:
        key = hashlib.sha256(f"{path}\0{token}".encode()).hexdigest()
        now = self._now()
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] > now:
                return hit[1]
        verdict = self._ask_supabase(token, path)
        if verdict.reason != "database unreachable":  # do not remember a hiccup
            ttl = self.cache_seconds if verdict.allowed else min(5.0, self.cache_seconds)
            with self._lock:
                if len(self._cache) > 500:
                    self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
                self._cache[key] = (now + ttl, verdict)
        return verdict

    def _ask_supabase(self, token: str, path: str) -> Verdict:
        url = f"{self.base}/rest/v1/cameras?select=id&is_active=eq.true&limit=1&stream_path=eq.{urllib.parse.quote(path, safe='')}"
        req = urllib.request.Request(url, headers={
            "apikey": self.anon_key,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                rows = json.loads(res.read(65536) or b"[]")
        except urllib.error.HTTPError as err:
            if err.code in (400, 401, 403):
                return Verdict(False, "Supabase refused the token")
            return Verdict(False, "database unreachable")
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return Verdict(False, "database unreachable")
        if isinstance(rows, list) and rows:
            return Verdict(True, "camera is visible to this person")
        return Verdict(False, "this person cannot watch that camera")


def make_handler(decider: Decider, log=print):
    class Handler(BaseHTTPRequestHandler):
        server_version = "c360-camera-auth"
        protocol_version = "HTTP/1.1"

        def _reply(self, code: int, body: bytes = b"") -> None:
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # health check
            if self.path == "/health":
                self._reply(200, b"ok")
            else:
                self._reply(404)

        def do_POST(self):
            if self.path != "/auth":
                return self._reply(404)
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length < 0 or length > MAX_BODY:
                    return self._reply(413)
                request = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(request, dict):
                    raise ValueError("not an object")
            except (ValueError, json.JSONDecodeError):
                return self._reply(400)
            verdict = decider.decide(request)
            if request.get("token") or (request.get("action") == "publish" and not verdict.allowed):
                # one line per decision that involved a person; never the token itself
                log(f"{'ALLOW' if verdict.allowed else 'DENY '} {request.get('action')} {request.get('path')} from {request.get('ip')}: {verdict.reason}")
            self._reply(200 if verdict.allowed else 401, verdict.reason.encode())

        def log_message(self, *args):  # quiet: decisions are logged above
            pass

    return Handler


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url.startswith("http") or not key:
        print("SUPABASE_URL and SUPABASE_ANON_KEY must be set (see /etc/classroom360/camera-gateway.env).", file=sys.stderr)
        return 2
    host, _, port = os.environ.get("AUTH_LISTEN", "127.0.0.1:9120").rpartition(":")
    decider = Decider(
        url, key,
        allow_local_publish=os.environ.get("ALLOW_LOCAL_PUBLISH", "1") != "0",
        cache_seconds=float(os.environ.get("CACHE_SECONDS", "60")),
    )
    server = ThreadingHTTPServer((host or "127.0.0.1", int(port)), make_handler(decider, log=lambda m: print(m, flush=True)))
    print(f"camera-auth listening on {host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
