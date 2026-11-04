"""Talks to Supabase (PostgREST) with the service key. Only the standard library is used."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable


class BackendError(Exception):
    """kind: 'network' (could not reach it) or 'http' (it answered with an error)."""

    def __init__(self, message: str, kind: str, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


class Backend:
    def __init__(self, url: str, service_key: str, station_label: str, timeout: float = 6.0,
                 opener: Callable[..., Any] = urllib.request.urlopen):
        self.base = url.rstrip("/")
        self.key = service_key
        self.station = station_label
        self.timeout = timeout
        self._open = opener

    def _headers(self) -> dict[str, str]:
        # the newer "sb_secret_..." keys are not JWTs and go in the apikey header alone;
        # the older service_role JWT goes in both
        h = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json"}
        if not self.key.startswith("sb_"):
            h["Authorization"] = f"Bearer {self.key}"
        return h

    def _call(self, req: urllib.request.Request) -> Any:
        try:
            with self._open(req, timeout=self.timeout) as res:
                body = res.read(1_000_000)
        except urllib.error.HTTPError as err:
            try:
                detail = json.loads(err.read(20_000) or b"{}")
                message = detail.get("message") or detail.get("hint") or str(detail)
            except (ValueError, AttributeError):
                message = err.reason
            raise BackendError(f"{err.code}: {message}", "http", err.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise BackendError(f"cannot reach the database ({getattr(err, 'reason', err)})", "network") from None
        try:
            return json.loads(body) if body else None
        except ValueError:
            raise BackendError("the database answered with something that is not JSON", "http") from None

    def rpc(self, function: str, payload: dict) -> Any:
        req = urllib.request.Request(f"{self.base}/rest/v1/rpc/{function}", data=json.dumps(payload).encode(), headers=self._headers(), method="POST")
        return self._call(req)

    def authorize(self, card_uid: str) -> dict:
        """One card tap. Returns the decision JSON of authorize_card_at_station."""
        out = self.rpc("authorize_card_at_station", {"p_card_uid": card_uid, "p_station_label": self.station})
        if not isinstance(out, dict) or "decision" not in out:
            raise BackendError("unexpected answer from authorize_card_at_station", "http")
        return out

    def record_key(self, locker_id: str, key_detected: bool, at: str | None = None) -> dict:
        payload: dict = {"p_locker_id": locker_id, "p_key_detected": key_detected}
        if at:
            payload["p_at"] = at
        out = self.rpc("record_key_return", payload)
        return out if isinstance(out, dict) else {}

    def heartbeat(self, info: dict) -> dict:
        """"I am alive": the dashboard shows the station as online while these keep arriving (needs database update 11)."""
        out = self.rpc("station_heartbeat", {"p_station_label": self.station, "p_info": info})
        return out if isinstance(out, dict) else {}

    def record_latency(self, access_log_id: str, ms: int) -> None:
        """How long one tap took, from the card being read to the door acting on the answer (needs database update 11)."""
        self.rpc("record_tap_latency", {"p_access_log_id": access_log_id, "p_latency_ms": int(ms)})

    def lockers(self) -> list[dict]:
        """The active doors of this station: id, compartment_no and the room code."""
        q = urllib.parse.urlencode({
            "select": "id,compartment_no,room_id,rooms(code)",
            "station_label": f"eq.{self.station}",
            "is_active": "eq.true",
            "order": "compartment_no",
        }, safe=",()*.")
        req = urllib.request.Request(f"{self.base}/rest/v1/lockers?{q}", headers=self._headers(), method="GET")
        out = self._call(req)
        if not isinstance(out, list):
            raise BackendError("unexpected answer when reading the doors", "http")
        return out

    def key_status(self) -> list[dict]:
        """For each door of this station: locker_id and key_status (available / issued / outstanding)."""
        q = urllib.parse.urlencode({
            "select": "locker_id,compartment_no,key_status",
            "station_label": f"eq.{self.station}",
        }, safe=",()*.")
        req = urllib.request.Request(f"{self.base}/rest/v1/locker_status?{q}", headers=self._headers(), method="GET")
        out = self._call(req)
        if not isinstance(out, list):
            raise BackendError("unexpected answer when reading the key status", "http")
        return out
