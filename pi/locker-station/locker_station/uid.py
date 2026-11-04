"""Card numbers. The database compares them exactly, so the station must send them the way the
web app stored them: capital letters and digits only (the Key cards form cleans what you type)."""
from __future__ import annotations

import re

_NOT_ALNUM = re.compile(r"[^0-9A-Za-z]")

FORMATS = ("hex", "hex_reversed", "decimal", "decimal_be")


def normalize(raw: str) -> str:
    """'04:a1:b2:c3' -> '04A1B2C3'. The same cleaning the database applies when a card is saved."""
    return _NOT_ALNUM.sub("", raw or "").upper()


def format_uid(data: bytes, fmt: str = "hex") -> str:
    """The card's serial number as text, in the style your USB reader (or the web form) shows it.

    hex           04A1B2C3         bytes in reading order (what an MFRC522 reports)
    hex_reversed  C3B2A104         the same bytes, last first
    decimal       3283886340       10 digits, bytes read as a little-endian number (many USB readers)
    decimal_be    0079147715       10 digits, bytes read as a big-endian number
    Use `python3 -m locker_station check-card` to see what a real card looks like on your reader.
    """
    if not data:
        raise ValueError("empty card number")
    if fmt == "hex":
        return data.hex().upper()
    if fmt == "hex_reversed":
        return data[::-1].hex().upper()
    if fmt == "decimal":
        return str(int.from_bytes(data, "little")).zfill(10)
    if fmt == "decimal_be":
        return str(int.from_bytes(data, "big")).zfill(10)
    raise ValueError(f"unknown uid_format {fmt!r}; choose one of {', '.join(FORMATS)}")
