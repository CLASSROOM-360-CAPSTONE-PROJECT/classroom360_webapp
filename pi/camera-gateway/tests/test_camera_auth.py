import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import camera_auth  # noqa: E402


class FakeSupabase:
    """Answers like PostgREST with row-level security: a person sees only the cameras they may see."""

    def __init__(self):
        # token -> set of stream paths that person may see
        self.people = {"good-dean": {"lrc-301", "lrc-302"}, "good-admin": {"lrc-301", "lrc-302"}, "teacher": set()}
        self.calls = []
        self.mode = "normal"  # or "down" or "error500"
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                url = urlparse(self.path)
                auth = self.headers.get("Authorization", "")
                outer.calls.append({"path": url.path, "query": parse_qs(url.query), "auth": auth, "apikey": self.headers.get("apikey")})
                if outer.mode == "error500":
                    return self._send(500, b"{}")
                token = auth.removeprefix("Bearer ")
                if token not in outer.people:
                    return self._send(401, b'{"message":"JWT expired"}')
                want = parse_qs(url.query).get("stream_path", [""])[0].removeprefix("eq.")
                rows = [{"id": "c1"}] if want in outer.people[token] else []
                self._send(200, json.dumps(rows).encode())

            def _send(self, code, body):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def read(path="lrc-301", token="good-dean", ip="192.168.1.20", protocol="webrtc"):
    return {"ip": ip, "user": "", "password": "", "token": token, "action": "read", "path": path, "protocol": protocol, "id": "x", "query": ""}


class DeciderTests(unittest.TestCase):
    def setUp(self):
        self.sb = FakeSupabase()
        self.addCleanup(self.sb.close)
        self.clock = Clock()
        self.d = camera_auth.Decider(self.sb.url, "anon-key", cache_seconds=60, timeout=2, now=self.clock)

    def test_a_dean_can_watch_a_registered_camera(self):
        self.assertTrue(self.d.decide(read()).allowed)

    def test_the_database_is_asked_with_the_persons_own_token(self):
        self.d.decide(read(token="good-admin"))
        (call,) = self.sb.calls
        self.assertEqual(call["path"], "/rest/v1/cameras")
        self.assertEqual(call["auth"], "Bearer good-admin")
        self.assertEqual(call["apikey"], "anon-key")
        self.assertEqual(call["query"]["stream_path"], ["eq.lrc-301"])
        self.assertEqual(call["query"]["is_active"], ["eq.true"])

    def test_a_person_the_database_hides_cameras_from_is_refused(self):
        v = self.d.decide(read(token="teacher"))
        self.assertFalse(v.allowed)

    def test_an_unregistered_stream_is_refused(self):
        self.assertFalse(self.d.decide(read(path="lrc-999")).allowed)

    def test_an_invalid_or_expired_token_is_refused(self):
        v = self.d.decide(read(token="expired"))
        self.assertFalse(v.allowed)
        self.assertIn("refused", v.reason)

    def test_no_token_is_refused_without_asking_the_database(self):
        self.assertFalse(self.d.decide(read(token="")).allowed)
        self.assertEqual(self.sb.calls, [])

    def test_odd_stream_names_never_reach_the_database(self):
        for bad in ["../admin", "a/../b", "a b", "lrc-301?x=1", "lrc,301", "%2e%2e", "", "a" * 121, "x/", "/x", ".", "a//b", "a;b", "lrc-301\n"]:
            self.assertFalse(self.d.decide(read(path=bad)).allowed, bad)
        self.assertEqual(self.sb.calls, [])

    def test_sub_paths_are_fine(self):
        self.sb.people["good-dean"].add("lrc/301.sub")
        self.assertTrue(self.d.decide(read(path="lrc/301.sub")).allowed)

    def test_only_webrtc_playback_is_allowed(self):
        self.assertFalse(self.d.decide(read(protocol="rtsp")).allowed)
        self.assertFalse(self.d.decide(read(protocol="hls")).allowed)
        for action in ["playback", "api", "metrics", "pprof", None, "delete"]:
            req = read()
            req["action"] = action
            self.assertFalse(self.d.decide(req).allowed, action)

    def test_publishing_is_only_for_programs_on_the_pi(self):
        pub = lambda ip: {"ip": ip, "action": "publish", "path": "lrc-301", "protocol": "rtsp", "user": "", "password": "", "token": ""}
        self.assertTrue(self.d.decide(pub("127.0.0.1")).allowed)
        self.assertTrue(self.d.decide(pub("::1")).allowed)
        self.assertFalse(self.d.decide(pub("192.168.1.55")).allowed)
        self.assertFalse(self.d.decide(pub("")).allowed)
        self.assertFalse(self.d.decide(pub("not-an-ip")).allowed)
        off = camera_auth.Decider(self.sb.url, "k", allow_local_publish=False)
        self.assertFalse(off.decide(pub("127.0.0.1")).allowed)

    def test_a_yes_is_remembered_for_a_minute(self):
        self.d.decide(read())
        self.d.decide(read())
        self.assertEqual(len(self.sb.calls), 1)
        self.clock.t += 59
        self.d.decide(read())
        self.assertEqual(len(self.sb.calls), 1)
        self.clock.t += 2
        self.d.decide(read())
        self.assertEqual(len(self.sb.calls), 2)

    def test_a_no_is_remembered_only_briefly(self):
        self.d.decide(read(token="teacher"))
        self.d.decide(read(token="teacher"))
        self.assertEqual(len(self.sb.calls), 1)
        self.clock.t += 6
        self.d.decide(read(token="teacher"))
        self.assertEqual(len(self.sb.calls), 2)

    def test_the_cache_does_not_mix_people_or_cameras(self):
        self.assertTrue(self.d.decide(read(token="good-dean")).allowed)
        self.assertFalse(self.d.decide(read(token="teacher")).allowed)
        self.assertFalse(self.d.decide(read(token="good-dean", path="lrc-999")).allowed)

    def test_a_database_outage_means_no_and_is_not_remembered(self):
        self.sb.mode = "error500"
        v = self.d.decide(read())
        self.assertFalse(v.allowed)
        self.sb.mode = "normal"
        self.assertTrue(self.d.decide(read()).allowed)  # recovers at once

    def test_an_unreachable_database_means_no(self):
        d = camera_auth.Decider("http://127.0.0.1:9", "k", timeout=1)
        self.assertFalse(d.decide(read()).allowed)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.sb = FakeSupabase()
        self.addCleanup(self.sb.close)
        self.lines = []
        decider = camera_auth.Decider(self.sb.url, "anon-key", timeout=2)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), camera_auth.make_handler(decider, log=self.lines.append))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def post(self, body, path="/auth"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_mediamtx_gets_200_for_yes_and_401_for_no(self):
        self.assertEqual(self.post(read()), 200)
        self.assertEqual(self.post(read(token="teacher")), 401)
        self.assertEqual(self.post(read(token="")), 401)

    def test_bad_requests(self):
        self.assertEqual(self.post(b"not json"), 400)
        self.assertEqual(self.post(b"[1,2]"), 400)
        self.assertEqual(self.post(b"x" * 20000), 413)
        self.assertEqual(self.post(read(), path="/other"), 404)

    def test_health(self):
        with urllib.request.urlopen(self.base + "/health", timeout=5) as r:
            self.assertEqual((r.status, r.read()), (200, b"ok"))

    def test_the_token_is_never_written_to_the_log(self):
        self.post(read(token="good-dean"))
        self.post(read(token="secret-token-123"))
        self.assertTrue(self.lines)
        self.assertFalse(any("good-dean" in l or "secret-token-123" in l for l in self.lines))
        self.assertTrue(any(l.startswith("ALLOW") for l in self.lines))
        self.assertTrue(any(l.startswith("DENY") for l in self.lines))

    def test_the_first_probe_without_credentials_is_not_logged(self):
        self.post(read(token=""))
        self.assertEqual(self.lines, [])


class StreamNameTests(unittest.TestCase):
    def test_matches_the_database_rule(self):
        ok = ["lrc-301", "a", "a.b", "a_b~c", "lrc/301", "A1/b2/c3"]
        bad = ["", "..", ".", "a/./b", "a/../b", "a b", "a?b", "a#b", "a@b", "/a", "a/", "a//b", "é", "lrc-301\n"]
        for s in ok:
            self.assertTrue(camera_auth.valid_stream_path(s), s)
        for s in bad:
            self.assertFalse(camera_auth.valid_stream_path(s), s)


if __name__ == "__main__":
    unittest.main()
