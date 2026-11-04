"""The locker station's brain. One loop, no threads of its own: step() is called about 20 times a second.

Safety rules the code keeps:
  * Doors are locked unless a tap was GRANTED (or is a return) in the last unlock_seconds.
  * If the database cannot be reached, a tap opens nothing (fail closed). The doors cannot be opened offline.
  * A key that is put back while the network is down is remembered on disk and sent later, in order.
  * A key switch must hold its new state for confirm_ms before it counts (contact bounce).
  * Reporting "I am alive" and how long each tap took is low priority: it never runs in the pass that handles a card,
    and a failure there never stops the doors.
"""
from __future__ import annotations

import json
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import __version__
from .backend import Backend, BackendError
from .config import Config
from .spool import Spool

DENIAL_TEXT = {
    "unregistered_credential": ("Card not", "registered"),
    "inactive_credential": ("Card is", "switched off"),
    "outside_scheduled_time": ("No class", "right now"),
    "assigned_to_different_room": ("Your class is", "in another room"),
    "key_already_issued": ("Key is already", "taken"),
}
FLUSH_EVERY = 10.0        # seconds between tries to send waiting key events
REFRESH_EVERY = 300.0     # seconds between reads of the door list
HEARTBEAT_EVERY = 60.0    # seconds between "I am alive" reports (the dashboard calls a station silent after 3 minutes)
LATENCY_QUEUE = 50        # tap times waiting to be reported; the oldest is dropped beyond this
DROP_STATUSES = {400, 404, 409, 422}   # the database refuses the event for good; retrying cannot help


class Station:
    def __init__(self, cfg: Config, backend: Backend, reader, doors, display, indicators, spool: Spool, *,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 events: Callable[..., None] | None = None):
        self.cfg, self.backend, self.reader, self.doors = cfg, backend, reader, doors
        self.display, self.ind, self.spool = display, indicators, spool
        self.clock, self.wall = clock, wall
        self._events = events or (lambda *_a, **_k: None)

        self.locker_ids: dict[int, str] = {}      # compartment_no -> locker id
        self.room_codes: dict[int, str] = {}
        self.online: bool | None = None           # None until the first answer
        self.unlock_until: dict[int, float] = {}
        self.returning: set[int] = set()          # doors unlocked for a return
        self._stable: dict[int, bool] = {}
        self._pending: dict[int, tuple[bool, float, datetime]] = {}
        self._last_uid = ""
        self._last_uid_at = -1e9
        self._message_until = 0.0
        self._next_flush = 0.0
        self._next_refresh = 0.0
        self._next_heartbeat = 0.0
        self._started = clock()
        self._latency: deque[tuple[str, int]] = deque(maxlen=LATENCY_QUEUE)   # (access_log_id, milliseconds)
        self._latency_off = False                 # the database has no record_tap_latency (update 11 not applied)

    # ------------------------------------------------------------------ start
    def start(self) -> None:
        now = self.clock()
        for n in self.cfg.doors:
            self.doors.lock(n)
            self._stable[n] = self.doors.key_present(n)
        self._refresh_doors(now)
        self._boot_sync()
        self._started = now
        self._heartbeat(now)
        self._events("start", station=self.cfg.station_label, doors=sorted(self.cfg.doors),
                     keys_in=sorted(n for n, v in self._stable.items() if v), waiting=len(self.spool))
        self._idle()

    def _boot_sync(self) -> None:
        """A key that was put back while the station was off: close its open issue now."""
        try:
            rows = self.backend.key_status()
        except BackendError as err:
            self._offline(err)
            return
        self._online()
        status = {r.get("compartment_no"): r.get("key_status") for r in rows}
        for n, present in self._stable.items():
            if present and status.get(n) in ("issued", "outstanding"):
                self._report_key(n, True, self.wall())

    # ------------------------------------------------------------------ the loop
    def step(self) -> None:
        now = self.clock()
        self._relock_due(now)
        self._poll_keys(now)
        if now >= self._next_refresh:
            self._refresh_doors(now)
        if now >= self._next_flush and len(self.spool):
            self._next_flush = now + FLUSH_EVERY
            self._flush()
        if self._message_until and now >= self._message_until:
            self._message_until = 0.0
            self._idle()
        uid = self.reader.read()
        if uid:
            self._on_card(uid, now)
        else:
            self._housekeeping(now)

    def run(self, stop, interval: float = 0.05) -> None:
        self.start()
        try:
            while not stop.is_set():
                try:
                    self.step()
                except Exception as err:  # one bad pass must not leave the station dead
                    self._events("error", message=f"{type(err).__name__}: {err}")
                stop.wait(interval)
        finally:
            self.close()

    def close(self) -> None:
        for n in self.cfg.doors:
            self.doors.lock(n)
        self.display.show("Out of service", "")

    # ------------------------------------------------------------------ cards
    def _on_card(self, uid: str, now: float) -> None:
        tapped = self.clock()     # the response time is counted from here: the card number has just arrived
        held = uid == self._last_uid and now - self._last_uid_at < self.cfg.repeat_ignore_seconds
        self._last_uid, self._last_uid_at = uid, now
        if held:  # still on the reader: not a new tap
            return
        try:
            out = self.backend.authorize(uid)
        except BackendError as err:
            self._offline(err)
            self._events("tap", card=uid, outcome="no_connection", detail=str(err))
            self._say("No connection", "Try again soon", now)
            self.ind.error()
            return
        self._online()
        decision, reason = out.get("decision"), out.get("reason")
        n = out.get("compartment_no")
        self._remember(n, out)
        if decision in ("granted", "return"):
            if n not in self.cfg.doors:
                self._events("tap", card=uid, outcome="door_not_wired", door=n)
                self._say("Door not set up", f"Door {n}", now)
                self.ind.error()
                return
            self.doors.unlock(n)
            ms = self._note_latency(out, tapped)
            self.unlock_until[n] = now + self.cfg.unlock_seconds
            room = out.get("room_code") or f"Door {n}"
            if decision == "return":
                self.returning.add(n)
                self._say("Put key back", room, now)
            else:
                self.returning.discard(n)
                self._say("Take the key", room, now)
            self.ind.ok()
            self._events("tap", card=uid, outcome=decision, door=n, room=room, reason=reason, ms=ms)
        else:
            line1, line2 = DENIAL_TEXT.get(reason, ("Not allowed", ""))
            self._say(line1, line2, now)
            self.ind.denied()
            ms = self._note_latency(out, tapped)
            self._events("tap", card=uid, outcome="denied", reason=reason, door=n, ms=ms)

    # ------------------------------------------------------------------ "I am alive" and tap times (low priority)
    def _note_latency(self, out: dict, tapped: float) -> int | None:
        """Milliseconds from the card arriving to the door (or the refusal) acting on the answer; queued for sending.

        Not counted: the up-to-50 ms wait before the loop next looks at the reader. A return tap has no log line to
        attach the time to, so it is not timed.
        """
        ms = max(0, int(round((self.clock() - tapped) * 1000)))
        log_id = out.get("access_log_id")
        if log_id and not self._latency_off:
            self._latency.append((str(log_id), ms))
        return ms

    def _housekeeping(self, now: float) -> None:
        """At most one call to the database, and only in a pass where nobody tapped."""
        if now >= self._next_heartbeat:
            self._heartbeat(now)
        elif self._latency:
            self._send_latency()

    def _heartbeat(self, now: float) -> None:
        self._next_heartbeat = now + HEARTBEAT_EVERY
        info = {"version": __version__, "doors": sorted(self.cfg.doors), "waiting": len(self.spool),
                "uptime_s": max(0, int(now - self._started))}
        try:
            self.backend.heartbeat(info)
            self._online()
        except BackendError as err:
            if err.kind == "network":
                self._offline(err)
            else:   # the database answered but refused (say, update 11 is not applied): the station itself is fine
                self._events("heartbeat_failed", detail=str(err))
        except Exception as err:
            self._events("heartbeat_failed", detail=f"{type(err).__name__}: {err}")

    def _send_latency(self) -> None:
        log_id, ms = self._latency.popleft()     # one failure loses one reading, never the doors
        try:
            self.backend.record_latency(log_id, ms)
            self._online()
        except BackendError as err:
            if err.kind == "network":
                self._offline(err)
            else:
                self._events("latency_dropped", detail=str(err))
                if err.status == 404:            # the function does not exist: stop asking until the program restarts
                    self._latency_off = True
                    self._latency.clear()
        except Exception as err:
            self._events("latency_dropped", detail=f"{type(err).__name__}: {err}")

    def _remember(self, n, out: dict) -> None:
        if isinstance(n, int) and out.get("locker_id") and n in self.cfg.doors:
            self.locker_ids.setdefault(n, out["locker_id"])
            if out.get("room_code"):
                self.room_codes[n] = out["room_code"]

    # ------------------------------------------------------------------ doors
    def _relock_due(self, now: float) -> None:
        for n, until in list(self.unlock_until.items()):
            if now >= until:
                self._lock(n)

    def _lock(self, n: int) -> None:
        self.doors.lock(n)
        self.unlock_until.pop(n, None)
        self.returning.discard(n)

    def _poll_keys(self, now: float) -> None:
        confirm = self.cfg.confirm_ms / 1000.0
        for n in self.cfg.doors:
            raw = self.doors.key_present(n)
            if raw == self._stable[n]:
                self._pending.pop(n, None)
                continue
            p = self._pending.get(n)
            if p is None or p[0] != raw:
                self._pending[n] = (raw, now, self.wall())
                continue
            if now - p[1] >= confirm:
                self._stable[n] = raw
                del self._pending[n]
                self._key_changed(n, raw, p[2])

    def _key_changed(self, n: int, present: bool, at: datetime) -> None:
        if present:
            self._events("key_in", door=n)
            self._report_key(n, True, at)
            if n in self.returning:   # put back: lock again without waiting for the timer
                self._lock(n)
        else:
            self._events("key_out", door=n, door_was_unlocked=n in self.unlock_until)

    # ------------------------------------------------------------------ key events and the waiting list
    def _report_key(self, n: int, present: bool, at: datetime) -> None:
        item = {"compartment_no": n, "locker_id": self.locker_ids.get(n), "key_detected": present,
                "at": at.astimezone(timezone.utc).isoformat()}
        if len(self.spool):          # keep the order: older events first
            self.spool.add(item)
            self._flush()
            return
        try:
            self._send(item)
            self._online()
        except BackendError as err:
            self._offline(err)
            self.spool.add(item)
            self._events("key_waiting", door=n, detail=str(err), waiting=len(self.spool))
        except Exception as err:
            self.spool.add(item)
            self._events("key_waiting", door=n, detail=str(err), waiting=len(self.spool))

    def _send(self, item: dict) -> None:
        locker = item.get("locker_id") or self.locker_ids.get(item.get("compartment_no"))
        if not locker:
            raise BackendError("this door is not known yet", "network")
        try:
            self.backend.record_key(locker, bool(item["key_detected"]), item.get("at"))
        except BackendError as err:
            if err.kind == "http" and err.status in DROP_STATUSES:
                self._events("key_dropped", door=item.get("compartment_no"), detail=str(err))
                return
            raise

    def _flush(self) -> None:
        sent = self.spool.flush(self._send)
        if sent:
            self._online()
            self._events("key_sent", count=sent, waiting=len(self.spool))

    def _refresh_doors(self, now: float) -> None:
        rows = None
        try:
            rows = self.backend.lockers()
            self._online()
            self._save_cache(rows)
        except BackendError as err:
            self._offline(err)
            rows = self._load_cache()
        for r in rows or []:
            n = r.get("compartment_no")
            if n in self.cfg.doors and r.get("id"):
                self.locker_ids[n] = r["id"]
                code = (r.get("rooms") or {}).get("code")
                if code:
                    self.room_codes[n] = code
        # until every door is known (no answer and no saved copy), ask again soon
        self._next_refresh = now + (REFRESH_EVERY if all(n in self.locker_ids for n in self.cfg.doors) else FLUSH_EVERY)

    def _save_cache(self, rows) -> None:
        try:
            p = Path(self.cfg.lockers_cache)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows), encoding="utf-8")
            tmp.replace(p)
        except OSError:
            pass

    def _load_cache(self):
        try:
            data = json.loads(Path(self.cfg.lockers_cache).read_text(encoding="utf-8"))
            return data if isinstance(data, list) else None
        except (OSError, ValueError):
            return None

    # ------------------------------------------------------------------ screen
    def _say(self, line1: str, line2: str, now: float) -> None:
        self.display.show(line1, line2)
        self._message_until = now + self.cfg.message_seconds

    def _idle(self) -> None:
        self.display.show("Tap your ID card", "OFFLINE" if self.online is False else "to get the key")

    def _online(self) -> None:
        if self.online is False and not self._message_until:
            self.online = True
            self._idle()
        self.online = True

    def _offline(self, err) -> None:
        if self.online is not False:
            self._events("offline", detail=str(err))
        self.online = False
        if not self._message_until:
            self._idle()
