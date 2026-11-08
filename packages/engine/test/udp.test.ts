import dgram from "node:dgram";
import { describe, expect, it } from "vitest";

import { encodeDecode, encodeHeartbeat, encodeQsoLogged, encodeStatus, MAGIC, MsgType, parseMessage, parseTargets, UdpFeed } from "../src/services/udp.ts";

/** Minimal QDataStream reader, written independently of the encoder under test. */
function reader(b: Buffer) {
  let o = 0;
  return {
    u8: () => b.readUInt8(o++),
    u32: () => ((o += 4), b.readUInt32BE(o - 4)),
    i32: () => ((o += 4), b.readInt32BE(o - 4)),
    u64: () => ((o += 8), Number(b.readBigUInt64BE(o - 8))),
    i64: () => ((o += 8), Number(b.readBigInt64BE(o - 8))),
    f64: () => ((o += 8), b.readDoubleBE(o - 8)),
    str: () => {
      const n = b.readUInt32BE(o);
      o += 4;
      if (n === 0xffffffff) return null;
      o += n;
      return b.toString("utf8", o - n, o);
    },
    left: () => b.length - o,
  };
}

function replyDatagram(text: string, df: number): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => {
    const x = Buffer.alloc(4);
    x.writeUInt32BE(v);
    parts.push(x);
  };
  const str = (s: string) => {
    u32(Buffer.byteLength(s));
    parts.push(Buffer.from(s));
  };
  u32(MAGIC);
  u32(2);
  u32(MsgType.Reply);
  str("GridTracker");
  u32(45_015_000); // 12:30:15
  const snr = Buffer.alloc(4);
  snr.writeInt32BE(-12);
  parts.push(snr);
  const dt = Buffer.alloc(8);
  dt.writeDoubleBE(0.2);
  parts.push(dt);
  u32(df);
  str("~");
  str(text);
  parts.push(Buffer.from([0, 0]));
  return Buffer.concat(parts);
}

describe("WSJT-X messages", () => {
  it("heartbeat carries magic, schema, type, id and versions", () => {
    const r = reader(encodeHeartbeat("Zerobeat", "2.0.0", "abc"));
    expect(r.u32()).toBe(MAGIC);
    expect(r.u32()).toBe(2);
    expect(r.u32()).toBe(MsgType.Heartbeat);
    expect(r.str()).toBe("Zerobeat");
    expect(r.u32()).toBe(3);
    expect(r.str()).toBe("2.0.0");
    expect(r.str()).toBe("abc");
    expect(r.left()).toBe(0);
  });

  it("decode has the field order WSJT-X listeners expect", () => {
    const at = Date.UTC(2026, 9, 19, 12, 30, 15);
    const r = reader(encodeDecode("Zerobeat", { at, snr: -15, dt: 0.3, dfHz: 1234, mode: "FT8", text: "CQ W9ML EN61", lowConfidence: false }));
    r.u32();
    r.u32();
    expect(r.u32()).toBe(MsgType.Decode);
    expect(r.str()).toBe("Zerobeat");
    expect(r.u8()).toBe(1); // new
    expect(r.u32()).toBe((12 * 3600 + 30 * 60 + 15) * 1000);
    expect(r.i32()).toBe(-15);
    expect(r.f64()).toBeCloseTo(0.3);
    expect(r.u32()).toBe(1234);
    expect(r.str()).toBe("~");
    expect(r.str()).toBe("CQ W9ML EN61");
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(0);
    expect(r.left()).toBe(0);
  });

  it("status ends with period, config name and TX message", () => {
    const b = encodeStatus("Zerobeat", {
      dialHz: 14_074_000,
      mode: "FT8",
      dxCall: "K1ABC",
      report: "-10",
      txEnabled: true,
      transmitting: false,
      decoding: false,
      rxDf: 1500,
      txDf: 1500,
      deCall: "W9ML",
      deGrid: "EN61",
      dxGrid: "FN42",
      periodSec: 15,
      configName: "Zerobeat",
      txMessage: "K1ABC W9ML -10",
    });
    const r = reader(b);
    r.u32();
    r.u32();
    expect(r.u32()).toBe(MsgType.Status);
    r.str();
    expect(r.u64()).toBe(14_074_000);
    expect([r.str(), r.str(), r.str(), r.str()]).toEqual(["FT8", "K1ABC", "-10", "FT8"]);
    expect([r.u8(), r.u8(), r.u8()]).toEqual([1, 0, 0]);
    expect([r.u32(), r.u32()]).toEqual([1500, 1500]);
    expect([r.str(), r.str(), r.str()]).toEqual(["W9ML", "EN61", "FN42"]);
    expect(r.u8()).toBe(0);
    expect(r.str()).toBe("");
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(0);
    expect(r.u32()).toBe(0xffffffff);
    expect(r.u32()).toBe(15);
    expect(r.str()).toBe("Zerobeat");
    expect(r.str()).toBe("K1ABC W9ML -10");
    expect(r.left()).toBe(0);
  });

  it("QSO logged encodes date-times as Julian day, ms and UTC", () => {
    const on = Date.UTC(2026, 9, 19, 2, 0, 0);
    const off = on + 60_000;
    const r = reader(
      encodeQsoLogged("Zerobeat", { timeOn: on, timeOff: off, dxCall: "K1ABC", dxGrid: "FN42", freqHz: 14_075_500, mode: "FT8", rstSent: "-10", rstRcvd: "-12", txPower: "50", comments: "", name: "", operator: "", myCall: "W9ML", myGrid: "EN61", propMode: "" }),
    );
    r.u32();
    r.u32();
    expect(r.u32()).toBe(MsgType.QsoLogged);
    r.str();
    expect(r.i64()).toBe(2_440_588 + Math.floor(off / 86_400_000));
    expect(r.u32()).toBe(2 * 3600_000 + 60_000);
    expect(r.u8()).toBe(1);
    expect(r.str()).toBe("K1ABC");
  });

  it("parses a Reply the way GridTracker sends it", () => {
    const m = parseMessage(replyDatagram("CQ K1ABC FN42", 1500));
    expect(m).toMatchObject({ type: MsgType.Reply, id: "GridTracker", snr: -12, dfHz: 1500, mode: "~", text: "CQ K1ABC FN42" });
  });

  it("rejects junk without throwing", () => {
    expect(parseMessage(Buffer.from("hello"))).toBeNull();
    expect(parseMessage(Buffer.alloc(3))).toBeNull();
    expect(parseMessage(replyDatagram("x", 1).subarray(0, 20))).toBeNull();
  });
});

describe("targets", () => {
  it("parses hosts, ports and formats", () => {
    expect(parseTargets("127.0.0.1:2237, 192.168.0.50:2333 adif; gridtracker.lan").targets).toEqual([
      { host: "127.0.0.1", port: 2237, format: "wsjtx" },
      { host: "192.168.0.50", port: 2333, format: "adif" },
      { host: "gridtracker.lan", port: 2237, format: "wsjtx" },
    ]);
    expect(parseTargets("bad host!:x").errors.length).toBe(1);
  });
});

describe("UdpFeed over loopback", () => {
  async function listener() {
    const s = dgram.createSocket("udp4");
    const got: { msg: Buffer; port: number }[] = [];
    s.on("message", (msg, r) => got.push({ msg, port: r.port }));
    await new Promise<void>((res) => s.bind(0, "127.0.0.1", () => res()));
    return { s, got, port: s.address().port };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("sends heartbeat and decodes, and acts on Reply only when allowed", async () => {
    const L = await listener();
    const replies: string[] = [];
    const feed = new UdpFeed({ id: "Zerobeat", version: "2.0.0", log: () => {}, onReply: (r) => replies.push(r.text), onHaltTx: () => {}, onReplay: () => {} });
    await feed.configure({ targets: `127.0.0.1:${L.port}`, sendDecodes: true, acceptControl: false });
    feed.decodes([{ at: Date.now(), snr: -5, dt: 0.1, dfHz: 900, mode: "FT8", text: "CQ K1ABC FN42", lowConfidence: false }]);
    await wait(80);
    const types = L.got.map((g) => g.msg.readUInt32BE(8));
    expect(types).toContain(MsgType.Heartbeat);
    expect(types).toContain(MsgType.Decode);

    // Answer from the listener's socket to the feed's source port.
    const feedPort = L.got[0]!.port;
    L.s.send(replyDatagram("CQ K1ABC FN42", 900), feedPort, "127.0.0.1");
    await wait(80);
    expect(replies).toEqual([]); // control is off

    await feed.configure({ targets: `127.0.0.1:${L.port}`, sendDecodes: true, acceptControl: true });
    L.s.send(replyDatagram("CQ K1ABC FN42", 900), feedPort, "127.0.0.1");
    await wait(80);
    expect(replies).toEqual(["CQ K1ABC FN42"]);

    feed.close();
    await wait(150);
    expect(L.got.at(-1)!.msg.readUInt32BE(8)).toBe(MsgType.Close);
    L.s.close();
  });

  it("names itself as set, WSJT-X by the operator's choice", async () => {
    const L = await listener();
    const feed = new UdpFeed({ id: "Zerobeat", version: "2.0.0", log: () => {}, onReply: () => {}, onHaltTx: () => {}, onReplay: () => {} });
    await feed.configure({ targets: `127.0.0.1:${L.port}`, id: "WSJT-X", wsjtxVersion: "3.0.2", sendDecodes: false, acceptControl: false });
    await wait(80);
    // Header: magic, schema, type, then the id as a length-prefixed string.
    const first = L.got[0]!.msg;
    expect(first.readUInt32BE(12)).toBe(6);
    expect(first.subarray(16, 22).toString()).toBe("WSJT-X");
    expect(feed.id).toBe("WSJT-X");
    // The heartbeat after the id: max schema, then the version string.
    expect(first.readUInt32BE(8)).toBe(MsgType.Heartbeat);
    expect(first.readUInt32BE(26)).toBe(5);
    expect(first.subarray(30, 35).toString()).toBe("3.0.2");
    feed.close();
    L.s.close();
  });

  it("sends plain ADIF to adif targets", async () => {
    const L = await listener();
    const feed = new UdpFeed({ id: "Zerobeat", version: "2.0.0", log: () => {}, onReply: () => {}, onHaltTx: () => {}, onReplay: () => {} });
    await feed.configure({ targets: `127.0.0.1:${L.port} adif`, sendDecodes: true, acceptControl: false });
    feed.logged(
      { timeOn: 0, timeOff: 0, dxCall: "K1ABC", dxGrid: "", freqHz: 14_074_000, mode: "FT8", rstSent: "", rstRcvd: "", txPower: "", comments: "", name: "", operator: "", myCall: "W9ML", myGrid: "", propMode: "" },
      "<CALL:5>K1ABC <EOR>",
    );
    await wait(80);
    expect(L.got.map((g) => g.msg.toString())).toEqual(["<CALL:5>K1ABC <EOR>\n"]);
    feed.close(false);
    L.s.close();
  });
});
