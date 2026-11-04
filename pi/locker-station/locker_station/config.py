"""Settings, read from a JSON file. Secrets are NOT in the file: the service key comes from the
environment (SUPABASE_SERVICE_KEY), normally set by /etc/classroom360/locker.env."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .uid import FORMATS


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class DoorPins:
    relay: int
    switch: int


@dataclass(frozen=True)
class Config:
    supabase_url: str
    service_key: str
    station_label: str
    doors: dict[int, DoorPins]
    reader_type: str = "mfrc522"            # mfrc522 | usb_hid | simulated
    uid_format: str = "hex"
    reader_device: str = ""                 # usb_hid: /dev/input/by-id/...-event-kbd
    reader_rst_pin: int = 25                # mfrc522
    relay_active_high: bool = False         # most relay boards switch on when the pin goes LOW
    key_present_when: str = "closed"        # closed | open: the state of the micro-switch when a key is seated
    unlock_seconds: float = 5.0
    confirm_ms: int = 300                   # a key switch must hold its new state this long before it counts
    message_seconds: float = 4.0
    repeat_ignore_seconds: float = 3.0      # a card held on the reader is read once
    request_timeout: float = 6.0
    display_type: str = "lcd_i2c"           # lcd_i2c | console | none
    display_address: int = 0x27
    display_cols: int = 16
    display_rows: int = 2
    led_green: int | None = None
    led_red: int | None = None
    buzzer: int | None = None
    spool_file: str = "/var/lib/classroom360/locker-spool.jsonl"
    lockers_cache: str = "/var/lib/classroom360/lockers.json"
    event_log: str = "/var/log/classroom360/locker-events.jsonl"
    extra: dict = field(default_factory=dict)


def _int(value, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ConfigError(f"{name} must be a whole number from {lo} to {hi}")
    return value


def parse(raw: dict, env: dict | None = None) -> Config:
    env = os.environ if env is None else env
    if not isinstance(raw, dict):
        raise ConfigError("the settings file must hold a JSON object")

    url = str(raw.get("supabase_url") or env.get("SUPABASE_URL", "")).strip().rstrip("/")
    if not re.fullmatch(r"https?://[^/\s?#@]+", url):
        raise ConfigError("supabase_url must look like https://your-project.supabase.co")
    key = str(env.get("SUPABASE_SERVICE_KEY", "")).strip()
    if not key:
        raise ConfigError("SUPABASE_SERVICE_KEY is not set (put it in /etc/classroom360/locker.env, never in the settings file)")
    if "service_key" in raw:
        raise ConfigError("the service key must not be in the settings file; set SUPABASE_SERVICE_KEY instead")
    label = str(raw.get("station_label", "")).strip()
    if not label:
        raise ConfigError("station_label is required: the name shown on the Lockers page, for example 'LRC 3F Key Locker'")

    doors_raw = raw.get("doors")
    if not isinstance(doors_raw, dict) or not doors_raw:
        raise ConfigError("doors must list each compartment, for example {\"1\": {\"relay\": 17, \"switch\": 27}}")
    doors: dict[int, DoorPins] = {}
    for k, v in doors_raw.items():
        if not re.fullmatch(r"[1-9][0-9]?", str(k)):
            raise ConfigError(f"door number {k!r} must be 1, 2, 3, ...")
        if not isinstance(v, dict):
            raise ConfigError(f"door {k} needs relay and switch pins")
        doors[int(k)] = DoorPins(_int(v.get("relay"), f"door {k} relay", 0, 40), _int(v.get("switch"), f"door {k} switch", 0, 40))
    pins = [p for d in doors.values() for p in (d.relay, d.switch)]
    if len(set(pins)) != len(pins):
        raise ConfigError("two doors share a pin; every relay and switch needs its own")

    reader = raw.get("reader") or {}
    rtype = str(reader.get("type", "mfrc522"))
    if rtype not in ("mfrc522", "usb_hid", "simulated"):
        raise ConfigError("reader.type must be mfrc522, usb_hid or simulated")
    fmt = str(reader.get("uid_format", "hex"))
    if fmt not in FORMATS:
        raise ConfigError(f"reader.uid_format must be one of {', '.join(FORMATS)}")
    if rtype == "usb_hid" and not reader.get("device"):
        raise ConfigError("reader.device is required for usb_hid (for example /dev/input/by-id/usb-...-event-kbd)")

    when = str(raw.get("key_present_when", "closed"))
    if when not in ("closed", "open"):
        raise ConfigError("key_present_when must be closed or open")

    disp = raw.get("display") or {}
    dtype = str(disp.get("type", "lcd_i2c"))
    if dtype not in ("lcd_i2c", "console", "none"):
        raise ConfigError("display.type must be lcd_i2c, console or none")
    addr = disp.get("address", 0x27)
    if isinstance(addr, str):
        try:
            addr = int(addr, 0)
        except ValueError:
            raise ConfigError("display.address must be like 0x27") from None
    ind = raw.get("indicators") or {}

    def opt_pin(name):
        v = ind.get(name)
        return None if v is None else _int(v, f"indicators.{name}", 0, 40)

    unlock = float(raw.get("unlock_seconds", 5))
    if not 1 <= unlock <= 30:
        raise ConfigError("unlock_seconds must be between 1 and 30")
    confirm = _int(raw.get("confirm_ms", 300), "confirm_ms", 20, 5000)

    paths = raw.get("files") or {}
    d = Config.__dataclass_fields__
    return Config(
        supabase_url=url, service_key=key, station_label=label, doors=doors,
        reader_type=rtype, uid_format=fmt, reader_device=str(reader.get("device", "")),
        reader_rst_pin=_int(reader.get("rst_pin", 25), "reader.rst_pin", 0, 40),
        relay_active_high=bool(raw.get("relay_active_high", False)), key_present_when=when,
        unlock_seconds=unlock, confirm_ms=confirm,
        display_type=dtype, display_address=int(addr), display_cols=_int(disp.get("cols", 16), "display.cols", 8, 40),
        display_rows=_int(disp.get("rows", 2), "display.rows", 1, 4),
        led_green=opt_pin("green"), led_red=opt_pin("red"), buzzer=opt_pin("buzzer"),
        spool_file=str(paths.get("spool", d["spool_file"].default)),
        lockers_cache=str(paths.get("lockers_cache", d["lockers_cache"].default)),
        event_log=str(paths.get("event_log", d["event_log"].default)),
    )


def load(path: str | os.PathLike, env: dict | None = None) -> Config:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"settings file not found: {path}") from None
    except json.JSONDecodeError as err:
        raise ConfigError(f"the settings file is not valid JSON ({err})") from None
    return parse(raw, env)
