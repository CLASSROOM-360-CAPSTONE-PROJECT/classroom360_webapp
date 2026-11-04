import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from locker_station import config, controller, hardware, readers
from locker_station.backend import BackendError
from locker_station.spool import Spool

T0 = datetime(2026, 11, 4, 2, 0, 0, tzinfo=timezone.utc)   # 10:00 in Manila


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t
    def advance(self, s): self.t += s
    def wall(self): return T0 + timedelta(seconds=self.t - 1000.0)


class FakeBackend:
    def __init__(self):
        self.answers = []                 # queue of dicts or exceptions for authorize()
        self.default = None
        self.authorized, self.recorded = [], []
        self.record_error = None          # exception raised by record_key (or None)
        self.lockers_rows = [{"id": f"L{n}", "compartment_no": n, "rooms": {"code": f"LRC-30{n}"}} for n in (1, 2, 3, 4)]
        self.lockers_error = None
        self.status_rows = []
        self.heartbeats, self.latencies = [], []
        self.heartbeat_error = None       # exception raised by heartbeat() (or None)
        self.latency_error = None         # exception raised by record_latency() (or None)
        self.clock = None                 # a test clock to move forward while "the database" thinks
        self.authorize_seconds = 0.0      # how long authorize() takes

    def heartbeat(self, info):
        if self.heartbeat_error or self.lockers_error:
            raise self.heartbeat_error or self.lockers_error      # the same outage affects every call
        self.heartbeats.append(info)
        return {}

    def record_latency(self, access_log_id, ms):
        if self.latency_error:
            raise self.latency_error
        self.latencies.append((access_log_id, ms))

    def authorize(self, uid):
        self.authorized.append(uid)
        if self.clock is not None:
            self.clock.advance(self.authorize_seconds)
        a = self.answers.pop(0) if self.answers else self.default
        if isinstance(a, Exception):
            raise a
        return a

    def record_key(self, locker_id, key_detected, at=None):
        if self.record_error:
            raise self.record_error
        self.recorded.append((locker_id, key_detected, at))
        return {}

    def lockers(self):
        if self.lockers_error:
            raise self.lockers_error
        return self.lockers_rows

    def key_status(self):
        if self.lockers_error:      # the same outage affects every call
            raise self.lockers_error
        return self.status_rows


def grant(n, reason="scheduled_match"):
    return {"decision": "granted", "reason": reason, "compartment_no": n, "locker_id": f"L{n}", "room_code": f"LRC-30{n}"}


def deny(reason, n=1):
    return {"decision": "denied", "reason": reason, "compartment_no": n, "locker_id": f"L{n}", "room_code": f"LRC-30{n}"}


def ret(n):
    return {"decision": "return", "reason": "key_return", "compartment_no": n, "locker_id": f"L{n}", "room_code": f"LRC-30{n}"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.cfg = config.parse({
            "supabase_url": "https://x.supabase.co", "station_label": "S",
            "doors": {str(n): {"relay": 10 + n, "switch": 20 + n} for n in (1, 2, 3, 4)},
            "unlock_seconds": 5, "confirm_ms": 300,
            "files": {"spool": os.path.join(self.tmp.name, "spool.jsonl"), "lockers_cache": os.path.join(self.tmp.name, "lockers.json"),
                      "event_log": os.path.join(self.tmp.name, "events.jsonl")},
        }, {"SUPABASE_SERVICE_KEY": "k"})
        self.be = FakeBackend()
        self.reader = readers.SimulatedReader()
        self.doors = hardware.SimulatedDoors([1, 2, 3, 4])
        self.display = hardware.NullDisplay()
        self.ind = hardware.NullIndicators()
        self.log = []
        self.st = self.make()

    def make(self):
        return controller.Station(self.cfg, self.be, self.reader, self.doors, self.display, self.ind, Spool(self.cfg.spool_file),
                                  clock=self.clock, wall=self.clock.wall, events=lambda kind, **f: self.log.append((kind, f)))

    def tearDown(self):
        self.tmp.cleanup()

    def tick(self, seconds=0.0, n=1):
        for _ in range(n):
            self.clock.advance(seconds)
            self.st.step()

    def tap(self, uid="04A1B2C3"):
        self.reader.tap(uid)
        self.st.step()

    def kinds(self):
        return [k for k, _ in self.log]


class StartTests(Base):
    def test_start_locks_everything_and_loads_doors(self):
        self.doors.unlocked = {2}
        self.st.start()
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.st.locker_ids, {1: "L1", 2: "L2", 3: "L3", 4: "L4"})
        self.assertEqual(self.display.last, ("Tap your ID card", "to get the key"))
        self.assertTrue(os.path.exists(self.cfg.lockers_cache))

    def test_doors_come_from_the_cache_when_the_database_is_down(self):
        self.st.start()
        self.be.lockers_error = BackendError("down", "network")
        again = self.make()
        again.start()
        self.assertEqual(again.locker_ids[3], "L3")
        self.assertEqual(self.display.last, ("Tap your ID card", "OFFLINE"))

    def test_first_boot_offline_learns_the_doors_later_and_sends_waiting_events(self):
        self.be.lockers_error = BackendError("down", "network")
        self.be.record_error = BackendError("down", "network")
        self.st.start()
        self.assertEqual(self.st.locker_ids, {})
        self.doors.set_key(2, False); self.tick(0.4, 2)
        self.doors.set_key(2, True); self.tick(0.4, 2)
        self.assertEqual(len(self.st.spool), 1)
        self.be.lockers_error = None
        self.be.record_error = None
        self.tick(controller.FLUSH_EVERY + 1)
        self.assertEqual(self.st.locker_ids[2], "L2")
        self.assertEqual([r[:2] for r in self.be.recorded], [("L2", True)])
        self.assertEqual(len(self.st.spool), 0)

    def test_boot_sync_closes_issues_for_keys_that_came_back_while_off(self):
        self.be.status_rows = [{"compartment_no": 1, "key_status": "available"}, {"compartment_no": 2, "key_status": "issued"},
                               {"compartment_no": 3, "key_status": "outstanding"}, {"compartment_no": 4, "key_status": "issued"}]
        self.doors.set_key(4, False)       # key 4 really is out
        self.st.start()
        self.assertEqual(sorted((r[0], r[1]) for r in self.be.recorded), [("L2", True), ("L3", True)])


class TapTests(Base):
    def setUp(self):
        super().setUp()
        self.st.start()

    def test_grant_unlocks_that_door_only_until_the_timer_ends(self):
        self.be.default = grant(3)
        self.tap()
        self.assertEqual(self.doors.unlocked, {3})
        self.assertEqual(self.display.last, ("Take the key", "LRC-303"))
        self.assertEqual(self.ind.events, ["ok"])
        self.tick(4.0)
        self.assertEqual(self.doors.unlocked, {3})
        self.tick(1.1)
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.doors.history[-1], ("lock", 3))

    def test_screen_returns_to_the_prompt(self):
        self.be.default = deny("outside_scheduled_time")
        self.tap()
        self.assertEqual(self.display.last, ("No class", "right now"))
        self.tick(self.cfg.message_seconds + 0.1)
        self.assertEqual(self.display.last, ("Tap your ID card", "to get the key"))

    def test_each_denial_has_its_own_words_and_opens_nothing(self):
        want = {"unregistered_credential": "Card not", "inactive_credential": "Card is", "outside_scheduled_time": "No class",
                "assigned_to_different_room": "Your class is", "key_already_issued": "Key is already", "something_new": "Not allowed"}
        for i, (reason, line1) in enumerate(want.items()):
            self.be.default = deny(reason)
            self.tap(f"AA{i}")
            self.assertEqual(self.display.last[0], line1, reason)
            self.assertEqual(self.doors.unlocked, set(), reason)
        self.assertEqual(self.ind.events, ["denied"] * len(want))

    def test_network_failure_fails_closed(self):
        self.be.default = BackendError("cannot reach the database", "network")
        self.tap()
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.display.last, ("No connection", "Try again soon"))
        self.assertEqual(self.ind.events, ["error"])
        self.assertFalse(self.st.online)
        self.tick(self.cfg.message_seconds + 0.1)
        self.assertEqual(self.display.last, ("Tap your ID card", "OFFLINE"))

    def test_database_error_fails_closed_too(self):
        for status in (401, 404, 500):
            self.be.default = BackendError(f"{status}: boom", "http", status)
            self.tap(f"B{status}")
            self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.ind.events, ["error"] * 3)

    def test_unexpected_exception_leaves_doors_locked(self):
        self.be.default = RuntimeError("bug")
        self.reader.tap("A1")
        with self.assertRaises(RuntimeError):
            self.st.step()
        self.assertEqual(self.doors.unlocked, set())

    def test_a_card_held_on_the_reader_counts_once(self):
        self.be.default = deny("outside_scheduled_time")
        self.reader.tap("A1")
        for _ in range(20):                    # still on the reader: read again and again, 0.1 s apart
            self.reader.tap("A1")
            self.tick(0.1)
        self.assertEqual(len(self.be.authorized), 1)
        self.tick(self.cfg.repeat_ignore_seconds + 0.1)   # taken away
        self.tap("A1")
        self.assertEqual(len(self.be.authorized), 2)

    def test_a_different_card_straight_after_is_not_ignored(self):
        self.be.default = deny("outside_scheduled_time")
        self.tap("A1")
        self.tick(0.2)
        self.tap("B2")
        self.assertEqual(self.be.authorized, ["A1", "B2"])

    def test_a_door_that_is_not_wired_is_not_opened(self):
        cfg = config.parse({"supabase_url": "https://x.supabase.co", "station_label": "S",
                            "doors": {"1": {"relay": 11, "switch": 21}}, "files": {"spool": os.path.join(self.tmp.name, "s2.jsonl"),
                            "lockers_cache": os.path.join(self.tmp.name, "l2.json"), "event_log": os.path.join(self.tmp.name, "e2.jsonl")}},
                           {"SUPABASE_SERVICE_KEY": "k"})
        st = controller.Station(cfg, self.be, self.reader, self.doors, self.display, self.ind, Spool(cfg.spool_file), clock=self.clock, wall=self.clock.wall)
        st.start()
        self.be.default = grant(3)
        self.reader.tap("A1")
        st.step()
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.display.last[0], "Door not set up")

    def test_a_second_grant_for_the_same_door_extends_the_time(self):
        self.be.default = grant(2)
        self.tap("A1")
        self.tick(4.0)
        self.tick(self.cfg.repeat_ignore_seconds)
        self.tap("A2")
        self.tick(4.0)
        self.assertEqual(self.doors.unlocked, {2})

    def test_locker_ids_are_learned_from_taps_when_the_list_is_missing(self):
        self.be.lockers_rows = []
        st = self.make()
        st.start()
        self.be.default = grant(3)
        self.reader.tap("A1")
        st.step()
        self.assertEqual(st.locker_ids[3], "L3")


class KeyTests(Base):
    def setUp(self):
        super().setUp()
        self.st.start()

    def test_contact_bounce_is_not_reported(self):
        self.doors.set_key(2, False)
        self.tick(0.1)
        self.doors.set_key(2, True)       # back within 100 ms
        self.tick(0.1)
        self.doors.set_key(2, False)
        self.tick(0.1)
        self.doors.set_key(2, True)
        self.tick(1.0, 3)
        self.assertEqual(self.be.recorded, [])
        self.assertNotIn("key_out", self.kinds())

    def test_a_change_must_hold_for_the_whole_confirm_time(self):
        self.doors.set_key(2, False)
        self.tick(0.1)                    # first seen
        self.tick(0.1)                    # still changed, but only 0.1 s old (confirm is 0.3 s)
        self.assertNotIn("key_out", self.kinds())
        self.tick(0.25)
        self.assertIn("key_out", self.kinds())
        self.doors.set_key(2, True)
        self.tick(0.1); self.tick(0.1)
        self.assertEqual(self.be.recorded, [])
        self.tick(0.25)
        self.assertEqual(len(self.be.recorded), 1)

    def test_key_taken_and_returned_is_reported_once_with_the_time_it_changed(self):
        self.doors.set_key(2, False)
        self.tick(0.1)
        self.tick(0.5)                      # now confirmed
        self.assertIn(("key_out", {"door": 2, "door_was_unlocked": False}), self.log)
        self.assertEqual(self.be.recorded, [])
        self.tick(60)
        self.doors.set_key(2, True)
        self.tick(0.1)
        returned_at = self.clock.wall()     # the moment the switch was first seen in its new state
        self.tick(0.5)
        self.assertEqual(len(self.be.recorded), 1)
        locker, present, at = self.be.recorded[0]
        self.assertEqual((locker, present), ("L2", True))
        self.assertEqual(at, returned_at.isoformat())
        self.tick(5, 3)
        self.assertEqual(len(self.be.recorded), 1)

    def test_removing_a_key_from_a_locked_door_is_logged_as_such(self):
        self.doors.set_key(1, False)
        self.tick(0.4, 2)
        self.assertEqual([f for k, f in self.log if k == "key_out"], [{"door": 1, "door_was_unlocked": False}])

    def test_removing_the_key_after_a_grant_is_normal(self):
        self.be.default = grant(1)
        self.tap()
        self.doors.set_key(1, False)
        self.tick(0.4, 2)
        self.assertEqual([f for k, f in self.log if k == "key_out"], [{"door": 1, "door_was_unlocked": True}])

    def test_key_put_back_while_offline_is_kept_and_sent_in_order(self):
        self.be.record_error = BackendError("cannot reach the database", "network")
        self.doors.set_key(1, False); self.tick(0.4, 2)
        self.doors.set_key(3, False); self.tick(0.4, 2)
        self.doors.set_key(1, True); self.tick(0.4, 2)
        self.doors.set_key(3, True); self.tick(0.4, 2)
        self.assertEqual(self.be.recorded, [])
        self.assertEqual(len(self.st.spool), 2)
        self.assertFalse(self.st.online)
        # the station restarts (power cut) and still remembers
        again = self.make()
        self.assertEqual(len(again.spool), 2)
        # the network comes back
        self.be.record_error = None
        self.tick(controller.FLUSH_EVERY + 1)
        self.assertEqual([r[0] for r in self.be.recorded], ["L1", "L3"])
        self.assertEqual(len(self.st.spool), 0)
        self.assertTrue(self.st.online)
        self.assertIn("key_sent", self.kinds())

    def test_new_events_queue_behind_older_waiting_ones(self):
        self.be.record_error = BackendError("down", "network")
        self.doors.set_key(1, False); self.tick(0.4, 2)
        self.doors.set_key(1, True); self.tick(0.4, 2)
        self.be.record_error = None
        self.doors.set_key(2, False); self.tick(0.4, 2)
        self.doors.set_key(2, True); self.tick(0.4, 2)
        self.assertEqual([r[0] for r in self.be.recorded], ["L1", "L2"])

    def test_an_event_the_database_refuses_for_good_does_not_block_the_queue(self):
        self.be.record_error = BackendError("404: unknown locker", "http", 404)
        self.doors.set_key(1, False); self.tick(0.4, 2)
        self.doors.set_key(1, True); self.tick(0.4, 2)
        self.assertEqual(len(self.st.spool), 0)
        self.assertIn("key_dropped", self.kinds())
        self.be.record_error = None
        self.doors.set_key(2, False); self.tick(0.4, 2)
        self.doors.set_key(2, True); self.tick(0.4, 2)
        self.assertEqual([r[0] for r in self.be.recorded], ["L2"])

    def test_a_wrong_key_is_not_thrown_away(self):
        self.be.record_error = BackendError("401: invalid api key", "http", 401)
        self.doors.set_key(1, False); self.tick(0.4, 2)
        self.doors.set_key(1, True); self.tick(0.4, 2)
        self.assertEqual(len(self.st.spool), 1)

    def test_return_tap_unlocks_and_relocks_as_soon_as_the_key_is_back(self):
        self.doors.set_key(3, False); self.tick(0.4, 2)
        self.be.default = ret(3)
        self.tap()
        self.assertEqual(self.doors.unlocked, {3})
        self.assertEqual(self.display.last, ("Put key back", "LRC-303"))
        self.assertIn(3, self.st.returning)
        self.tick(1.0)
        self.doors.set_key(3, True)
        self.tick(0.4, 2)
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual([r[:2] for r in self.be.recorded], [("L3", True)])
        self.assertEqual(self.st.unlock_until, {})

    def test_return_door_also_relocks_when_the_time_runs_out(self):
        self.doors.set_key(3, False); self.tick(0.4, 2)
        self.be.default = ret(3)
        self.tap()
        self.tick(5.1)
        self.assertEqual(self.doors.unlocked, set())

    def test_a_granted_door_is_not_relocked_early_by_a_key_that_was_already_in(self):
        self.be.default = grant(2)
        self.tap()
        self.tick(1.0)
        self.assertEqual(self.doors.unlocked, {2})


class LoopTests(Base):
    def test_run_survives_an_exception_and_locks_up_at_the_end(self):
        class Stop:
            def __init__(self, n): self.n = n
            def is_set(self):
                self.n -= 1
                return self.n < 0
            def wait(self, _s): pass
        self.be.default = RuntimeError("bug in one pass")
        self.reader.tap("A1")
        self.st.run(Stop(5))
        self.assertIn("error", self.kinds())
        self.assertEqual(self.doors.unlocked, set())
        self.assertEqual(self.display.last, ("Out of service", ""))

    def test_close_locks_every_door(self):
        self.st.start()
        self.doors.unlock(1); self.doors.unlock(4)
        self.st.close()
        self.assertEqual(self.doors.unlocked, set())

def logged(n, decision="granted", reason="scheduled_match"):
    """a station answer that carries the id of the line the database wrote for the tap"""
    out = (grant if decision == "granted" else lambda k: deny(reason, k))(n)
    out["access_log_id"] = f"LOG{n}"
    return out


class HeartbeatTests(Base):
    def test_start_says_hello_with_version_doors_and_waiting_events(self):
        self.st.start()
        self.assertEqual(len(self.be.heartbeats), 1)
        info = self.be.heartbeats[0]
        self.assertEqual(info["doors"], [1, 2, 3, 4])
        self.assertEqual(info["waiting"], 0)
        self.assertEqual(info["version"], controller.__version__)
        self.assertEqual(info["uptime_s"], 0)

    def test_it_repeats_every_minute_and_not_sooner(self):
        self.st.start()
        self.tick(controller.HEARTBEAT_EVERY - 1)
        self.assertEqual(len(self.be.heartbeats), 1)
        self.tick(2)
        self.assertEqual(len(self.be.heartbeats), 2)
        self.assertGreaterEqual(self.be.heartbeats[1]["uptime_s"], 60)
        self.tick(controller.HEARTBEAT_EVERY - 1)
        self.assertEqual(len(self.be.heartbeats), 2)

    def test_waiting_key_events_are_counted(self):
        self.be.record_error = BackendError("down", "network")
        self.st.start()
        self.doors.set_key(2, False); self.tick(0.4, 2)
        self.doors.set_key(2, True); self.tick(0.4, 2)
        self.assertEqual(len(self.st.spool), 1)
        self.be.record_error = None
        self.tick(controller.HEARTBEAT_EVERY)
        self.assertEqual(self.be.heartbeats[-1]["waiting"], len(self.st.spool))

    def test_a_dead_network_marks_the_station_offline_and_it_tries_again_a_minute_later(self):
        self.st.start()
        self.be.heartbeat_error = BackendError("down", "network")
        self.tick(controller.HEARTBEAT_EVERY + 1)
        self.assertFalse(self.st.online)
        self.assertEqual(self.display.last, ("Tap your ID card", "OFFLINE"))
        self.be.heartbeat_error = None
        self.tick(controller.HEARTBEAT_EVERY - 5)
        self.assertEqual(len(self.be.heartbeats), 1)              # not sooner than a minute after the failed try
        self.tick(10)
        self.assertEqual(len(self.be.heartbeats), 2)
        self.assertTrue(self.st.online)
        self.assertEqual(self.display.last, ("Tap your ID card", "to get the key"))

    def test_a_refusal_from_the_database_is_only_logged(self):
        # database update 11 not applied: the function does not exist (404); the doors and the screen carry on
        self.be.heartbeat_error = BackendError("404: Could not find the function public.station_heartbeat", "http", 404)
        self.st.start()
        self.tick(controller.HEARTBEAT_EVERY + 1)
        self.assertTrue(self.st.online)
        self.assertEqual(self.kinds().count("heartbeat_failed"), 2)
        self.be.default = grant(2)
        self.tap()
        self.assertEqual(self.doors.unlocked, {2})

    def test_an_unexpected_error_in_the_heartbeat_does_not_escape(self):
        self.be.heartbeat_error = RuntimeError("bug")
        self.st.start()
        self.tick(controller.HEARTBEAT_EVERY + 1)
        self.assertIn("heartbeat_failed", self.kinds())

    def test_a_tap_is_never_delayed_by_housekeeping(self):
        self.st.start()
        self.clock.advance(controller.HEARTBEAT_EVERY + 1)
        self.be.default = grant(3)
        self.reader.tap("04A1B2C3")
        self.st.step()
        self.assertEqual(self.doors.unlocked, {3})
        self.assertEqual(len(self.be.heartbeats), 1)               # the report waits for the next quiet pass
        self.st.step()
        self.assertEqual(len(self.be.heartbeats), 2)


class TapTimeTests(Base):
    def setUp(self):
        super().setUp()
        self.be.clock = self.clock
        self.be.authorize_seconds = 0.25          # the "database" takes a quarter of a second

    def sent(self):
        return list(self.be.latencies)

    def test_a_granted_tap_is_timed_and_sent_on_a_following_quiet_pass(self):
        self.st.start()
        self.be.default = logged(2)
        self.tap()
        self.assertEqual(self.sent(), [])                           # not in the pass that handled the card
        self.assertEqual(self.doors.unlocked, {2})
        self.st.step()
        self.assertEqual(self.sent(), [("LOG2", 250)])
        tap = [f for k, f in self.log if k == "tap"][0]
        self.assertEqual(tap["ms"], 250)

    def test_a_denied_tap_is_timed_too(self):
        self.st.start()
        self.be.default = logged(1, "denied", "unregistered_credential")
        self.tap("DEADBEEF")
        self.st.step()
        self.assertEqual(self.sent(), [("LOG1", 250)])

    def test_a_return_tap_has_no_log_line_and_is_not_sent(self):
        self.st.start()
        self.be.default = dict(ret(2), access_log_id=None)
        self.tap()
        self.st.step(); self.st.step()
        self.assertEqual(self.sent(), [])

    def test_a_tap_with_no_connection_is_not_timed(self):
        self.st.start()
        self.be.default = BackendError("down", "network")
        self.tap()
        self.st.step(); self.st.step()
        self.assertEqual(self.sent(), [])

    def test_the_time_covers_the_unlock_not_the_wait_for_the_next_pass(self):
        self.st.start()
        self.be.default = logged(4)
        self.tap()
        self.clock.advance(30)                                     # a long pause before the next pass changes nothing
        self.st.step()
        self.assertEqual(self.sent(), [("LOG4", 250)])

    def test_one_reading_is_sent_per_pass_in_order(self):
        self.st.start()
        for n in (1, 2, 3):
            self.be.default = logged(n)
            self.tap(f"CARD{n}")
            self.tick(self.cfg.repeat_ignore_seconds + 1)
        self.assertEqual([x[0] for x in self.sent()], ["LOG1", "LOG2", "LOG3"])

    def test_the_waiting_list_is_bounded(self):
        self.st.start()
        self.be.latency_error = BackendError("down", "network")
        # a database that cannot be reached for the answer but is reached for the tap would be odd; fill the list directly
        for i in range(controller.LATENCY_QUEUE + 20):
            self.st._latency.append((f"L{i}", i))
        self.assertEqual(len(self.st._latency), controller.LATENCY_QUEUE)
        self.assertEqual(self.st._latency[0][0], "L20")

    def test_a_network_failure_loses_one_reading_and_marks_offline(self):
        self.st.start()
        self.be.default = logged(2)
        self.tap()
        self.be.latency_error = BackendError("down", "network")
        self.st.step()
        self.assertEqual(len(self.st._latency), 0)
        self.assertFalse(self.st.online)

    def test_a_refused_reading_is_dropped_and_the_rest_still_go(self):
        self.st.start()
        self.be.default = logged(2)
        self.tap()
        self.be.latency_error = BackendError("22023: the response time must be between 0 and 60000 ms", "http", 400)
        self.st.step()
        self.assertEqual(self.kinds().count("latency_dropped"), 1)
        self.assertTrue(self.st.online)
        self.be.latency_error = None
        self.tick(self.cfg.repeat_ignore_seconds + 1)
        self.be.default = logged(3)
        self.tap("CARD3")
        self.st.step()
        self.assertEqual(self.sent(), [("LOG3", 250)])

    def test_a_missing_function_switches_reporting_off_until_restart(self):
        self.st.start()
        self.be.default = logged(2)
        self.tap()
        self.be.latency_error = BackendError("404: Could not find the function public.record_tap_latency", "http", 404)
        self.st.step()
        self.assertTrue(self.st._latency_off)
        self.be.latency_error = None
        self.tick(self.cfg.repeat_ignore_seconds + 1)
        self.be.default = logged(3)
        self.tap("CARD3")
        self.st.step(); self.st.step()
        self.assertEqual(self.sent(), [])                           # nothing queued any more
        self.assertIn(3, self.doors.unlocked)                       # and the doors are unaffected


if __name__ == "__main__":
    unittest.main()
