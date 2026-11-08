# Architecture

## Processes

```
browser ──https──▶ tunnel / proxy ──▶ nginx (127.0.0.1:80; or :80 on the LAN with --lan)
                                           ├── /      ──▶ web     (127.0.0.1:3000, Next.js)
                                           └── /ws    ──▶ engine  (127.0.0.1:3101, WebSocket)
web ──HTTP + bearer token──▶ engine
web, engine ──▶ /var/lib/zerobeat/zerobeat.db (SQLite, WAL)
engine ──TCP 4992 / UDP──▶ FlexRadio
```

- **web** renders pages and owns user-facing APIs. It checks the session and role, then
  forwards radio actions to the engine with a shared bearer token.
- **engine** owns the radio and everything that must keep running: decoding, the current
  contact, automatic operating, uploads, confirmations, QSL email, PSKReporter, backups.
  A radio outage never stops the background jobs; the radio reconnects inside the process.
- The browser's live feed is a WebSocket straight to the engine through nginx. It needs a
  60-second ticket the web app signs for a signed-in user.

## Design choices

| Choice | Why |
|---|---|
| SQLite + two systemd services running as `zerobeat` | One file to back up; nothing to tune; no root processes. |
| About seventy typed settings; runtime state in `engine_state` | The settings page shows only things an operator changes. |
| An `upload_state` row per contact and service | Per-contact retry with backoff; the reason a contact did not upload is on the row. |
| Per-row exponential backoff and a persisted per-service pause | A service that refuses the credentials is paused and reported once, not retried forever. |
| `flex/`, `digital/`, `operate/`, `services/`, `api/` modules | One owner per piece of state; testable in isolation. |
| One GUI client session to the radio | A single connection cannot disagree with itself. |
| One reconnect supervisor with backoff; last good address remembered | A radio outage never turns into a busy loop. |
| Signed short-lived WebSocket tickets | Reaching the port is not enough to watch the station. |
| Login throttle persisted, per IP and per account | Restarts do not clear lockouts; spraying across accounts is throttled. |
| Same-origin check on every browser write | CSRF defence beyond SameSite cookies. |
| Updates by `deploy/update.sh` over SSH, never from the web app | The web process can never run git or npm. |
| AD1C cty.csv bundled, refreshed weekly | DXCC works on a fresh install. |
| Every mode accepted on import; unmapped fields kept in `extras` and exported | Lossless ADIF round trip. |
| One definition of "confirmed": paper card or LoTW | |

## The engine, in order of data flow

1. `flex/radio.ts` — one SmartSDR GUI-client session: slice, DAX receive and transmit
   streams, meters. Commands reject on error. Everything it opens, it closes.
2. `flex/supervisor.ts` — keeps a session connected with backoff; discovery only when no
   address is set.
3. `digital/receiver.ts` — 24 kHz DAX audio → 12 kHz, timestamps from packet arrival
   (minimum over 10 s, gaps filled with silence), windows cut on the UTC schedule.
4. `digital/decoder.ts` — the FT8/FT4 decoder in a worker thread with a persistent
   hashed-call book.
5. `digital/sequencer.ts` — pure QSO state machine. It answers what it received, counts
   only transmissions that went out, and logs exactly once.
6. `operate/station.ts` — the current contact, automatic modes, transmit scheduling. The
   only code path that keys the radio, behind the master switch, FT-0 and the guards.
7. `services/*` — uploads, confirmations, QSL email, PSKReporter, housekeeping, backups.

## Radio facts the code depends on

- `client gui` is required to transmit; without it the radio keys with no RF and no error.
- With `send_reduced_bw_dax=1`, DAX in both directions is int16 mono at 24 kHz, packet
  class 0x0123. Verified on the AU-510, SmartSDR 4.2.20.
- `slice tune` is not echoed to the connection that sent it.
- ft8ts needs `samplesPerSymbol` set explicitly at any rate other than 12 kHz.
