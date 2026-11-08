# Zerobeat

A self-hosted digital-mode hub for ham radio: your rig, every digital mode, any browser.
FT8, FT4, FT2, JTTY, RTTY, PSK31, CW, Hellschreiber, SSTV, WSPR and JS8 on a FlexRadio, a
networked ICOM or any Hamlib rig, shared by several operators with their own calls and logs,
automatic operating with safety brakes, and a logbook that uploads to QRZ, LoTW, eQSL, Club
Log, World Radio League and N3FJP. One SQLite file, two small services, a web
page. No Docker, no database server, no PM2.

See [docs/architecture.md](docs/architecture.md) for how it is
put together and [docs/operations.md](docs/operations.md) for running it day to day.

## What it does

- **Operate.** Live decoding from the radio, a WebGL waterfall (2D, spectrogram, 3D) that
  also draws your own transmission, click a CQ to answer it, full automatic QSO
  sequencing, and automatic CQ, hunt, POTA hunt and POTA chase with band hopping and an
  operating schedule. Safety brakes for SWR, PA temperature, a deaf receiver, no RF out,
  run time and contact count; FT-0 stops everything and releases the radio.
- **Radio time.** Operators book time on the shared radio; while they are signed in during
  it the radio is theirs (docs/independent-users.md).
- **Modes.** FT8, FT4, FT2 (Decodium's) and JTTY (WSJT-X 3.2's keyboard mode, with signal
  subtraction); RTTY, PSK31 and CW with a keyboard, function keys and a band-wide signal
  browser; Hellschreiber (Feld Hell, FSK Hell 105/245, Hell 80, Slow Hell, Hell x5/x9, with the mode at the marker recognised) printed on a tape you read
  by eye; SSTV (Martin, Scottie, Robot, PD) with a gallery and picture sending; WSPR
  beacons with WSPRnet uploads; JS8 (JS8Call's network: directed queries, heartbeats,
  automatic replies, store-and-forward messages).
- **Contests and DXpeditions.** WW Digi, ARRL Digi, Field Day and RTTY Roundup exchanges
  with Cabrillo export; Hound mode for FT8 DXpeditions.
- **Spots.** A DX cluster node and the Reverse Beacon Network, read-only: needed stations
  alert from any band, one click to tune.
- **Radios.** FlexRadio 6000/8000/Aurora over the network (SmartSDR API and DAX, no
  SmartSDR needed on a PC). ICOM IC-7300MK2, IC-7300, IC-705 and IC-9700 over the radio's
  own network server or USB. Any other radio Hamlib supports (Yaesu, Kenwood, Elecraft,
  Xiegu and many more) through rigctld and the radio's sound card.
- **Logbook.** Search, edit, manual entry with live callsign lookup (QRZ or HamDB), DXCC
  from the bundled AD1C cty.csv (refreshed weekly), dupe warnings, POTA references
  including n-fers, ADIF import and export that keeps every field.
- **Awards.** DXCC, WAS, WAZ, WAC, grids and POTA parks with a band matrix.
- **Services.** QRZ Logbook, LoTW (signs .tq8 itself from your TQSL certificate), eQSL,
  Club Log, World Radio League and N3FJP, through a per-contact queue with backoff;
  confirmations downloaded every six hours; PSKReporter spotting and "heard by".
- **Other programs.** A UDP feed in the WSJT-X protocol for GridTracker, Log4OM and N1MM
  Logger+, plus plain ADIF datagrams.
- **QSL.** Emailed QSL cards with your artwork, queued for approval or sent automatically.
- **Admin.** Users with roles (viewer, operator, admin), API keys, nightly backups, push
  notifications to your phone (needs HTTPS, so `--tunnel`), a morning summary.

## Requirements

- A Debian 12 or 13 machine (a VM or LXC container is fine; a fresh Debian 13 install was
  tested end to end on 2026-11-07; Ubuntu 24.04 should work but is not tested). 2 CPU cores and 2 GB of memory; decoding FT8 takes about a second a
  window on two cores. x86-64; ARM (a Raspberry Pi 5) is untested.
- On the same network as the radio. FlexRadio: TCP 4992 and the DAX UDP streams. ICOM over
  the network: UDP 50001–50003. ICOM over USB: the radio plugged in (or passed through).
- An accurate clock. The installer sets up chrony; FT8 needs the clock within about half
  a second.

## Install

As root on the new machine:

```bash
apt-get install -y git
git clone https://github.com/W9ML/Zerobeat.git /opt/zerobeat
bash /opt/zerobeat/deploy/install.sh --lan
```

If the repository is private to you, `git clone` asks for your GitHub username and a
token (a fine-grained personal access token with read-only **Contents** access to this
repository). So that `update.sh` can pull later without asking, store it once:

```bash
git -C /opt/zerobeat config credential.helper store
git -C /opt/zerobeat fetch    # enter the username and token one last time
```

The installer pulls in Node.js 22 and nginx, creates a `zerobeat` system user, writes
`/etc/zerobeat/zerobeat.env` with fresh random keys, builds, and starts two services.
It takes a few minutes. Then open the address it prints, `http://<this machine>/`, and
the first page creates the administrator and your station.

Choose how the page is reached:

| | |
|---|---|
| `--lan` | nginx listens on port 80 on every interface. Plain HTTP, so passwords cross your LAN unencrypted: fine at home, never forward the port from the internet. |
| `--tunnel` | nginx listens on loopback only. Put Cloudflare Tunnel, Tailscale or another reverse proxy with HTTPS in front of `http://127.0.0.1:80`. This is the way to reach it from away from home. |

Running it again is safe: it never replaces the environment file or the database, and
`--lan` / `--tunnel` switches between the two.

**Back up `ZEROBEAT_SECRET_KEY`** from `/etc/zerobeat/zerobeat.env`. It encrypts every
password, API key and the LoTW certificate stored in the database; a database restored
without it has to have every credential entered again.

### Then, in the web page

1. **Settings → Radio**: FlexRadio or ICOM, and its address (the Flex is found by broadcast
   if you leave it blank). See [docs/operations.md](docs/operations.md#radio) for the
   settings the radio itself needs, especially DATA MOD on an ICOM.
2. **Settings → Station**: callsign, grid, power.
3. **Logbook services**: the services you use. LoTW wants your TQSL `.p12` uploaded on
   the Services page.
4. Import your existing log on **Import / export** (ADIF).
5. On **Operate**, turn **TX on** when you are ready to transmit. Transmit is off after
   install and after every FT-0.

## Update

```bash
bash /opt/zerobeat/deploy/update.sh
```

It backs up the database, pulls the latest commit from the repository you cloned, builds,
applies migrations, restarts and checks health.

## Uninstall

```bash
systemctl disable --now zerobeat-engine zerobeat-web
rm -f /etc/systemd/system/zerobeat-*.service /etc/nginx/sites-enabled/zerobeat /etc/nginx/sites-available/zerobeat
systemctl daemon-reload && systemctl reload nginx
# Your data, kept until you remove it: /var/lib/zerobeat and /etc/zerobeat
```

## Development

```bash
npm install
npm test              # vitest: core and engine
npm run typecheck
cp deploy/zerobeat.env.example .env.engine.dev   # fill in the two keys and local paths
npx tsx --env-file=.env.engine.dev packages/engine/src/main.ts
npm -w apps/web run dev
```

| Path | |
|---|---|
| `packages/core` | Database schema, settings, auth, DXCC, ADIF, logbook, awards, service adapters, QSL. Shared by both processes. |
| `packages/engine` | The radio process: radio drivers, receiver and decoders, QSO sequencer, JTTY, automatic operating, background jobs, API and WebSocket on 127.0.0.1:3101. |
| `apps/web` | Next.js 16 web app on 127.0.0.1:3000. |
| `deploy` | Installer, systemd units, nginx site, build and update scripts. |
| `scripts` | Database migration and icon generation. |

## License and credits

Zerobeat's own code is GPL-3.0-or-later; see [LICENSE](LICENSE). It includes
`@e04/ft8ts`, licensed GPL-3.0 without "or later", so the app as distributed is under
GPL-3.0. [THIRD_PARTY.md](THIRD_PARTY.md) lists every ported part with its authors and license.

- FT8 and FT4 coding: [@e04/ft8ts](https://github.com/e04/ft8ts) (GPL-3.0), a port of WSJT-X.
- JTTY: written from the protocol design notes and Fortran in the WSJT-X source
  (`lib/jtty/`, GPL-3.0, by the WSJT Development Group), and checked against WSJT-X's own
  sample recording, which is included as a test fixture
  (`packages/engine/test/fixtures/jtty_260807_134110.wav`).
- FT2: Decodium by IU8LMC.
- ICOM network protocol: following the wfview and kappanhang projects, whose packet layouts
  and credential scrambling table it uses (interoperating needs them exactly).
- DXCC data: AD1C's [country files](https://www.country-files.com/).
- RTTY, PSK31 and CW: Baudot and varicode tables, and the RTTY and PSK designs, from
  [fldigi](https://sourceforge.net/projects/fldigi/) (GPL-3.0, W1HKJ and contributors).
- WSPR: a port of K1JT and K9AN's `wsprd` from the WSJT-X source (GPL-3.0), including
  Phil Karn KA9Q's Fano sequential decoder, checked against WSJT-X's sample recording.
- JS8: a port of [JS8Call](https://github.com/js8call/js8call) by KN4CRD and the JS8Call
  team (GPL-3.0): the modem, framing, varicode and JSC compression dictionary (generated
  from JSC_map.cpp and JSC_list.cpp). Checked against JS8Call's own sample recordings,
  included as test fixtures (`packages/engine/test/fixtures/js8/`).
- Hound mode follows WSJT-X's Fox and Hound rules. SuperFox is not supported: its
  decoder in WSJT-X is licensed only for use with WSJT-X.
