# Locker station (the Raspberry Pi inside the key locker)

The program that runs the four-door key locker in the LRC 3rd floor: it reads an instructor's ID card, asks the
database whether that person may have a key right now, unlocks the right door, and reports when the key is put
back. All decisions are made in the database (`authorize_card_at_station`, which uses `authorize_key_request`, and
`record_key_return`). This program only reads, unlocks, shows and reports, so it can be small.

```
 ID card ─► MFRC522 reader ─┐                          ┌─► Supabase (database decides)
                            ├─► locker_station ◄──────►┤
 key switch x4 ────────────►┘     │   │   │            └─► access log, key status, Lockers page
                                  │   │   └─► 16x2 display, LED, buzzer
                                  │   └─► relay x4 ─► 12 V locks
                                  └─► waiting list on disk (when the network is down)
```

## What happens at the locker

| What you do | What the station does |
|---|---|
| Tap a card with a class (or an approved room request) in one of the four rooms now (up to the grace period before and after) | The database picks that room's door, writes one line in the access log, and the station unlocks only that door for 5 seconds. The screen says "Take the key" and the room. |
| Tap again while you are holding a key | The door of that key opens so you can put it back ("Put key back"). Nothing is written in the access log for this; the key counts as returned only when its switch feels the key. It works after the class and after the grace period too. |
| Put the key back | The key switch must hold its new state for 0.3 seconds (contact bounce is ignored). Then the station tells the database, which closes the issue and shows the key as available, and the door locks at once. |
| Tap a card that is not registered, switched off, or has no class now | Nothing opens. The screen says why in a few words, the red light and two beeps show it, and the database logs the attempt (including an unknown card's number, so an administrator can register it). |
| The internet or the database is down | **Nothing opens** (the doors cannot be opened offline) and the screen says "No connection". A key that is put back meanwhile is remembered on the card (`/var/lib/classroom360/locker-spool.jsonl`) and sent, in order, with the time it really went back. |
| A key is removed from a locked door | Written in the local event log (`key_out`, `door_was_unlocked: false`). The database is not told, because a key that is out is already recorded when it was issued. |
| Every minute | The station tells the database it is alive (program version, doors, how many key events are waiting, how long it has been running). The Dashboard and the Lockers page show it online; after three minutes of silence they raise an alert. A failed report is only logged: the doors do not care. |
| Every tap | The time from the card number arriving to the door unlocking (or the refusal showing) is measured and sent a moment later, in a quiet moment, so it never delays a tap. The Evaluation page uses it for the 500 ms target. A tap that only returns a key has no log line and is not timed. The wait of up to 50 ms before the program next looks at the reader is not counted. |
| The station restarts (power cut) | All doors lock. Keys already back in their doors close any issue still open for them. |

Screen messages: "Take the key", "Put key back", "Card not registered", "Card is switched off", "No class right now",
"Your class is in another room", "Key is already taken", "No connection". The idle screen says OFFLINE when the last
call to the database failed.

## What you need

- Raspberry Pi 3, 4, 5 or Zero 2 W with Raspberry Pi OS (the installer assumes `apt` and `python3`)
- MFRC522 RFID reader (13.56 MHz cards) **or** a USB card reader that types the number like a keyboard
- 4-channel relay board, four 12 V electric locks that release when powered, a 12 V adapter, a 1N4007 diode across each lock coil (as in the circuit of the proposal)
- Four micro-switches (one lever switch in each compartment, pressed by a seated key)
- 16x2 LCD with the I2C backpack (PCF8574), optional; a red/green LED and a buzzer, optional

### Wiring (BCM pin numbers; the defaults in `config.example.json`)

| Part | Pin(s) |
|---|---|
| MFRC522 | 3.3 V, GND, SDA/SS = GPIO8 (CE0), SCK = GPIO11, MOSI = GPIO10, MISO = GPIO9, RST = GPIO25 |
| LCD (I2C) | SDA = GPIO2, SCL = GPIO3, 5 V, GND (address 0x27; `i2cdetect -y 1` shows it) |
| Relay inputs | door 1 = GPIO17, door 2 = GPIO27, door 3 = GPIO22, door 4 = GPIO23 (relay board powered from 5 V; the 12 V lock supply goes only through the relay contacts) |
| Key switches | door 1 = GPIO5, door 2 = GPIO6, door 3 = GPIO13, door 4 = GPIO19, each between the pin and GND (the program turns on the pin's pull-up) |
| Green LED / red LED / buzzer | GPIO20 / GPIO21 / GPIO26 (330 ohm resistor in series with each LED) |

Door numbers 1 to 4 are the door numbers on the web app's **Set up doors** screen. The program assumes the lock is
**released while the relay is on** (the usual 12 V bolt) and stays locked without power. Most relay boards switch on
when the input goes low, which is the default (`"relay_active_high": false`). Set it to `true` if yours switches on when the input goes high. If the key switches read the
wrong way round (the screen thinks a key is out when it is in), set `"key_present_when": "open"`.

## Set it up

1. **Database.** Run migration `20261105000010_station_card_tap.sql` (file 10) in the Supabase SQL editor. The doors must already exist (**Lockers > Set up doors**); note the name of the locker there. The station finds its doors by that exact name.
2. **Raspberry Pi.** Switch on SPI and I2C (`sudo raspi-config` > Interface Options), copy this folder to the Pi, then:

   ```
   cd locker-station
   sudo bash install.sh https://YOUR-PROJECT.supabase.co
   ```

   It asks for the project's **secret** key and saves it only in `/etc/classroom360/locker.env` (readable by root and the service). Supabase lets you make several secret keys: make one just for this Pi, so you can switch it off alone if the Pi is ever lost. The installer refuses the publishable key and any key that is not the service role. It is safe to run again; it keeps your settings.
3. **Settings.** Edit `/etc/classroom360/locker.json`: `station_label` must be the locker's name exactly as on the Lockers page (the seed uses `LRC 3F Key Locker`). Check the pins against your wiring.
4. **Card numbers must match.** The web app stores the number your USB reader types (for example `0012345678`); the MFRC522 reports the card's bytes (for example `04A1B2C3`). Put one registered card on the reader:

   ```
   sudo -u classroom360 env $(cat /etc/classroom360/locker.env) /opt/classroom360/locker-venv/bin/python -m locker_station --config /etc/classroom360/locker.json check-card
   ```

   It prints the number in every style the program knows (`hex`, `hex_reversed`, `decimal`, `decimal_be`). Set `reader.uid_format` to the style that equals the number shown on the **Key cards** form for the same card. Or register new cards by typing the `hex` number into the form.
5. **Check, then start.**

   ```
   sudo -u classroom360 env $(cat /etc/classroom360/locker.env) /opt/classroom360/locker-venv/bin/python -m locker_station --config /etc/classroom360/locker.json check
   sudo -u classroom360 ... test-doors        # clicks each lock once and prints each key switch
   sudo systemctl start classroom360-locker
   ```

   `check` lists the four doors and their rooms from the database next to the doors in your settings and marks any mismatch with `!!`. Logs: `journalctl -u classroom360-locker -f`, and one JSON line per event in `/var/log/classroom360/locker-events.jsonl`.

### Try it without any hardware

```
SUPABASE_SERVICE_KEY=... python3 -m locker_station --config my.json run --simulate
```

Type a card number to tap it, `key 3 out` or `key 3 in` to move a key, `quit` to stop. The screen is printed. It still talks to the real database, so use a scratch project.

## Safety rules the code keeps

- A door is unlocked only for a granted tap or a return, for 5 seconds (1 to 30 in the settings), and every door is locked at start, at stop and after a crash restart.
- Any error (no network, a wrong key, an unexpected answer, an unknown door number) means **nothing opens**.
- A card held on the reader counts once; a second tap needs the card to be taken away for 3 seconds.
- The secret key is never in the settings file (the program refuses to start if it is), never in a log, and with the new `sb_secret_` keys it is sent only in the `apikey` header.
- The service runs as its own user with no login, writes only to its own folders, and has no privileges beyond that.
- The secret key can read and write everything in the project. Anyone who can open the locker's electronics can read it from the Pi. Keep the Pi inside the locked enclosure and switch the key off in Supabase if the Pi is ever lost.

## Tests

```
python3 -I -m unittest discover -s tests -t .      # 79 tests, about half a second, no hardware
```

They cover the card-number styles, the settings, the HTTP calls, the readers and the GPIO wiring (with stand-ins for the hardware), the heartbeat (at start, every minute, never in the pass that handles a card, a dead network marks the station offline, a refusal from the database is only logged) and the tap times (measured with a fake clock, one sent per quiet pass, bounded, a missing function switches it off), and the controller with a fake clock: unlock timing, a card held on the reader, contact bounce, every denial message, no connection (nothing opens), keys put back offline and sent later in order, a refused event that must not block the queue, a wrong secret key kept for later, the return tap, a restart with keys already back.

**Tested for real:** the program against a live PostgREST and PostgreSQL 16 with all eleven migrations, through a stand-in for Supabase's key gateway (44 checks): a granted tap, the return tap, the key coming back, unknown and unscheduled cards, the network going down and coming back, a wrong key, an old-style JWT key, an anon key refused, the heartbeat reaching the station view, every tap's response time reaching the access log, and a database without migration 11 (the station still starts and opens doors; the two reports switch off).

The program needs database update 11 (`supabase/migrations/20261106000011_evaluation_alerts_station_health.sql`) for the heartbeat and the tap times. Without it the station works as before and the web app shows it as "not connected yet".

**Not tested:** the real MFRC522, LCD, relays, locks and switches. Nothing here has run on a Raspberry Pi. The hardware code is a thin layer over `gpiozero`, `mfrc522`, `RPLCD` and `evdev`; expect to adjust pins, `relay_active_high`, `key_present_when` and `uid_format` on the first day. On a Raspberry Pi 5 the installer swaps RPi.GPIO for `rpi-lgpio` (untested).
