import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from locker_station import backend, hardware, readers


class Fake(BaseHTTPRequestHandler):
    calls: list = []
    replies: dict = {}

    def log_message(self, *a):
        pass

    def _go(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null")
        Fake.calls.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
        status, payload = Fake.replies.get(self.path.split("?")[0], (200, {}))
        data = json.dumps(payload).encode()
        Fake.calls[-1]["headers"] = {k.lower(): v for k, v in Fake.calls[-1]["headers"].items()}
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _go


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Fake.calls, Fake.replies = [], {}

    def test_authorize_sends_card_and_station_and_new_style_key_only_in_apikey(self):
        Fake.replies["/rest/v1/rpc/authorize_card_at_station"] = (200, {"decision": "granted", "compartment_no": 3})
        b = backend.Backend(self.url, "sb_secret_x", "LRC 3F Key Locker", 2)
        out = b.authorize("04A1B2C3")
        self.assertEqual(out["compartment_no"], 3)
        c = Fake.calls[0]
        self.assertEqual(c["body"], {"p_card_uid": "04A1B2C3", "p_station_label": "LRC 3F Key Locker"})
        self.assertEqual(c["headers"]["apikey"], "sb_secret_x")
        self.assertNotIn("authorization", c["headers"])

    def test_old_style_jwt_key_goes_in_both_headers(self):
        Fake.replies["/rest/v1/rpc/record_key_return"] = (200, {"closed_transaction": True})
        b = backend.Backend(self.url, "eyJhbGciOi.x.y", "S", 2)
        b.record_key("L1", True, "2026-11-04T01:00:00+00:00")
        c = Fake.calls[0]
        self.assertEqual(c["headers"]["authorization"], "Bearer eyJhbGciOi.x.y")
        self.assertEqual(c["headers"]["apikey"], "eyJhbGciOi.x.y")
        self.assertEqual(c["body"], {"p_locker_id": "L1", "p_key_detected": True, "p_at": "2026-11-04T01:00:00+00:00"})

    def test_heartbeat_sends_the_station_label_and_the_info(self):
        Fake.replies["/rest/v1/rpc/station_heartbeat"] = (200, {"ok": True})
        b = backend.Backend(self.url, "k", "LRC 3F Key Locker", 2)
        self.assertEqual(b.heartbeat({"version": "1.1.0", "doors": [1, 2]}), {"ok": True})
        c = Fake.calls[0]
        self.assertEqual(c["method"], "POST")
        self.assertEqual(c["body"], {"p_station_label": "LRC 3F Key Locker", "p_info": {"version": "1.1.0", "doors": [1, 2]}})

    def test_record_latency_sends_the_log_id_and_whole_milliseconds(self):
        Fake.replies["/rest/v1/rpc/record_tap_latency"] = (200, None)
        b = backend.Backend(self.url, "k", "S", 2)
        b.record_latency("11111111-1111-1111-1111-111111111111", 212.7)
        self.assertEqual(Fake.calls[0]["body"], {"p_access_log_id": "11111111-1111-1111-1111-111111111111", "p_latency_ms": 212})

    def test_a_missing_function_is_an_http_error_with_its_status(self):
        Fake.replies["/rest/v1/rpc/station_heartbeat"] = (404, {"message": "Could not find the function public.station_heartbeat"})
        b = backend.Backend(self.url, "k", "S", 2)
        with self.assertRaises(backend.BackendError) as cm:
            b.heartbeat({})
        self.assertEqual((cm.exception.kind, cm.exception.status), ("http", 404))

    def test_lockers_query_is_filtered_by_station(self):
        Fake.replies["/rest/v1/lockers"] = (200, [{"id": "a", "compartment_no": 1, "rooms": {"code": "LRC-301"}}])
        b = backend.Backend(self.url, "k", "LRC 3F Key Locker", 2)
        self.assertEqual(b.lockers()[0]["rooms"]["code"], "LRC-301")
        path = Fake.calls[0]["path"]
        self.assertIn("station_label=eq.LRC+3F+Key+Locker", path.replace("%20", "+"))
        self.assertIn("is_active=eq.true", path)

    def test_http_error_carries_status_and_message(self):
        Fake.replies["/rest/v1/rpc/authorize_card_at_station"] = (404, {"message": "unknown or inactive locker station X"})
        with self.assertRaises(backend.BackendError) as cm:
            backend.Backend(self.url, "k", "X", 2).authorize("A")
        self.assertEqual((cm.exception.kind, cm.exception.status), ("http", 404))
        self.assertIn("unknown or inactive", str(cm.exception))

    def test_unreachable_is_a_network_error(self):
        with self.assertRaises(backend.BackendError) as cm:
            backend.Backend("http://127.0.0.1:1", "k", "S", 1).authorize("A")
        self.assertEqual(cm.exception.kind, "network")

    def test_unexpected_answer_shape_is_refused(self):
        Fake.replies["/rest/v1/rpc/authorize_card_at_station"] = (200, {"oops": 1})
        with self.assertRaises(backend.BackendError):
            backend.Backend(self.url, "k", "S", 2).authorize("A")


class ReaderTests(unittest.TestCase):
    def test_simulated(self):
        r = readers.SimulatedReader()
        self.assertIsNone(r.read())
        r.tap("04:a1:b2:c3")
        self.assertEqual(r.read(), "04A1B2C3")
        self.assertIsNone(r.read())

    def test_mfrc522_formats_and_checks_status(self):
        class D:
            PICC_REQIDL, MI_OK = 0x26, 0
            def __init__(self): self.present = False
            def MFRC522_Request(self, _m): return (self.MI_OK if self.present else 2, None)
            def MFRC522_Anticoll(self): return (self.MI_OK, [0x04, 0xA1, 0xB2, 0xC3, 0x00])  # 4 bytes + check byte
        d = D()
        r = readers.Mfrc522Reader("hex", driver=d)
        self.assertIsNone(r.read())
        d.present = True
        self.assertEqual(r.read(), "04A1B2C3")
        self.assertEqual(readers.Mfrc522Reader("hex_reversed", driver=d).read(), "C3B2A104")
        d.MFRC522_Anticoll = lambda: (1, [])
        self.assertIsNone(r.read())

    def test_mfrc522_seven_byte_number_is_not_cut(self):
        class D:
            PICC_REQIDL, MI_OK = 0x26, 0
            def MFRC522_Request(self, _m): return (0, None)
            def MFRC522_Anticoll(self): return (0, [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(readers.Mfrc522Reader("hex", driver=D()).read(), "01020304050607")

    def test_usb_hid_collects_keys_until_enter(self):
        class E:
            def __init__(self, code, value=1, type=1): self.code, self.value, self.type = code, value, type
        ecodes = types.SimpleNamespace(EV_KEY=1, KEY={2: "KEY_1", 3: "KEY_2", 30: "KEY_A", 28: ["KEY_ENTER", "KEY_KPENTER"], 57: "KEY_SPACE"})

        class Dev:
            def __init__(self): self.batches = []; self.ungrabbed = False
            def read(self):
                if not self.batches: raise BlockingIOError()
                return iter(self.batches.pop(0))
            def ungrab(self): self.ungrabbed = True
        dev = Dev()
        r = readers.UsbHidReader("x", device_factory=lambda _p: (dev, ecodes))
        self.assertIsNone(r.read())
        dev.batches.append([E(2), E(2, 0), E(30), E(3)])      # 1, (release ignored), A, 2
        self.assertIsNone(r.read())
        dev.batches.append([E(57), E(28)])                    # a space is ignored, Enter finishes
        self.assertEqual(r.read(), "1A2")
        dev.batches.append([E(28)])                           # a lone Enter gives nothing
        self.assertIsNone(r.read())
        r.close()
        self.assertTrue(dev.ungrabbed)


class FakeGpio:
    """Stands in for gpiozero so the pin wiring can be tested without a Raspberry Pi."""
    outputs, inputs = {}, {}

    class OutputDevice:
        def __init__(self, pin, active_high=True, initial_value=False):
            self.pin, self.active_high, self.value, self.closed = pin, active_high, initial_value, False
            FakeGpio.outputs[pin] = self
        def on(self): self.value = True
        def off(self): self.value = False
        def close(self): self.closed = True

    class DigitalInputDevice:
        def __init__(self, pin, pull_up=None):
            self.pin, self.pull_up, self.is_active, self.closed = pin, pull_up, False, False
            FakeGpio.inputs[pin] = self
        def close(self): self.closed = True


class HardwareTests(unittest.TestCase):
    def setUp(self):
        FakeGpio.outputs, FakeGpio.inputs = {}, {}
        mod = types.ModuleType("gpiozero")
        mod.OutputDevice, mod.DigitalInputDevice = FakeGpio.OutputDevice, FakeGpio.DigitalInputDevice
        sys.modules["gpiozero"] = mod
        from locker_station.config import DoorPins
        self.pins = {1: DoorPins(17, 27), 2: DoorPins(22, 23)}

    def tearDown(self):
        sys.modules.pop("gpiozero", None)

    def test_relay_starts_off_and_follows_unlock_and_lock(self):
        d = hardware.GpioDoors(self.pins, relay_active_high=False, key_present_when="closed")
        self.assertFalse(FakeGpio.outputs[17].value)
        self.assertFalse(FakeGpio.outputs[17].active_high)
        d.unlock(1)
        self.assertTrue(FakeGpio.outputs[17].value)
        self.assertFalse(FakeGpio.outputs[22].value)
        d.lock(1)
        self.assertFalse(FakeGpio.outputs[17].value)

    def test_key_present_follows_the_switch_and_the_setting(self):
        closed = hardware.GpioDoors(self.pins, True, "closed")
        FakeGpio.inputs[27].is_active = True
        self.assertTrue(closed.key_present(1))
        self.assertFalse(closed.key_present(2))
        opened = hardware.GpioDoors(self.pins, True, "open")
        FakeGpio.inputs[27].is_active = True          # a new pin object was made for this reader
        self.assertFalse(opened.key_present(1))
        self.assertTrue(opened.key_present(2))
        self.assertTrue(FakeGpio.inputs[27].pull_up)

    def test_close_locks_everything(self):
        d = hardware.GpioDoors(self.pins, True, "closed")
        d.unlock(1); d.unlock(2)
        d.close()
        self.assertTrue(all(not o.value and o.closed for o in FakeGpio.outputs.values()))

    def test_lcd_pads_trims_and_skips_repeats(self):
        class Lcd:
            def __init__(self): self.out = []
            def clear(self): self.out.append("CLR")
            def write_string(self, s): self.out.append(s)
            def crlf(self): self.out.append("CRLF")
        lcd = Lcd()
        d = hardware.LcdDisplay(cols=16, rows=2, lcd=lcd)
        d.show("Tap your ID card now please", "x")
        self.assertEqual(lcd.out, ["CLR", "Tap your ID card", "CRLF", "x" + " " * 15])
        n = len(lcd.out)
        d.show("Tap your ID card now please", "x")
        self.assertEqual(len(lcd.out), n)

    def test_simulated_doors(self):
        d = hardware.SimulatedDoors([1, 2])
        d.unlock(2)
        self.assertEqual(d.unlocked, {2})
        d.set_key(1, False)
        self.assertFalse(d.key_present(1))
        d.close()
        self.assertEqual(d.unlocked, set())


if __name__ == "__main__":
    unittest.main()
