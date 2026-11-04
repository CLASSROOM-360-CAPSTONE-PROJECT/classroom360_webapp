"""Card readers. Each has read() which returns a card number (already formatted and cleaned) or None
right away, so the main loop keeps watching the key switches between taps."""
from __future__ import annotations

import queue
from typing import Protocol

from .uid import format_uid, normalize


class Reader(Protocol):
    def read(self) -> str | None: ...
    def close(self) -> None: ...


class SimulatedReader:
    """Card numbers pushed from a test or typed on the keyboard (see __main__ --simulate)."""

    def __init__(self):
        self._q: queue.Queue[str] = queue.Queue()

    def tap(self, raw: str) -> None:
        self._q.put(raw)

    def read(self) -> str | None:
        try:
            uid = normalize(self._q.get_nowait())
        except queue.Empty:
            return None
        return uid or None

    def close(self) -> None:
        pass


class Mfrc522Reader:
    """The MFRC522 module on the SPI bus (the reader on the locker's interface board).
    Needs `pip install mfrc522` (installs spidev and RPi.GPIO) and SPI switched on with raspi-config."""

    def __init__(self, uid_format: str = "hex", rst_pin: int = 25, driver=None):
        self.fmt = uid_format
        if driver is None:
            try:
                from mfrc522 import MFRC522  # type: ignore
            except ImportError as err:
                raise RuntimeError("the mfrc522 package is not installed (pip install mfrc522) or SPI is off") from err
            try:
                driver = MFRC522(pin_rst=rst_pin)
            except TypeError:  # older versions of the package take no argument
                driver = MFRC522()
        self.d = driver

    def read(self) -> str | None:
        status, _tag = self.d.MFRC522_Request(self.d.PICC_REQIDL)
        if status != self.d.MI_OK:
            return None
        status, uid = self.d.MFRC522_Anticoll()
        if status != self.d.MI_OK or not uid:
            return None
        data = bytes(uid[:4]) if len(uid) == 5 else bytes(uid)  # a 4-byte number is followed by a check byte
        return normalize(format_uid(data, self.fmt)) or None

    def close(self) -> None:
        try:
            import RPi.GPIO as GPIO  # type: ignore
            GPIO.cleanup()
        except Exception:
            pass


class UsbHidReader:
    """A USB card reader that types the number like a keyboard. The keys are read straight from its
    device file and grabbed, so nothing is typed into the Pi's console. Needs `pip install evdev`."""

    _KEYS = {**{f"KEY_{d}": d for d in "0123456789"}, **{f"KEY_{c}": c for c in "ABCDEF"}, **{f"KEY_KP{d}": d for d in "0123456789"}}

    def __init__(self, device: str, device_factory=None):
        if device_factory is None:
            try:
                import evdev  # type: ignore
            except ImportError as err:
                raise RuntimeError("the evdev package is not installed (pip install evdev)") from err
            self._ecodes = evdev.ecodes
            dev = evdev.InputDevice(device)
            dev.grab()
        else:
            dev, self._ecodes = device_factory(device)
        self.dev = dev
        self._buf = ""

    def read(self) -> str | None:
        try:
            events = list(self.dev.read())
        except BlockingIOError:
            return None
        for e in events:
            if e.type != self._ecodes.EV_KEY or e.value != 1:  # key presses only
                continue
            name = self._ecodes.KEY.get(e.code)
            name = name[0] if isinstance(name, (list, tuple)) else name
            if name in ("KEY_ENTER", "KEY_KPENTER"):
                uid, self._buf = normalize(self._buf), ""
                if uid:
                    return uid
            elif name in self._KEYS:
                self._buf += self._KEYS[name]
        return None

    def close(self) -> None:
        try:
            self.dev.ungrab()
        except Exception:
            pass


def make_reader(cfg) -> Reader:
    if cfg.reader_type == "simulated":
        return SimulatedReader()
    if cfg.reader_type == "usb_hid":
        return UsbHidReader(cfg.reader_device)
    return Mfrc522Reader(cfg.uid_format, cfg.reader_rst_pin)
