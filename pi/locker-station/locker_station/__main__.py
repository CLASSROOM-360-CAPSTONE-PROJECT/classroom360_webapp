"""Command line:

    python3 -m locker_station run                 run the station (what the service does)
    python3 -m locker_station run --simulate      no hardware: type card numbers and key changes on the keyboard
    python3 -m locker_station check               read the settings and ask the database about this station
    python3 -m locker_station check-card          show what a tapped card looks like in every number style
    python3 -m locker_station test-doors          click each lock once and show the key switches
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config as config_mod
from .backend import Backend, BackendError
from .controller import Station
from .hardware import (ConsoleDisplay, GpioDoors, GpioIndicators, LcdDisplay, NullDisplay, NullIndicators,
                       SimulatedDoors)
from .readers import SimulatedReader, make_reader
from .spool import Spool
from .uid import FORMATS, format_uid, normalize

DEFAULT_CONFIG = os.environ.get("CLASSROOM360_LOCKER_CONFIG", "/etc/classroom360/locker.json")
log = logging.getLogger("locker")


def make_event_logger(path: str):
    p = Path(path)

    def events(kind: str, **fields) -> None:
        rec = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": kind, **fields}
        log.info("%s %s", kind, json.dumps(fields, default=str))
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            if p.exists() and p.stat().st_size > 2_000_000:   # keep it from growing without end
                p.replace(p.with_suffix(p.suffix + ".1"))
            with p.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, default=str) + "\n")
        except OSError:
            pass
    return events


def build_hardware(cfg, simulate: bool):
    if simulate:
        return SimulatedReader(), SimulatedDoors(sorted(cfg.doors)), ConsoleDisplay(), NullIndicators()
    reader = make_reader(cfg)
    doors = GpioDoors(cfg.doors, cfg.relay_active_high, cfg.key_present_when)
    if cfg.display_type == "lcd_i2c":
        display = LcdDisplay(cfg.display_address, cfg.display_cols, cfg.display_rows)
    elif cfg.display_type == "console":
        display = ConsoleDisplay()
    else:
        display = NullDisplay()
    if cfg.led_green is None and cfg.led_red is None and cfg.buzzer is None:
        ind = NullIndicators()
    else:
        ind = GpioIndicators(cfg.led_green, cfg.led_red, cfg.buzzer)
    return reader, doors, display, ind


def make_backend(cfg) -> Backend:
    return Backend(cfg.supabase_url, cfg.service_key, cfg.station_label, cfg.request_timeout)


def _stdin_commands(reader: SimulatedReader, doors: SimulatedDoors, stop: threading.Event) -> None:
    print("Simulation. Type a card number to tap it, 'key 3 out' or 'key 3 in' to move a key, 'quit' to stop.", flush=True)
    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        if parts[0] in ("quit", "exit"):
            break
        if parts[0] == "key" and len(parts) == 3 and parts[1].isdigit() and parts[2] in ("in", "out"):
            n = int(parts[1])
            if n in doors.keys:
                doors.set_key(n, parts[2] == "in")
                print(f"[key {n} {parts[2]}]", flush=True)
            else:
                print(f"no door {n}", flush=True)
            continue
        reader.tap(parts[-1] if parts[0] == "tap" else parts[0])
    stop.set()


def cmd_run(args) -> int:
    cfg = config_mod.load(args.config)
    reader, doors, display, ind = build_hardware(cfg, args.simulate)
    station = Station(cfg, make_backend(cfg), reader, doors, display, ind, Spool(cfg.spool_file),
                      events=make_event_logger(cfg.event_log))
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    if args.simulate:
        threading.Thread(target=_stdin_commands, args=(reader, doors, stop), daemon=True).start()
    try:
        station.run(stop)
    finally:
        for part in (reader, doors, ind):
            try:
                part.close()
            except Exception:
                pass
        if hasattr(display, "close"):
            display.close()
    return 0


def cmd_check(args) -> int:
    cfg = config_mod.load(args.config)
    print(f"Station: {cfg.station_label}")
    print(f"Database: {cfg.supabase_url}")
    print(f"Doors in the settings: {', '.join(str(n) for n in sorted(cfg.doors))}")
    backend = make_backend(cfg)
    try:
        rows = backend.lockers()
    except BackendError as err:
        print(f"CANNOT READ THE DOORS: {err}")
        if err.status in (401, 403):
            print("  -> the key is wrong or not the secret/service_role key")
        return 1
    if not rows:
        print(f"CANNOT FIND '{cfg.station_label}' in the database. The name must match the Lockers page exactly.")
        return 1
    known = {r["compartment_no"]: r for r in rows}
    ok = True
    for n in sorted(set(known) | set(cfg.doors)):
        r = known.get(n)
        wired = n in cfg.doors
        room = ((r or {}).get("rooms") or {}).get("code", "")
        mark = "ok " if r and wired else "!! "
        if not (r and wired):
            ok = False
        print(f"  {mark}door {n}: {'room ' + room if r else 'not in the database'}; {'wired' if wired else 'NOT in the settings'}")
    try:
        status = backend.key_status()
        print("Keys: " + ", ".join(f"door {s['compartment_no']} {s['key_status']}" for s in sorted(status, key=lambda s: s['compartment_no'])))
    except BackendError as err:
        print(f"Cannot read the key status: {err}")
        ok = False
    print("All good." if ok else "Fix the lines marked !! above.")
    return 0 if ok else 1


def cmd_check_card(args) -> int:
    cfg = config_mod.load(args.config)
    reader = make_reader(cfg)
    print("Tap a card (Ctrl-C to stop). Compare with the number your card shows on the web app's Key cards form.", flush=True)
    seen = ""
    try:
        while True:
            uid = reader.read()
            if uid and uid != seen:
                seen = uid
                print(f"\nread as configured ({cfg.uid_format}): {uid}")
                try:
                    data = bytes.fromhex(uid) if len(uid) % 2 == 0 else None
                except ValueError:
                    data = None
                if data:
                    for fmt in FORMATS:
                        print(f"  {fmt:<13} {normalize(format_uid(data, fmt))}")
                print("Set reader.uid_format to the style that matches the web app's number.", flush=True)
            elif not uid:
                seen = ""
            time.sleep(0.1)
    except KeyboardInterrupt:
        return 0
    finally:
        reader.close()


def cmd_test_doors(args) -> int:
    cfg = config_mod.load(args.config)
    doors = GpioDoors(cfg.doors, cfg.relay_active_high, cfg.key_present_when)
    try:
        for n in sorted(cfg.doors):
            print(f"Door {n}: key switch says the key is {'IN' if doors.key_present(n) else 'OUT'}. Clicking the lock for 1 second...", flush=True)
            doors.unlock(n)
            time.sleep(1.0)
            doors.lock(n)
            time.sleep(0.3)
        print("Done. If a door did not click, check its relay wire and relay_active_high.")
    finally:
        doors.close()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="locker_station", description="Classroom360 key locker station")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help=f"settings file (default {DEFAULT_CONFIG})")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the station")
    r.add_argument("--simulate", action="store_true", help="no hardware: use the keyboard")
    sub.add_parser("check", help="check the settings against the database")
    sub.add_parser("check-card", help="show what a tapped card looks like")
    sub.add_parser("test-doors", help="click each lock once")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    try:
        return {"run": cmd_run, "check": cmd_check, "check-card": cmd_check_card, "test-doors": cmd_test_doors}[args.cmd](args)
    except config_mod.ConfigError as err:
        print(f"Settings problem: {err}", file=sys.stderr)
        return 2
    except RuntimeError as err:
        print(f"Hardware problem: {err}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
