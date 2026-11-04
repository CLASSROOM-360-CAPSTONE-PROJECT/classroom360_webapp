# Camera gateway (the parent Raspberry Pi)

This Pi sits on the school network next to the CCTV cameras. It pulls each camera's picture and offers it to the Classroom360 web page as a live WebRTC picture. Before it sends a single frame it checks that the person watching is signed in to Classroom360 as an **administrator or a dean**.

```
 IP camera (RTSP, H.264) ──┐
 Pi camera module ─────────┼─► MediaMTX (port 8889) ──WebRTC──► Cameras page in the browser
                           │        │ asks first
                           │        ▼
                           │   camera_auth.py (this Pi only, port 9120) ──► Supabase: "may this person see this camera?"
```

Nothing is recorded. The Pi does not run the person detector: the browser that is showing the picture does.

## What you need

- A Raspberry Pi (3 or newer is plenty for a handful of cameras; it only relays, it does not re-encode) with Raspberry Pi OS and `python3` (already included), on the same network as the cameras and the computers that will watch.
- Your Supabase project address (`https://xxxx.supabase.co`) and its **publishable (anon) key**. Never put the secret/service key on this Pi.
- The cameras' RTSP addresses (ask whoever installed the CCTV; see "Finding a camera's address").
- The Classroom360 database already updated with file 9 (`20261104000009_cameras_and_presence.sql`).

## Install

Copy this folder to the Pi (a USB stick or `scp -r pi/camera-gateway pi@<address>:`), then on the Pi:

```bash
cd camera-gateway
sudo bash install.sh https://YOUR-PROJECT.supabase.co YOUR_PUBLISHABLE_KEY
```

The script downloads MediaMTX 1.21.0 for your Pi's processor, **checks its checksum**, installs two services (`classroom360-mediamtx` and `classroom360-camera-auth`), starts them on every boot and prints the address to type into the web app. Run it again any time to update; your edited settings are kept.

## Add your cameras

Edit `/etc/classroom360/mediamtx.yml` (`sudo nano /etc/classroom360/mediamtx.yml`) and add one block per camera under `paths:`:

```yaml
paths:
  lrc-301:
    source: rtsp://camera-user:camera-password@192.168.1.60:554/stream2
    rtspTransport: tcp
    sourceOnDemand: yes
    sourceOnDemandCloseAfter: 20s
```

Then `sudo systemctl restart classroom360-mediamtx`.

- **Use the camera's H.264 stream.** Most browsers cannot play H.265/HEVC. In the camera's own settings choose H.264 for the sub stream (a smaller picture such as 640 x 360 or 1280 x 720 is also easier on the Pi and the network, and is plenty for counting people).
- `sourceOnDemand: yes` connects to the camera only while someone is watching.
- The camera's user name and password live only in this file (readable by root and the `classroom360` service user, not by other users).
- **A Pi camera module** on this Pi: use `source: rpiCamera` (MediaMTX has it built in; add `rpiCameraWidth: 1280`, `rpiCameraHeight: 720`, `rpiCameraFPS: 15`). If that does not suit your Pi, publish with ffmpeg instead: give the path `source: publisher` and run `rpicam-vid -t 0 --inline --codec h264 --width 1280 --height 720 --framerate 15 -o - | ffmpeg -loglevel error -f h264 -i - -c copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/lrc-302`. Only programs on the Pi may publish. (These two options were not tried on real camera hardware.)

### Finding a camera's address

It usually looks like `rtsp://user:password@IP:554/something`. Common endings: Hikvision `/Streaming/Channels/102`, Dahua `/cam/realmonitor?channel=1&subtype=1`, many others `/stream2` or `/h264`. Check the camera's manual, or test it on any computer with VLC: Media, Open Network Stream.

## Connect the web app

In Classroom360, sign in as an administrator, open **Cameras**, choose **Add camera** and enter:

| Field | Value |
| --- | --- |
| Room | the room this camera watches |
| Gateway address | `http://<the Pi's address>:8889`, for example `http://192.168.1.50:8889` |
| Stream name | the name from `mediamtx.yml`, for example `lrc-301` |

Give the Pi a fixed address (a DHCP reservation in the router) so this does not change.

If the Pi has a firewall, open **8889/tcp** and **8189/udp and tcp** (WebRTC). If the Pi has several network addresses, uncomment `webrtcAdditionalHosts` in `mediamtx.yml` and list the one the classrooms' computers use.

### https

A web page served over **https** (a deployed site) is not allowed to talk to an **http** gateway on another computer. Either open Classroom360 over http inside the school network (`npm run dev`, or any http host), or put the gateway behind https: MediaMTX can serve https itself (`webrtcEncryption: yes`, `webrtcServerKey`, `webrtcServerCert`), or put a reverse proxy such as Caddy in front of port 8889. The page tells the person when this is what is blocking.

## Check that it works

```bash
systemctl status classroom360-mediamtx classroom360-camera-auth
journalctl -u classroom360-camera-auth -f          # one line per person who asks to watch: ALLOW or DENY, never the token
curl http://127.0.0.1:9120/health                  # ok
```

| What the Cameras page says | Likely cause |
| --- | --- |
| The camera gateway could not be reached | wrong gateway address, the Pi is off, a firewall, or an http gateway on an https page |
| The camera gateway did not accept your sign-in | not an administrator or dean, the stream name is not registered in Cameras (or the camera is switched off), the Pi cannot reach Supabase, or the sign-in expired (sign in again) |
| The camera gateway has no stream with this name | the stream name on the Cameras page is not in `mediamtx.yml` under `paths:` (spelling, capitals): add it, or fix the name on the page. MediaMTX says this before it checks who is watching |
| This camera is not sending video right now | the stream name is in `mediamtx.yml`, but the camera is off or its address or password is wrong: run `journalctl -u classroom360-mediamtx` |
| The picture arrives but stays black | the camera is sending H.265; switch it to H.264 |
| No picture arrived | the browser cannot reach 8189 (firewall), or the Pi has several addresses (`webrtcAdditionalHosts`) |

## How access is decided

For every viewer, MediaMTX asks `camera_auth.py`, which asks Supabase `GET /rest/v1/cameras?stream_path=eq.<name>&is_active=eq.true` **with the viewer's own sign-in token**. The database's row-level security returns the row only to an administrator or dean of that school, so the Pi cannot be more generous than the database. A "yes" is remembered for 60 seconds and a "no" for 5. If Supabase cannot be reached the answer is no. Only WebRTC viewing is allowed: the management interface, metrics, playback, HLS, RTMP and SRT are off, and RTSP listens on the Pi itself only.

## Tests

```bash
python3 -I -m unittest discover -s tests -v
```

21 tests with a stand-in Supabase: the right people get a yes; odd stream names never reach the database; the cache; a database outage means no; the token never reaches the log.
