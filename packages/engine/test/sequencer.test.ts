import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/digital/message.ts";
import { startCall, startAnswer, receive, nextMessage, afterTx, abandon, type QsoState, type RxDecode, type QsoEvent } from "../src/digital/sequencer.ts";

const P = { id: "q", me: "W9ML", myGrid4: "EN61", them: "K1ABC", theirGrid: "FN42", theirSnr: -10, theirOffsetHz: 1200, theirParity: 0 as const, mode: "FT8" as const, txOffsetHz: 1500, now: 0, maxRepeats: 4, origin: "auto" as const };
const rx = (text: string, at = 0, snr = -12): RxDecode => ({ parsed: parseMessage(text)[0]!, text, snr, offsetHz: 1200, at });

function send(s: QsoState, at = 0) {
  const n = nextMessage(s);
  return { state: n.message ? afterTx(n.state, n.message, true, at) : n.state, message: n.message, events: n.events };
}

describe("sequencer, calling a CQ", () => {
  it("runs the full exchange and logs once", () => {
    let s = startCall(P);
    let r = send(s);
    expect(r.message).toBe("K1ABC W9ML EN61");
    s = r.state;
    let x = receive(s, [rx("W9ML K1ABC -12")], 15_000);
    s = x.state;
    expect(s.phase).toBe("rreport-sent");
    expect(s.reportRcvd).toBe(-12);
    r = send(s);
    expect(r.message).toBe("K1ABC W9ML R-10");
    s = r.state;
    x = receive(s, [rx("W9ML K1ABC RR73")], 45_000);
    expect(x.events.map((e) => e.type)).toEqual(["log"]);
    s = x.state;
    expect(s.phase).toBe("signing-off");
    r = send(s);
    expect(r.message).toBe("K1ABC W9ML 73");
    s = r.state;
    r = send(s);
    expect(r.message).toBeNull();
    expect(r.state.phase).toBe("done");
  });

  it("answers a grid with a report when they also called (role-free)", () => {
    let s = afterTx(startCall(P), "K1ABC W9ML EN61", true, 0);
    s = receive(s, [rx("W9ML K1ABC FN42")], 15_000).state;
    expect(s.phase).toBe("report-sent");
    expect(nextMessage(s).message).toBe("K1ABC W9ML -10");
  });

  it("gives up after maxRepeats sends that went out, not ones that were refused", () => {
    let s = startCall(P);
    for (let i = 0; i < 10; i++) s = afterTx(s, "K1ABC W9ML EN61", false, i);
    expect(nextMessage(s).message).toBe("K1ABC W9ML EN61");
    for (let i = 0; i < 4; i++) s = send(s).state;
    const n = nextMessage(s);
    expect(n.message).toBeNull();
    expect(n.state.phase).toBe("abandoned");
    expect((n.events[0] as Extract<QsoEvent, { type: "abandon" }>).incomplete).toBe(false);
  });

  it("abandons when they work someone else, after one grace for a sign-off", () => {
    let s = afterTx(startCall(P), "K1ABC W9ML EN61", true, 0);
    s = receive(s, [rx("N0XYZ K1ABC RR73")], 15_000).state;
    expect(s.phase).toBe("calling");
    const x = receive(s, [rx("N0XYZ K1ABC 73")], 45_000);
    expect(x.state.phase).toBe("abandoned");
    const y = receive(afterTx(startCall(P), "K1ABC W9ML EN61", true, 0), [rx("N0XYZ K1ABC -05")], 15_000);
    expect(y.state.reason).toBe("they are working N0XYZ");
  });

  it("records an incomplete exchange when reports crossed but no ack came", () => {
    let s = send(startCall(P)).state;
    s = receive(s, [rx("W9ML K1ABC -12")], 15_000).state;
    for (let i = 0; i < 4; i++) s = send(s).state;
    const n = nextMessage(s);
    expect(n.events[0]).toMatchObject({ type: "abandon", incomplete: true });
  });
});

describe("sequencer, answering our CQ", () => {
  it("replies report to a grid, logs on R-report, finishes when they go quiet", () => {
    let { state: s } = startAnswer(P, rx("W9ML K1ABC FN42"));
    expect(s.phase).toBe("report-sent");
    let r = send(s);
    expect(r.message).toBe("K1ABC W9ML -10");
    const x = receive(r.state, [rx("W9ML K1ABC R-07")], 15_000);
    expect(x.events.map((e) => e.type)).toEqual(["log"]);
    expect(x.state.reportRcvd).toBe(-7);
    r = send(x.state);
    expect(r.message).toBe("K1ABC W9ML RR73");
    const y = receive(r.state, [], 30_000);
    expect(y.state.phase).toBe("done");
    expect(y.events.some((e) => e.type === "log")).toBe(false);
  });

  it("re-sends RR73 if they repeat R-report, without logging twice", () => {
    let { state: s } = startAnswer(P, rx("W9ML K1ABC R-07"));
    expect(s.phase).toBe("rr73-sent");
    expect(s.logged).toBe(true);
    s = send(s).state;
    const x = receive(s, [rx("W9ML K1ABC R-07")], 15_000);
    expect(x.events).toEqual([]);
    expect(nextMessage(x.state).message).toBe("K1ABC W9ML RR73");
  });

  it("halts on request", () => {
    const s = startCall(P);
    expect(abandon(s, "operator halted").state.phase).toBe("abandoned");
  });
});

describe("sequencer, as a Hound (FT8 DXpedition mode)", () => {
  const FOX = { ...P, them: "3Y0K", theirGrid: null, theirOffsetHz: 300, txOffsetHz: 1800, hound: true, maxRepeats: 15 };
  const all = (text: string, offsetHz = 300, at = 0): RxDecode[] => parseMessage(text).map((parsed) => ({ parsed, text, snr: -14, offsetHz, at }));

  it("answers the Fox's report on its frequency, moves 300 Hz off for repeats, and ends silently on RR73", () => {
    let s = send(startCall(FOX)).state;
    expect(s.lastSent).toBe("3Y0K W9ML EN61");
    // The Fox works someone else in the same transmission: we keep calling.
    s = receive(s, all("K1ABC RR73; N0XYZ <3Y0K> -10"), 15_000).state;
    expect(s.phase).toBe("calling");
    s = receive(s, all("W9ML 3Y0K -12", 420), 30_000).state;
    expect(s.phase).toBe("rreport-sent");
    expect(s.txOffsetHz).toBe(420);
    const r = send(s, 45_000);
    expect(r.message).toBe("3Y0K W9ML R-10");
    expect(r.state.txOffsetHz).toBe(720); // the Fox is at 420: repeats go 300 Hz above it
    const x = receive(r.state, all("W9ML RR73; K1ABC <3Y0K> -08", 420), 60_000);
    expect(x.events.map((e) => e.type)).toEqual(["log", "done"]);
    expect(nextMessage(x.state).message).toBeNull();
  });

  it("keeps calling through a pileup longer than an ordinary call, and gives up on a Fox that never sends RR73", () => {
    let s = startCall(FOX);
    for (let i = 0; i < 25; i++) s = send(s).state;
    expect(nextMessage(s).message).toBe("3Y0K W9ML EN61");
    s = receive(s, all("W9ML 3Y0K -12", 420), 0).state;
    for (let i = 0; i < 5; i++) s = send(s).state;
    expect(nextMessage(s).state.phase).toBe("abandoned");
  });
});

import { decodeFT8 } from "@e04/ft8ts";
import { contestMessages, rstFromSnr } from "../src/digital/message.ts";
import { buildWaveform } from "../src/digital/waveform.ts";

describe("sequencer, in a contest", () => {
  const at = (text: string): RxDecode[] => parseMessage(text).map((parsed) => ({ parsed, text, snr: -8, offsetHz: 1200, at: 0 }));

  it.each([
    ["field-day", "1D WI", "K1ABC W9ML 1D WI", "W9ML K1ABC R 3A CT", "3A CT"],
    ["rtty-roundup", "WI", "K1ABC W9ML 549 WI", "W9ML K1ABC R 579 CT", "579 CT"],
    ["ww-digi", "", "K1ABC W9ML EN61", "W9ML K1ABC R FN42", "FN42"],
  ] as const)("%s: the first call carries the exchange, their R+exchange gets RR73 and the log, their RR73 ends it", (contest, myExch, first, reply, theirs) => {
    let s = startCall({ ...P, contest, myExch });
    const r1 = send(s);
    expect(r1.message).toBe(first);
    const x = receive(r1.state, at(reply), 15_000);
    expect(x.events.map((e) => e.type)).toEqual(["log"]);
    expect(x.state.theirExch).toBe(theirs);
    const r2 = send(x.state);
    expect(r2.message).toBe("K1ABC W9ML RR73");
    s = receive(r2.state, at("W9ML K1ABC RR73"), 30_000).state;
    expect(s.phase).toBe("done");
  });

  it("answers a Field Day caller's exchange with R and ours", () => {
    let s = startCall({ ...P, contest: "field-day", myExch: "1D WI" });
    s = receive(s, at("W9ML K1ABC 2A EMA"), 0).state;
    expect(s.phase).toBe("rreport-sent");
    expect(nextMessage(s).message).toBe("K1ABC W9ML R 1D WI");
  });

  it("makes the RST from the SNR as WSJT-X does", () => {
    expect([rstFromSnr(-24), rstFromSnr(-10), rstFromSnr(0), rstFromSnr(20)]).toEqual(["529", "549", "569", "599"]);
  });

  it("only sends messages FT8 can carry exactly", () => {
    for (const c of ["field-day", "rtty-roundup", "ww-digi", "arrl-digi"] as const) {
      const m = contestMessages("W9ML", "K1ABC", "EN61", -10, c, c === "field-day" ? "1D WI" : c === "rtty-roundup" ? "0013" : "");
      for (const msg of [m.tx2, m.tx3, m.tx4, m.tx6]) {
        const w = buildWaveform(msg, "FT8", 1500, 12_000);
        const x = new Float32Array(15 * 12_000);
        x.set(w, 6_000);
        const d = decodeFT8(x, { sampleRate: 12_000, freqLow: 1_000, freqHigh: 2_000 });
        expect(d.map((v) => v.msg.trim())).toContain(msg);
      }
    }
  });
});
