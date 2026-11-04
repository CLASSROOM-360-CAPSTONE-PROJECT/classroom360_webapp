import json
import os
import tempfile
import unittest
from pathlib import Path

from locker_station import config, spool, uid

ENV = {"SUPABASE_SERVICE_KEY": "sb_secret_abc"}
BASE = {
    "supabase_url": "https://abc.supabase.co/",
    "station_label": "LRC 3F Key Locker",
    "doors": {"1": {"relay": 17, "switch": 27}, "2": {"relay": 22, "switch": 23}},
}


class UidTests(unittest.TestCase):
    def test_normalize_matches_what_the_web_form_stores(self):
        self.assertEqual(uid.normalize("04:a1:b2:c3"), "04A1B2C3")
        self.assertEqual(uid.normalize(" 04-a1 b2c3\n"), "04A1B2C3")
        self.assertEqual(uid.normalize(""), "")
        self.assertEqual(uid.normalize(None), "")

    def test_formats(self):
        data = bytes.fromhex("04A1B2C3")
        self.assertEqual(uid.format_uid(data, "hex"), "04A1B2C3")
        self.assertEqual(uid.format_uid(data, "hex_reversed"), "C3B2A104")
        self.assertEqual(uid.format_uid(data, "decimal"), str(0xC3B2A104).zfill(10))
        self.assertEqual(uid.format_uid(data, "decimal_be"), str(0x04A1B2C3).zfill(10))
        self.assertEqual(len(uid.format_uid(bytes.fromhex("01020304"), "decimal")), 10)

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            uid.format_uid(b"", "hex")
        with self.assertRaises(ValueError):
            uid.format_uid(b"\x01", "base64")


class ConfigTests(unittest.TestCase):
    def test_minimal(self):
        c = config.parse(dict(BASE), ENV)
        self.assertEqual(c.supabase_url, "https://abc.supabase.co")
        self.assertEqual(c.station_label, "LRC 3F Key Locker")
        self.assertEqual(sorted(c.doors), [1, 2])
        self.assertEqual(c.doors[1].relay, 17)
        self.assertFalse(c.relay_active_high)
        self.assertEqual(c.reader_type, "mfrc522")
        self.assertEqual(c.unlock_seconds, 5.0)

    def test_service_key_only_from_environment(self):
        with self.assertRaises(config.ConfigError):
            config.parse(dict(BASE), {})
        with self.assertRaises(config.ConfigError) as cm:
            config.parse({**BASE, "service_key": "x"}, ENV)
        self.assertIn("must not be in the settings file", str(cm.exception))

    def test_required_fields(self):
        for key in ("station_label", "doors", "supabase_url"):
            raw = dict(BASE)
            del raw[key]
            with self.assertRaises(config.ConfigError, msg=key):
                config.parse(raw, ENV)

    def test_pin_problems(self):
        shared = {**BASE, "doors": {"1": {"relay": 17, "switch": 27}, "2": {"relay": 17, "switch": 23}}}
        with self.assertRaises(config.ConfigError) as cm:
            config.parse(shared, ENV)
        self.assertIn("share a pin", str(cm.exception))
        with self.assertRaises(config.ConfigError):
            config.parse({**BASE, "doors": {"1": {"relay": 99, "switch": 27}}}, ENV)
        with self.assertRaises(config.ConfigError):
            config.parse({**BASE, "doors": {"zero": {"relay": 1, "switch": 2}}}, ENV)
        with self.assertRaises(config.ConfigError):
            config.parse({**BASE, "doors": {"1": {"relay": True, "switch": 2}}}, ENV)

    def test_options(self):
        c = config.parse({**BASE, "reader": {"type": "usb_hid", "device": "/dev/input/event0", "uid_format": "decimal"},
                          "display": {"type": "lcd_i2c", "address": "0x3f"}, "indicators": {"green": 5, "red": 6, "buzzer": 13},
                          "unlock_seconds": 8, "key_present_when": "open", "relay_active_high": True,
                          "files": {"spool": "/tmp/s.jsonl"}}, ENV)
        self.assertEqual((c.reader_type, c.uid_format, c.display_address), ("usb_hid", "decimal", 0x3F))
        self.assertEqual((c.led_green, c.led_red, c.buzzer), (5, 6, 13))
        self.assertTrue(c.relay_active_high)
        self.assertEqual(c.key_present_when, "open")
        self.assertEqual(c.spool_file, "/tmp/s.jsonl")

    def test_option_problems(self):
        for extra in ({"reader": {"type": "usb_hid"}}, {"reader": {"type": "ps2"}}, {"reader": {"uid_format": "base64"}},
                      {"unlock_seconds": 0}, {"unlock_seconds": 99}, {"key_present_when": "maybe"}, {"display": {"type": "oled"}},
                      {"confirm_ms": 1}):
            with self.assertRaises(config.ConfigError, msg=str(extra)):
                config.parse({**BASE, **extra}, ENV)

    def test_load(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps(BASE))
            self.assertEqual(config.load(p, ENV).station_label, "LRC 3F Key Locker")
            p.write_text("{nope")
            with self.assertRaises(config.ConfigError):
                config.load(p, ENV)
            with self.assertRaises(config.ConfigError):
                config.load(Path(d) / "missing.json", ENV)


class SpoolTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "sub", "spool.jsonl")

    def tearDown(self):
        self.dir.cleanup()

    def test_survives_restart_and_keeps_order(self):
        s = spool.Spool(self.path)
        for i in range(3):
            s.add({"n": i})
        again = spool.Spool(self.path)
        self.assertEqual(len(again), 3)
        got = []
        self.assertEqual(again.flush(got.append), 3)
        self.assertEqual([g["n"] for g in got], [0, 1, 2])
        self.assertEqual(len(spool.Spool(self.path)), 0)

    def test_stops_at_first_failure_and_keeps_the_rest(self):
        s = spool.Spool(self.path)
        for i in range(4):
            s.add({"n": i})
        seen = []

        def send(item):
            if item["n"] == 2:
                raise OSError("down")
            seen.append(item["n"])
        self.assertEqual(s.flush(send), 2)
        self.assertEqual(seen, [0, 1])
        self.assertEqual(len(s), 2)
        self.assertEqual(len(spool.Spool(self.path)), 2)
        rest = []
        self.assertEqual(s.flush(rest.append), 2)
        self.assertEqual([r["n"] for r in rest], [2, 3])

    def test_half_written_last_line_is_ignored(self):
        os.makedirs(os.path.dirname(self.path))
        Path(self.path).write_text('{"n": 1}\n{"n": 2}\n{"n": ')
        self.assertEqual(len(spool.Spool(self.path)), 2)

    def test_limit_keeps_the_newest(self):
        s = spool.Spool(self.path, max_items=3)
        for i in range(6):
            s.add({"n": i})
        got = []
        s.flush(got.append)
        self.assertEqual([g["n"] for g in got], [3, 4, 5])

    def test_unwritable_disk_does_not_raise(self):
        s = spool.Spool("/proc/definitely/not/writable.jsonl")
        s.add({"n": 1})
        self.assertEqual(len(s), 1)


if __name__ == "__main__":
    unittest.main()
