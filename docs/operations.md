# Operations

## Where things are

| | |
|---|---|
| Code | `/opt/zerobeat` (a git checkout; `update.sh` pulls from its `origin`) |
| Data | `/var/lib/zerobeat` — `zerobeat.db`, `qsl/card.png`, `backups/`, `cty.csv` |
| Secrets | `/etc/zerobeat/zerobeat.env` (root:zerobeat, 640) |
| Services | `zerobeat-engine`, `zerobeat-web`, `nginx` (and `cloudflared` or another proxy with `--tunnel`) |
| nginx site | `/etc/nginx/sites-available/zerobeat`, written by `install.sh` from `deploy/nginx/zerobeat.conf`; your own extra server blocks go in `/etc/nginx/conf.d/` |
| Logs | `journalctl -u zerobeat-engine -f`, `journalctl -u zerobeat-web -f` |

`ZEROBEAT_SECRET_KEY` in the env file decrypts every stored credential and the LoTW key.
Keep a copy somewhere other than this machine.

## Update

```bash
bash /opt/zerobeat/deploy/update.sh
```

It backs up the database, pulls `origin/main`, builds, migrates and restarts, then checks
health. Local changes in `/opt/zerobeat` are discarded; settings live in the database and
`/etc/zerobeat`, not in the checkout.

## How the page is reached

`install.sh --lan` has nginx listen on port 80 on every interface, plain HTTP. Logins work
(the session cookie follows the scheme), but phone push notifications need HTTPS, so they
only work with `--tunnel`. `install.sh --tunnel` listens on loopback only and expects
Cloudflare Tunnel, Tailscale Serve or another HTTPS reverse proxy on the same machine,
pointed at `http://127.0.0.1:80`. Re-run `install.sh` with the other option to switch.

Set **Settings → General → Public URL** to the address people use, so QSL emails and
notifications link to the right place.

## Health

```bash
curl -s http://127.0.0.1/api/health
```

## Backup and restore

The engine writes `backups/zerobeat-YYYY-MM-DD.db` nightly and keeps fourteen;
Settings → Backup downloads one on demand. To restore:

```bash
systemctl stop zerobeat-web zerobeat-engine
cp /var/lib/zerobeat/backups/zerobeat-2026-10-20.db /var/lib/zerobeat/zerobeat.db
rm -f /var/lib/zerobeat/zerobeat.db-wal /var/lib/zerobeat/zerobeat.db-shm
chown zerobeat:zerobeat /var/lib/zerobeat/zerobeat.db
systemctl start zerobeat-engine zerobeat-web
```

## Locked out

```bash
cd /opt/zerobeat && set -a && . /etc/zerobeat/zerobeat.env && set +a
node --import tsx -e '
  const { openDb } = await import("./packages/core/src/db/client.ts");
  const { hashPassword } = await import("./packages/core/src/auth/password.ts");
  const { sqlite } = openDb();
  sqlite.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(await hashPassword(process.argv[1]), process.argv[2]);
  sqlite.prepare("DELETE FROM login_attempts").run();
' 'new-password-here' you@example.com
```

## Radio

### FlexRadio

The engine connects as a SmartSDR GUI client named Zerobeat and takes one slice. The
AU-510 allows two GUI clients, so SmartSDR on a PC plus Zerobeat is the limit. Leave
"FlexRadio address" blank to find the radio by broadcast; the last address that worked is
remembered either way.

### ICOM over the network (IC-7300MK2 and family)

Settings → Radio → Radio: "ICOM", ICOM connection: "Network". The engine logs in to the
radio's built-in LAN server the way ICOM's RS-BA1 and wfview do: CI-V and 48 kHz audio
both ways over three UDP streams. Nothing is installed or passed through.

On the radio:

- Menu → Set → Network: Network Control **ON**, a fixed address (or a DHCP reservation),
  and **Network User1** ID and password. Put those in Settings → Radio.
- Menu → Set → Connectors → MOD Input → **DATA MOD: LAN**, LAN MOD Level about 50 % to
  start, then adjust for no ALC. The engine warns at connect if DATA MOD is anything else.
- Wired Ethernet. The audio is about 100 kB/s each way and does not tolerate Wi-Fi loss well.

The radio accepts one network session at a time. If the engine was killed without hanging
up, the radio can refuse it for a minute or two; it retries on its own.

ICOM's protocol only scrambles the password and does not encrypt anything. Keep the radio
on the LAN and never forward ports 50001-50003 from the internet.

### ICOM over USB

Settings → Radio → Radio: "ICOM", ICOM connection: "USB". The radio has to be plugged
into the machine the engine runs on; for the VM that means Proxmox USB passthrough of the
radio (its "USB Audio CODEC" and serial ports are one USB device), then:

    bash /opt/zerobeat/deploy/enable-local-radio.sh

That installs alsa-utils and a systemd drop-in giving the engine the serial ports and
sound cards (the engine otherwise runs with a private /dev). It prints the serial ports
and sound cards it can see.

On the radio, Menu → Set → Connectors:

- CI-V → CI-V USB Port: **Unlink from [REMOTE]**, CI-V USB Baud Rate: **115200**
- CI-V → CI-V Transceive: ON, so turning the knob shows up at once (it is also polled)
- MOD Input → **DATA MOD: USB**, USB MOD Level about 50 % to start, then adjust for no ALC
- CI-V address: B6 for the IC-7300MK2 (94 IC-7300, A4 IC-705, A2 IC-9700)

The engine puts the radio in USB-D, keys it over CI-V, plays audio through the USB sound
card, and reads the power and SWR meters during every transmission, so the no-RF check
works the same as on the Flex, over USB or the network.

### Any other radio, through Hamlib

Settings → Radio → Radio: "Other radio, through Hamlib". Hamlib's rigctld does the radio
control (frequency, mode, PTT, power and SWR meters, the tuner) for hundreds of models;
audio goes through the radio's USB sound card or an interface such as a SignaLink.

With the radio plugged into this machine:

    bash /opt/zerobeat/deploy/enable-local-radio.sh
    rigctl -l | grep -i 991        # find the model number

Put the model number, serial port, CAT baud rate and sound card in Settings → Radio; the
engine starts rigctld itself. To use a rigctld you already run (on another machine, or
shared with another program), set the model to 0 and give its address and port.

On the radio: CAT on the USB or serial port at the baud rate you set, and the data mode's
audio input set to the rear/USB port (the Yaesu "DATA MODE: OTHERS" / "PSK" menus, the
Kenwood "DATA VOX off, USB audio" menus). The engine asks for USB with the data input
(Hamlib's PKTUSB); a radio without one is put in USB, so keep its microphone gain down.

Tested against Hamlib 4.6.2's rigctld; not yet on a real radio through it.

## FT2

FT2 is Decodium's fast mode (IU8LMC): FT4's waveform at twice the speed, 3.75 s slots,
about -12 dB sensitivity. The engine decodes it with the FT4 decoder at half speed.
Calling frequencies follow Decodium (14.084 MHz on 20 m). WSJT-X Improved has a
different, incompatible mode also called FT2; this is not that one. LoTW gets FT2
contacts as DATA until TQSL knows the mode.

## JTTY

JTTY is WSJT-X 3.2's keyboard mode: 4-GFSK at 31.25 baud, 1.888 s frames that each carry
one call, report, exchange or five characters, with a CRC-12 and a K=10 convolutional
code. It is untimed: a message goes out the moment you send it. The modem follows the
design notes that ship with the WSJT-X source (lib/jtty/) and decodes WSJT-X's own sample
recording exactly (packages/engine/test/fixtures/jtty_260807_134110.wav).

Pick JTTY in the mode buttons, or tune a JTTY calling frequency (14.090 MHz on 20 m; on
30 m and 17 m it shares FT4's frequency, and the mode you are in is kept). While JTTY is
on, the slotted decoder rests and automatic operating is off; the receiver listens from
200 to 3000 Hz all the time. Your receive and transmit frequency is the TX marker: click
the waterfall or a line under Band activity to move there.

The keyboard sends what you type when you press Enter, up to 80 characters (16 frames).
F1–F8 send WSJT-X's function keys: CQ, report and exchange, TU and CQ, your call, their
call, TU and the next in the queue, AGN?, and the exchange. %M is your call, %H theirs,
%Q the next in the queue and %E "599" plus your exchange; they work in typed text too. Esc,
or Halt TX, stops a message on the air. The exchange is a serial number unless you set
one; Field Day sends class and section, RTTY Roundup a serial or state.

Strong and weak signals at once: each decoded frame is re-encoded and subtracted from the
audio, and the residual is searched again, reaching back three quarter-frames, the way
WSJT-X does it (subtract_jtty.f90). SNR is in 2500 Hz with a -17 dB floor, as WSJT-X shows it.

Log contact writes MODE JTTY, as WSJT-X does, with the conversation as the transcript and
the exchanges in the notes, and moves the serial on. LoTW gets JTTY as DATA. World Radio
League may refuse JTTY contacts until it adds the mode; they stay queued with the error.

## RTTY, PSK31 and CW

Pick RTTY, PSK or CW in the mode buttons. They share JTTY's panel: the conversation at
your frequency on top, everything else heard on the band below (like fldigi's signal
browser, up to 16 signals at once, each found by its spectrum), the keyboard and eight
function keys. These modes are tuned freely: moving the dial keeps the mode.

- **RTTY**: 45.45 baud, 170 Hz shift, Baudot with US figures. The marker is the center
  of the two tones; mark is the higher one, which on USB is the normal sense, so there
  is no reverse switch. Decodes cleanly to about -3 dB in 2500 Hz.
- **PSK31**: BPSK at 31.25 baud with G3PLX's varicode (lower case is shorter to send).
  The receiver pulls in a signal up to 30 Hz off the marker. Decodes cleanly to about
  -9 dB.
- **CW**: sent as a keyed tone at the marker, with 5 ms shaped edges, so it is an
  ordinary CW signal at dial + tone; set the speed on the panel. The decoder follows the
  sender's speed from 5 to 50 WPM; it copies machine-sent CW well and steady hand-sent
  CW fairly. Prosigns are written <AR>, <SK>, <BT>, <KN>.

Function keys use %M (your call), %H (theirs), %Q (next in the queue), %X (the exchange)
and %E ("599" and the exchange). Log contact writes MODE RTTY, CW, or PSK with
SUBMODE PSK31.

## Hell (Hellschreiber)

Pick Hell in the mode buttons. Hell is not decoded: each character goes out as a grid of
dots, 7 columns of 14, every column sent bottom to top as an on/off keyed carrier, and
the receiver prints what it hears at the marker onto a tape you read by eye. That is why
it copies through noise and fading that would stop a decoder.

- **The tape** prints each column twice high, the way the old two-turn helix did, and
  lines each received line up on its own text, so it prints as two whole copies however
  the sender's timing sits against ours. Text that slopes means the other station's
  clock is a little off. Your own messages print in the accent colour. Size and Contrast
  are under the tape (raise the contrast to clean noise off the paper, lower it to dig
  out a weak signal).
- **At the marker**, above the tape, says what is there, once a second: which Hell mode
  (and whether it is reversed), CW, or a signal that isn't Hell or is too weak to tell,
  with its centre frequency. When it is a Hell mode other than the one set, **Switch to**
  sets it; when the signal's centre is 10 Hz or more off the marker, **Move the marker**
  puts it there. It works by printing the audio at every speed at once and seeing which
  print is text, so it needs a few seconds of sending (Slow Hell, about 20). A CW station
  on the marker prints as fat sloping bars; 14.063 MHz is in the CW end of 20 m.
- **Speed and kind**, in the menu on the panel (rates as fldigi's):
  - Feld Hell: on/off keyed, 2.5 characters a second, about 350 Hz wide; the classic,
    used on the EU nets.
  - FSK Hell 105 (FSKH105) and FSK Hell 245 (FSKH245): Feld Hell's speed, but the carrier
    never drops; ink is a tone half the shift below the marker, paper half the shift
    above (55 Hz apart in FSKH105, 122.5 Hz in FSKH245). The Feld Hell Club's North
    American nets run FSKH105 at dial + 1500 Hz, so put the marker at 1500. The receiver
    follows the centre between the tones, so a few hertz off still prints evenly.
    **Reverse** swaps the tones, sending and printing, for a station that prints as a
    negative.
  - Hell 80: two tones 300 Hz apart, twice Feld Hell's speed; Reverse works the same.
  - Slow Hell (an eighth of Feld Hell's speed, about 30 Hz wide), Hell x5 and Hell x9.

  A message may key for 3 minutes at most.
- **Frequencies**: the Feld Hell Club's list, 160 m to 6 m. The club gives the signal
  on the waterfall (dial + 1500 Hz), so the band buttons set the dial 1.5 kHz below,
  for example 40 m: dial 7.0805, signal 7.082 with the marker at 1500 Hz. Their nets
  move around; check the club's Nets page. Tune anywhere and the mode stays.

## Your own band frequencies

Click the dial readout to type a frequency. In the freely tuned modes (RTTY, PSK, CW,
Hell, SSTV), "Save as my 40m Hell frequency" under the dial makes the band button go
there from then on, for you only; "use the built-in" puts it back. FT8 and the other
channelised modes keep their fixed frequencies.
- The font is Zerobeat's own 5×7 dot matrix: capitals, figures and common punctuation,
  with a pixel of paper above and below each letter so the two printed copies don't touch.

The contact card and function keys work as in the other keyboard modes. Log contact
writes MODE HELL (SUBMODE FSKHELL for FSK Hell; HELL80, SLOWHELL, HELLX5 or HELLX9 at those speeds).

## Hound (FT8 DXpedition mode)

Working a DXpedition that runs WSJT-X's Fox mode: Zerobeat follows WSJT-X's Hound
rules, calling at 1000 Hz or above, answering the Fox's report on the Fox's own
frequency, sending repeats 300 Hz away from it, logging on the Fox's RR73 and sending no
73, and giving up after about 11 periods. It switches on by itself for a station heard
sending the Fox's two-station messages ("K1ABC RR73; W9XYZ <FOX> -12"), or for every
call with the Hound switch in the Automatic card.

SuperFox (WSJT-X 2.7 and later) is not supported: its decoder's code tables are licensed
only for use in WSJT-X. Use WSJT-X itself for a SuperFox DXpedition.

## Contests

The Automatic card's contest picker turns on WSJT-X's contest messages:

| Contest | Exchange | CQ |
|---|---|---|
| WW Digi DX | your 4-character grid | CQ WW |
| ARRL Digi | your 4-character grid | CQ TEST |
| ARRL Field Day | class and section, e.g. 1D WI | CQ FD |
| ARRL RTTY Roundup (FT8/FT4) | 5x9 and state or province; a serial for DX | CQ RU |

The first call carries the exchange, their R and exchange gets RR73 and the log, and
their RR73 ends it with no 73. Each contact is logged with CONTEST_ID, STX_STRING and
SRX_STRING (and CLASS, ARRL_SECT, STATE or SRX), and Import / export writes a Cabrillo
3.0 log for the sponsor.

## DX cluster and Reverse Beacon Network

Settings → Logbook services → DX cluster and RBN. Both are telnet services: the station
logs in with its callsign and only reads spots; it never posts. The RBN's FT8/FT4 feed
(port 7001) and CW/RTTY feed (port 7000) report skimmers worldwide, including the ones
hearing you, which the Spots card shows highlighted. A spot of a station the log needs
(the same rule as the needed-station alerts) raises the alert from any band, with a Tune
button that goes there in the spot's mode.

## SSTV

Pick SSTV. The receiver watches for a VIS header (it names the mode, and its leader
measures how far off tune the sender is), then draws the picture as it arrives and
corrects slant from the line syncs at the end. Martin 1/2, Scottie 1/2/DX, Robot 36/72
and PD 90/120/160/180/240 are supported. Pictures are kept in /var/lib/zerobeat/sstv
(the newest 300) and shown in the gallery.

To send, choose a picture, a mode and the text to write across the bottom (your call by
default); the server crops it to the mode's size. A picture is one long transmission,
about 2 minutes for Martin 1 and 3 for PD 180, so check the radio's transmit timeout
allows it.

## WSPR

Pick WSPR. The radio goes to the band's WSPR frequency and listens in two-minute
periods starting on the even minute; each period is decoded 114 s in, on its own thread,
and the stations heard are listed with distance. Settings → Logbook services → WSPR and
WSPRnet sets what share of periods to transmit in (0 is receive only; at 25 % and below
periods are picked the way WSJT-X picks them, so stations do not collide every time),
the power you report, and whether spots go to WSPRnet. Spots are kept a day per file in
/var/lib/zerobeat/wspr.

A WSPR transmission is 110.6 s of steady carrier. Turn the power down: 5 W is plenty.

## JS8

Pick JS8. The radio goes to JS8Call's frequency for the band (14.078 MHz on 20 m) and
decodes every period: 15 s for Normal, 10 Fast, 6 Turbo, 30 Slow (Settings → Operating →
JS8). Frames at the same offset in following periods are joined into messages, shown as
band activity; click one to follow that station and move your transmit offset to it.

Type a message and Send: it goes out one frame per period, starting with the call it is
for (`W1AW SNR?`, `@ALLCALL CQ CQ`); your call is put in front for you. The buttons fill
in JS8Call's directed commands. HB sends a heartbeat in the 500-1000 Hz heartbeat
sub-band; "send a heartbeat every" repeats it.

With "Answer queries automatically" on (and transmit on), the station answers what JS8Call
answers: SNR?, GRID?, INFO?, STATUS?, HEARING?, QUERY MSGS and QUERY MSG n, AGN?, and
heartbeats when "acknowledge heartbeats" is on. A MSG for you is checked against its
checksum, stored in the inbox and acknowledged; a MSG TO: for another station is held
and handed over when that station asks with QUERY MSGS. The inbox is kept in
/var/lib/zerobeat/js8/inbox.json. Log a contact from the card on the right (MFSK, submode
JS8).

## UDP feed (GridTracker, Log4OM, N1MM Logger+)

Settings → Logbook services → "UDP feed to other programs": host:port of each listener,
comma separated, for example `192.168.0.50:2237`. The feed is the WSJT-X network
protocol: status, every decode, and each logged contact (QSO Logged and Logged ADIF).
Add `adif` after a destination to send a plain ADIF record per contact instead.

"Let those programs start contacts and stop transmitting" accepts Reply (double-click a
CQ in GridTracker) and Halt Tx. It is off by default and only believes datagrams from the
addresses in the list.

## World Radio League

Settings → Logbook services: the API key from WRL (Integrations → Developer API, starts
with `wrl_live_`), optionally a logbook ID, and "Upload new contacts to World Radio
League". Services → "Check World Radio League key" confirms the key and says which
logbook contacts land in, listing the IDs when there is no default. WRL keeps duplicates
rather than refusing them, so before resending a contact whose earlier attempt failed in
transit, the engine looks for it first.
