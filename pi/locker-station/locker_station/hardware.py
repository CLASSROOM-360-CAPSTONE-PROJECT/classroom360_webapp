"""Doors (lock relay + key switch), the display and the status light and buzzer.
Real GPIO uses gpiozero, which is already on Raspberry Pi OS. Everything has a simulated twin."""
from __future__ import annotations

import sys
import threading
import time


# ---------------------------------------------------------------------------------- doors
class SimulatedDoors:
    def __init__(self, numbers):
        self.numbers = list(numbers)
        self.unlocked: set[int] = set()
        self.keys: dict[int, bool] = {n: True for n in self.numbers}  # every key starts in its door
        self.history: list[tuple[str, int]] = []

    def unlock(self, n: int) -> None:
        self.unlocked.add(n)
        self.history.append(("unlock", n))

    def lock(self, n: int) -> None:
        self.unlocked.discard(n)
        self.history.append(("lock", n))

    def key_present(self, n: int) -> bool:
        return self.keys[n]

    def set_key(self, n: int, present: bool) -> None:
        self.keys[n] = present

    def close(self) -> None:
        for n in list(self.unlocked):
            self.lock(n)


class GpioDoors:
    def __init__(self, doors, relay_active_high: bool, key_present_when: str):
        try:
            from gpiozero import DigitalInputDevice, OutputDevice  # type: ignore
        except ImportError as err:
            raise RuntimeError("gpiozero is not installed (sudo apt install python3-gpiozero)") from err
        self.numbers = sorted(doors)
        self._present_when_active = key_present_when == "closed"
        # a relay that is not energised keeps the door locked (fail-secure lock)
        self._relay = {n: OutputDevice(p.relay, active_high=relay_active_high, initial_value=False) for n, p in doors.items()}
        # pulled up: "active" means the switch is closed to ground
        self._switch = {n: DigitalInputDevice(p.switch, pull_up=True) for n, p in doors.items()}

    def unlock(self, n: int) -> None:
        self._relay[n].on()

    def lock(self, n: int) -> None:
        self._relay[n].off()

    def key_present(self, n: int) -> bool:
        closed = bool(self._switch[n].is_active)
        return closed if self._present_when_active else not closed

    def close(self) -> None:
        for r in self._relay.values():
            r.off()
            r.close()
        for s in self._switch.values():
            s.close()


# ---------------------------------------------------------------------------------- display
class ConsoleDisplay:
    def __init__(self, stream=None):
        self.stream = stream or sys.stdout
        self.last: tuple[str, str] | None = None

    def show(self, line1: str, line2: str = "") -> None:
        if (line1, line2) != self.last:
            self.last = (line1, line2)
            print(f"[display] {line1:<16.16} | {line2:<16.16}", file=self.stream, flush=True)


class NullDisplay:
    last = None

    def show(self, line1: str, line2: str = "") -> None:
        self.last = (line1, line2)


class LcdDisplay:
    """A 16 x 2 character display on I2C (the PCF8574 backpack). Needs `pip install RPLCD smbus2`."""

    def __init__(self, address: int = 0x27, cols: int = 16, rows: int = 2, lcd=None):
        self.cols, self.rows = cols, rows
        if lcd is None:
            try:
                from RPLCD.i2c import CharLCD  # type: ignore
            except ImportError as err:
                raise RuntimeError("RPLCD is not installed (pip install RPLCD smbus2) or I2C is off") from err
            lcd = CharLCD("PCF8574", address, cols=cols, rows=rows, charmap="A02")
        self.lcd = lcd
        self.last: tuple[str, str] | None = None

    def show(self, line1: str, line2: str = "") -> None:
        if (line1, line2) == self.last:
            return
        self.last = (line1, line2)
        self.lcd.clear()
        self.lcd.write_string(line1[: self.cols].ljust(self.cols))
        if self.rows > 1:
            self.lcd.crlf()
            self.lcd.write_string(line2[: self.cols].ljust(self.cols))

    def close(self) -> None:
        try:
            self.lcd.clear()
        except Exception:
            pass


# ---------------------------------------------------------------------------------- light and sound
class NullIndicators:
    def __init__(self):
        self.events: list[str] = []

    def ok(self) -> None:
        self.events.append("ok")

    def denied(self) -> None:
        self.events.append("denied")

    def error(self) -> None:
        self.events.append("error")

    def close(self) -> None:
        pass


class GpioIndicators:
    """A two-colour LED (green and red pins) and a buzzer. Any of the three may be missing."""

    def __init__(self, green: int | None, red: int | None, buzzer: int | None):
        try:
            from gpiozero import LED, Buzzer  # type: ignore
        except ImportError as err:
            raise RuntimeError("gpiozero is not installed (sudo apt install python3-gpiozero)") from err
        self.green = LED(green) if green is not None else None
        self.red = LED(red) if red is not None else None
        self.buzzer = Buzzer(buzzer) if buzzer is not None else None
        self._lock = threading.Lock()

    def _pulse(self, led, beeps: list[float], light: float) -> None:
        def run():
            with self._lock:
                if led:
                    led.on()
                for i, d in enumerate(beeps):
                    if self.buzzer:
                        self.buzzer.on()
                    time.sleep(d)
                    if self.buzzer:
                        self.buzzer.off()
                    if i < len(beeps) - 1:
                        time.sleep(0.12)
                time.sleep(max(0.0, light - sum(beeps)))
                if led:
                    led.off()
        threading.Thread(target=run, daemon=True).start()

    def ok(self) -> None:
        self._pulse(self.green, [0.12], 1.5)

    def denied(self) -> None:
        self._pulse(self.red, [0.4, 0.4], 2.0)

    def error(self) -> None:
        self._pulse(self.red, [0.8], 2.0)

    def close(self) -> None:
        for d in (self.green, self.red, self.buzzer):
            if d:
                d.close()
