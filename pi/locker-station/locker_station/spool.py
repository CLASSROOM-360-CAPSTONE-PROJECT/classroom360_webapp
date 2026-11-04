"""Key events wait here until the database has them, so a network outage loses nothing.
One JSON object per line; rewritten atomically."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable


class Spool:
    def __init__(self, path: str, max_items: int = 10_000):
        self.path = Path(path)
        self.max_items = max_items
        self._lock = threading.Lock()
        self._items: list[dict] = []
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    item = json.loads(line)
                    if isinstance(item, dict):
                        self._items.append(item)
                except ValueError:
                    pass  # a half-written last line after a power cut
        except FileNotFoundError:
            pass

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def add(self, item: dict) -> None:
        with self._lock:
            self._items.append(item)
            if len(self._items) > self.max_items:  # keep the newest; the oldest are the least useful
                self._items = self._items[-self.max_items:]
            self._save()

    def flush(self, send: Callable[[dict], None]) -> int:
        """Sends in order. Stops at the first failure (kept for next time). Returns how many were sent."""
        sent = 0
        while True:
            with self._lock:
                if not self._items:
                    return sent
                item = self._items[0]
            try:
                send(item)
            except Exception:
                return sent
            with self._lock:
                if self._items and self._items[0] is item:
                    self._items.pop(0)
                    self._save()
            sent += 1

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text("".join(json.dumps(i) + "\n" for i in self._items), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            pass  # the in-memory queue still works; a full disk must not stop the locker
