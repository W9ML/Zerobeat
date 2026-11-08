# Independent users

Every user is their own station: their own callsign on the air, their own logbook, their
own settings and service accounts. They share one radio, and only one of them operates it
at a time.

## What is shared and what is personal

**Shared (the shack), set by an admin:** the radio and how to reach it (radio, ICOM,
Hamlib), the server (public URL, sessions, backups, decode retention, email server),
safety limits that protect the hardware (SWR, PA temperature, PA rest, quiet hours, run
limits), the schedule, SSTV picture keeping, the DX cluster connection, and what the
receiver hears (decodes, band memory, heard entities, SSTV pictures received).

**Personal, set by each user for themselves:** callsign, license class, logbook, QRZ,
LoTW (their own certificate), eQSL, Club Log, WRL, N3FJP, which services new contacts
go to, emailed QSLs (templates, card), alerts and digest, PSKReporter reporting, WSPR
and JS8 identity and replies, hunting and dupe rules, band hopping, POTA chasing, the
UDP feed (GridTracker and the like), distance unit, contest state, function keys, CQ and
hunt slots, the last contact.

**Who sees what:** each user sees and edits only their own logbook and settings. Admins
also manage the users and the shack settings, and can look at any user's logbook and
settings read-only (a "Viewing: CALL" switch); they cannot change another user's log.

## Who is on the air

The person who has the radio (the holder). Their callsign and grid go out, their
contacts go into their logbook, their settings apply.

- Wanting the radio is a request. If it is idle (no automatic running, no contact in
  progress, nothing sent in the last minute) it is theirs at once.
- If it is in use, the holder gets the request on screen (and as a push notification):
  **Release** or **Keep**. Release, or no answer within 30 seconds, hands it over: the
  holder's automatic stops and any contact in progress ends. Keep tells the requester the
  radio is staying put.
- Switching loads the new person's settings and state (contest, slots, keys, last
  contact) and points the UDP feed, PSKReporter, WSPR and JS8 at their call.

## Radio time (bookings)

Operators book stretches of time on the radio on the **Radio time** page (15 minutes to 8
hours, up to 30 days ahead, never overlapping, ten coming up per operator at most). Everyone
sees everyone's bookings; you cancel your own (one already on ends there and then), an admin
anyone's.

- While a booking is on and its operator is signed in (a Zerobeat page open, or one closed
  within the last 10 minutes), the radio is theirs. It is handed to them when the booking
  starts, or when they open Zerobeat during it; whoever has it is told 5 minutes before (on
  screen and as a push notification), and their automatic stops at the handover. Nobody else
  can take the radio or ask for it until the booking ends.
- While its operator is not signed in, a booking does not hold the radio: it is used as on
  any other day. It holds again as soon as they come back.
- When a booking ends nothing happens on its own: the operator keeps the radio, and the
  usual rules (ask for it; idle, it is yours) apply.

The Operate page shows the booking on now, or the next one today, beside who has the radio.

## New users

A user created on **Settings → Users** starts with an empty logbook, default settings and a station
for their own callsign at the shack's grid. The first administrator keeps the logbook
and accounts that were there before.
