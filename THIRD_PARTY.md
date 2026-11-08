# Third-party work in Zerobeat

Zerobeat's own code is GPL-3.0-or-later. Parts of it are ports of other programs' source,
or use their data, and keep those programs' licenses. One dependency, `@e04/ft8ts`, is
licensed GPL-3.0 without the "or later" option, so Zerobeat as distributed (with that
dependency) is under GPL-3.0.

Each ported file names, in its header comment, the upstream files it follows.

| Part | Where in Zerobeat | Upstream | Authors | License |
| --- | --- | --- | --- | --- |
| FT8 and FT4 coding | dependency `@e04/ft8ts` | [ft8ts](https://github.com/e04/ft8ts), a port of WSJT-X | e04; WSJT-X by Joe Taylor K1JT and the WSJT Development Group | GPL-3.0 |
| JTTY | `packages/engine/src/digital/jtty/` | WSJT-X `lib/jtty/` and its design notes | Joe Taylor K1JT and the WSJT Development Group | GPL-3.0 |
| WSPR | `packages/engine/src/digital/wspr/` | WSJT-X `lib/wsprd/` (`wsprd`), `lib/genwspr.f90` | Joe Taylor K1JT, Steven Franke K9AN; the Fano sequential decoder (`fano.c`) by Phil Karn KA9Q | GPL-3.0 (as distributed in WSJT-X) |
| FT2 | `packages/engine/src/digital/` (timing, dial frequencies) | Decodium: FT4 at twice the symbol rate, its timing and default frequencies | IU8LMC | see Decodium |
| Hound mode | `packages/engine/src/operate/` | WSJT-X Fox and Hound rules | WSJT Development Group | GPL-3.0 |
| JS8 | `packages/engine/src/digital/js8/` | [JS8Call](https://github.com/js8call/js8call): modem, framing, varicode, JSC dictionary (`JSC_map.cpp`, `JSC_list.cpp`) | Jordan Sherer KN4CRD and the JS8Call team | GPL-3.0 |
| RTTY, PSK31 | `packages/engine/src/digital/keyboard/` | [fldigi](https://sourceforge.net/projects/fldigi/): Baudot and varicode tables, RTTY and PSK designs | Dave Freese W1HKJ and contributors; PSK31 and its varicode by Peter Martinez G3PLX | GPL-3.0 |
| ICOM network protocol | `packages/engine/src/rig/icom-lan.ts` | [wfview](https://gitlab.com/eliggett/wfview) and [kappanhang](https://github.com/nonoo/kappanhang) | the wfview team; nonoo | wfview GPL-3.0; see kappanhang for its terms |
| DXCC data | `packages/core/data/cty.csv` | [country files](https://www.country-files.com/) | Jim Reisert AD1C | free for use, see the site |
| Map data | `apps/web/lib/server/path-map.ts`, Map page | Natural Earth 1:110m land and countries ([world-atlas](https://github.com/topojson/world-atlas)), US states from the US Census ([us-atlas](https://github.com/topojson/us-atlas)) | Natural Earth; US Census Bureau; packaged by Mike Bostock | public domain data; packages ISC |
| Fonts | `apps/web/app/fonts/` | Inter, JetBrains Mono | The Inter Project Authors; The JetBrains Mono Project Authors | SIL Open Font License 1.1 (texts beside the fonts) |

Test fixtures: `packages/engine/test/fixtures/jtty_260807_134110.wav` is WSJT-X's sample
recording and `packages/engine/test/fixtures/wspr/150426_0918.wav` its WSPR sample;
`packages/engine/test/fixtures/js8/` are JS8Call's sample recordings. `ft4-band-14080.wav`
and `sstv-martin1-14230.wav` were recorded off the air by Zerobeat.

Not included: WSJT-X's SuperFox decoder, whose license allows its use only with WSJT-X.
