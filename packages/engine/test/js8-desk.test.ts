/**
 * The JS8 desk end to end on modulated audio: another station's frames are built,
 * modulated and decoded period by period, and the desk must join them into messages
 * and answer the way JS8Call does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AuxDecoder } from "../src/digital/aux-decoder.ts";
import { decodeJs8, encodeJs8, js8Waveform } from "../src/digital/js8/modem.ts";
import { JS8_SUBMODES } from "../src/digital/js8/params.ts";
import { buildMessageFramesWithInfo } from "../src/digital/js8/varicode.ts";
import { Js8Desk, type Js8Config } from "../src/operate/js8.ts";

const RATE = 12_000;
const P = JS8_SUBMODES.normal;

// The aux thread, run inline.
const aux = {
  decode: async (job: { kind: "js8"; samples: Float32Array; nfqsoHz: number }) => ({ id: 0, kind: "js8" as const, decodes: decodeJs8(job.samples, "normal", { depth: 2, nfqsoHz: job.nfqsoHz }), ms: 0 }),
} as unknown as AuxDecoder;

function desk(over: Partial<Js8Config> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js8-desk-"));
  const sent: string[] = [];
  const config: Js8Config = { call: "W9ML", grid: "EN61JK", submode: "normal", autoReply: true, hbAck: false, hbMinutes: 0, info: "FLEX 6600 DIPOLE", status: "", groups: ["@ARES"], txOffsetHz: 1500, ...over };
  const d = new Js8Desk(aux, dir, () => config, async (_s, _t, label) => (sent.push(label), true), () => {});
  (d as unknown as { active: boolean }).active = true;
  return { d, sent, dir };
}

/** Another station sends `text`: one period of audio per frame, decoded in turn. */
async function hear(d: Js8Desk, from: string, grid: string, text: string, hz = 1200, firstIndex = 0) {
  const { frames } = buildMessageFramesWithInfo(from, grid, "", text, false, false, P.submodeId);
  const decode = (d as unknown as { decode(p: object): Promise<void> }).decode.bind(d);
  for (let i = 0; i < frames.length; i++) {
    const buf = new Float32Array(P.samplesNeeded);
    const w = js8Waveform(encodeJs8(frames[i]!.frame, frames[i]!.i3, "normal"), hz, RATE, "normal");
    const at = Math.round((P.startDelayMs / 1000) * RATE);
    for (let j = 0; j < w.length && at + j < buf.length; j++) buf[at + j] = 0.3 * w[j]!;
    const index = NOW_INDEX + firstIndex + i;
    await decode({ index, start: index * P.periodSec * 1000, buf, n: buf.length });
  }
  return frames.length;
}

const NOW_INDEX = Math.floor(Date.now() / 15_000) - 60;
const queued = (d: Js8Desk) => d.snapshot().queued;

describe("Js8Desk", () => {
  it("joins a multi-frame message and shows it as JS8Call does", async () => {
    const { d } = desk({ autoReply: false });
    const n = await hear(d, "W1AW", "FN31", "@ALLCALL CQ CQ CQ FN31 HELLO FROM NEWINGTON");
    expect(n).toBeGreaterThan(1);
    const m = d.messages.at(-1)!;
    expect(m.complete).toBe(true);
    expect(m.from).toBe("W1AW");
    expect(m.text).toMatch(/HELLO FROM NEWINGTON ♢$/);
    expect(m.toUs).toBe(true); // @ALLCALL
    expect(d.heard.get("W1AW")).toBeTruthy();
  });

  it("answers SNR?, GRID?, INFO? and HEARING? when they are for us", async () => {
    const { d } = desk();
    await hear(d, "K9PC", "EN61", "@ALLCALL CQ CQ", 900, 10);
    await hear(d, "W1AW", "FN31", "W9ML SNR?", 1200, 20);
    await hear(d, "W1AW", "FN31", "W9ML GRID?", 1200, 30);
    await hear(d, "W1AW", "FN31", "W9ML INFO?", 1200, 40);
    await hear(d, "W1AW", "FN31", "W9ML HEARING?", 1200, 50);
    const q = queued(d);
    expect(q[0]).toMatch(/^W1AW SNR [+-]\d\d$/);
    expect(q[1]).toBe("W1AW GRID EN61JK");
    expect(q[2]).toBe("W1AW INFO FLEX 6600 DIPOLE");
    expect(q[3]).toBe("W1AW HEARING K9PC");
  });

  it("ignores queries for other stations and stays quiet with auto-reply off", async () => {
    const a = desk();
    await hear(a.d, "W1AW", "FN31", "K9PC SNR?");
    expect(queued(a.d)).toEqual([]);
    const b = desk({ autoReply: false });
    await hear(b.d, "W1AW", "FN31", "W9ML SNR?");
    expect(queued(b.d)).toEqual([]);
  });

  it("answers a group we are in", async () => {
    const { d } = desk();
    await hear(d, "W1AW", "FN31", "@ARES SNR?");
    expect(queued(d)[0]).toMatch(/^W1AW SNR/);
  });

  it("stores a MSG with a good checksum, ACKs it, and keeps it across restarts", async () => {
    const { d, dir } = desk();
    await hear(d, "W1AW", "FN31", "W9ML MSG MEET ON 40M AT 2100Z");
    expect(d.inbox.at(-1)).toMatchObject({ from: "W1AW", to: "W9ML", text: "MEET ON 40M AT 2100Z" });
    expect(queued(d)).toContain("W1AW ACK");
    const again = new Js8Desk(aux, dir, () => ({ call: "W9ML" }) as Js8Config, async () => true, () => {});
    expect(again.inbox.at(-1)?.text).toBe("MEET ON 40M AT 2100Z");
  });

  it("holds a MSG TO: for another station and hands it over on QUERY MSGS", async () => {
    const { d } = desk();
    await hear(d, "W1AW", "FN31", "W9ML MSG TO: K9PC LUNCH AT NOON", 1200, 10);
    const held = d.inbox.at(-1)!;
    expect(held).toMatchObject({ from: "W1AW", to: "K9PC", text: "LUNCH AT NOON", delivered: false });
    d.halt();
    await hear(d, "K9PC", "EN61", "W9ML QUERY MSGS", 900, 30);
    expect(queued(d)).toEqual([`K9PC YES MSG ID ${held.id}`]);
    d.halt();
    await hear(d, "K9PC", "EN61", `W9ML QUERY MSG ${held.id}`, 900, 50);
    expect(queued(d)).toEqual(["K9PC MSG LUNCH AT NOON DE W1AW"]);
    expect(d.inbox.at(-1)!.delivered).toBe(false);
    (d.inbox.at(-1) as { sentAt?: number }).sentAt = Date.now(); // as when the reply goes out
    await hear(d, "K9PC", "EN61", "W9ML ACK", 900, 70);
    expect(d.inbox.at(-1)!.delivered).toBe(true);
  });

  it("sends a message one frame per period and logs it when done", async () => {
    const { d, sent } = desk();
    expect(d.enqueue("W1AW HELLO MY FRIEND, HOW COPY?")).toBeNull();
    const step = (d as unknown as { beginSending(): void; sendNextFrame(t: number): Promise<void> });
    step.beginSending();
    const frames = d.sending!.frames.length;
    for (let i = 0; i < frames; i++) await step.sendNextFrame(i * 15_000);
    expect(sent).toHaveLength(frames);
    expect(sent.at(-1)).toMatch(new RegExp(`\\(${frames}/${frames}\\)$`));
    expect(d.sending).toBeNull();
    expect(d.messages.at(-1)).toMatchObject({ dir: "tx", complete: true });
  });

  it("answers a station with a compound call (call in frame 1, query in frame 2)", async () => {
    const { d } = desk();
    await hear(d, "N3CHX/P1", "FM06", "W9ML SNR?");
    const m = d.messages.at(-1)!;
    expect(m).toMatchObject({ from: "N3CHX/P1", to: "W9ML", toUs: true, complete: true });
    expect(queued(d)[0]).toMatch(/^N3CHX\/P1 SNR [+-]\d\d$/);
  });

  it("stores a MSG from a compound call", async () => {
    const { d } = desk();
    await hear(d, "KG4UHM/6", "CM87", "W9ML MSG QSY 40M");
    expect(d.inbox.at(-1)).toMatchObject({ from: "KG4UHM/6", to: "W9ML", text: "QSY 40M" });
  });

  it("does not answer or store traffic for @ALLCALL, and stays quiet on an empty INFO", async () => {
    const { d } = desk({ info: "" });
    await hear(d, "W1AW", "FN31", "@ALLCALL SNR?", 1200, 10);
    await hear(d, "W1AW", "FN31", "@ALLCALL MSG NET TONIGHT", 1200, 20);
    await hear(d, "W1AW", "FN31", "W9ML INFO?", 1200, 40);
    expect(queued(d)).toEqual([]);
    expect(d.inbox).toEqual([]);
  });

  it("does not resume timed heartbeats by itself after a start, only after someone presses HB", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const { d } = desk({ hbMinutes: 1 });
      (d as unknown as { active: boolean }).active = false;
      d.start();
      vi.advanceTimersByTime(3 * 60_000);
      expect(queued(d).filter((q) => q.includes("HEARTBEAT"))).toEqual([]);
      d.heartbeat(); // the operator presses HB
      expect((d as unknown as { hbArmed: boolean }).hbArmed).toBe(true);
      d.stop();
      d.start(); // a restart
      expect((d as unknown as { hbArmed: boolean }).hbArmed).toBe(false);
      d.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses text JS8 cannot send", () => {
    const { d } = desk();
    expect(d.enqueue("   ")).toMatch(/nothing/);
  });
});
