import { describe, expect, it } from "vitest";

import {
  ALPHABET72,
  FrameType,
  Submode,
  TransmissionType,
  bitsToInt,
  bitsToStr,
  buildMessageFrames,
  buildMessageFramesWithInfo,
  checkBufferedMessage,
  checksum16,
  checksum16Valid,
  checksum32,
  checksum32Valid,
  crc16Kermit,
  crc32Bzip2,
  directedCmdKey,
  escape,
  formatSNR,
  framesToText,
  intToBits,
  isCommandAutoreply,
  isCommandBuffered,
  isCommandChecksumed,
  isCompoundCallsign,
  isValidCallsign,
  pack16bits,
  pack72bits,
  packAlphaNumeric50,
  packCallsign,
  packCompoundMessage,
  packDataMessage,
  packDirectedMessage,
  packFastDataMessage,
  packGrid,
  packHeartbeatMessage,
  packNum,
  parseCallsigns,
  parseGrids,
  unescape,
  unpack16bits,
  unpack72bits,
  unpackAlphaNumeric50,
  unpackCallsign,
  unpackDataMessage,
  unpackFastDataMessage,
  unpackFrame,
  unpackGrid,
} from "../src/digital/js8/varicode.ts";
import { jscCodeword, jscCompress, jscDecompress, jscEntry, jscExists, jscLookup } from "../src/digital/js8/jsc.ts";

const ascii = (s: string) => new TextEncoder().encode(s);
const fmt = (frames: { frame: string; i3: number }[]) => frames.map((f) => `${f.frame}:${f.i3}`);

/**
 * Golden vectors: frames received on the air by JS8Call (W9ML's ALL.TXT, December 2025) with
 * the i3 bits, submode and the text JS8Call displayed for them.
 */
const RECEIVED: [frame: string, i3: number, submode: number, message: string][] = [
  // heartbeats and CQs
  ["2t0gWLSTOoWm", 3, Submode.Normal, "N5DEN: @HB HEARTBEAT DM62 "],
  ["1It92B1SOn6e", 3, Submode.Normal, "AI5TS: @HB HEARTBEAT EM01 "],
  ["47wDwjwxOoWe", 3, Submode.Slow, "XE2MAM: @HB HEARTBEAT DM61 "],
  ["2XIt0eGdum40", 3, Submode.Fast, "KF0FGP: @HB HEARTBEAT EM38 "],
  ["2auXydvsPpDm", 3, Submode.Normal, "KW9W: @ALLCALL CQ CQ CQ DM42 "],
  // directed
  ["Vk9aR+BguLqh", 3, Submode.Fast, "K2MJ: W9ML HEARTBEAT SNR +12 "],
  ["SJGu+-uVKVqb", 3, Submode.Normal, "KD2CNC: K1TWH HEARTBEAT SNR +06 "],
  ["VkG-5-vUxhaW", 3, Submode.Normal, "K5OOM: K8JOK SNR +01 "],
  ["QCEeHUvUxhaS", 3, Submode.Normal, "AD5FS: K8JOK SNR -03 "],
  ["VkNkwwgzbgu0", 3, Submode.Normal, "K8JOK: VK6YSF ACK "],
  ["SM5v6HF1rXC0", 3, Submode.Normal, "KK7LMI: KE5GGF HW CPY? "],
  ["UygI1VBguK00", 3, Submode.Fast, "WW4GPL: W9ML SNR? "],
  ["UygI1RpyDtO0", 3, Submode.Fast, "WW4GPL: WX2X QSL? "],
  ["QBbmEVBguLu0", 3, Submode.Fast, "AB8FJ: W9ML AGN? "],
  ["UygI1RpVlNi0", 1, Submode.Normal, "WW4GPL: WW9Y YES "],
  ["Vk9FAnBbC8a0", 1, Submode.Normal, "K2IRE: KC2HJU MSG "],
  ["SNCrunGiV9y0", 1, Submode.Normal, "KN6ZUA: KF6IWW  "],
  // compound (sender's call) then compound directed (to a group or compound call)
  ["ABgw685MykFm", 1, Submode.Normal, "HP3/VA3QR: "],
  ["Asbi73zyyjcG", 1, Submode.Normal, "N3CHX/P1: "],
  ["AUG0HefdOmn0", 1, Submode.Normal, "K0EMP: "],
  ["KmtMedjUO+JG", 2, Submode.Normal, "@KWCC SNR? "],
  ["KlytytyIw+JG", 2, Submode.Normal, "@GHOSTNET SNR? "],
  ["J+4UccwCO+k8", 2, Submode.Normal, "W9ML HEARTBEAT SNR -08 "],
  ["Meg3bnxrmPTP", 1, Submode.Slow, "EQG/6GW/PFY KH75 "],
  // data, Normal submode (prefix 11 = JSC, 10 = Huffman)
  ["vvDsEA4+++++", 2, Submode.Normal, "TNX 73 GL"],
  ["tdGkz-H+++++", 2, Submode.Normal, "HOW COPY"],
  ["v2++++++++++", 2, Submode.Normal, ". "],
  ["noYu6+Xa+Kb+", 0, Submode.Normal, "T +10 DB - NOT "],
  ["eU8t-ZWEYv+V", 0, Submode.Normal, "EACH OTHER.  LO"],
  ["kZIH3+Qddcxz", 0, Submode.Normal, ". SEE YOU ALL TO"],
  // data, fast submodes (no prefix, i3 data flag)
  ["Txylw1++++++", 6, Submode.Fast, "COPY WELL"],
  ["kjWCFneRJq5+", 4, Submode.Fast, "ORANGE CITY, FL "],
  ["tGfZeJ3sl+4+", 4, Submode.Fast, "GOOD I FINALLY GOT YOU"],
  ["UPA9m1XqI7sF", 4, Submode.Fast, "INTO THE ENDFED. \n"],
];

describe("JS8 frame decoding matches JS8Call on real received frames", () => {
  for (const [frame, i3, submode, message] of RECEIVED) {
    it(`${frame}/${i3} -> ${JSON.stringify(message)}`, () => {
      expect(unpackFrame(frame, i3, submode).message).toBe(message);
    });
  }

  it("leaves an undecodable fast data frame as the raw frame", () => {
    const d = unpackFrame("ov+iZgWeAVSN", 7, Submode.Slow);
    expect(d.frameType).toBe(FrameType.Unknown);
    expect(d.message).toBe("ov+iZgWeAVSN");
  });

  it("exposes structured fields", () => {
    const hb = unpackFrame("2t0gWLSTOoWm", 3);
    expect(hb).toMatchObject({ frameType: FrameType.Heartbeat, isHeartbeat: true, isAlt: false, from: "N5DEN", grid: "DM62", hb: "HEARTBEAT", isFirst: true, isLast: true });

    const cq = unpackFrame("2auXydvsPpDm", 3);
    expect(cq).toMatchObject({ isHeartbeat: true, isAlt: true, from: "KW9W", to: "@ALLCALL", hb: "CQ CQ CQ", grid: "DM42" });

    const snr = unpackFrame("QCEeHUvUxhaS", 3);
    expect(snr).toMatchObject({ frameType: FrameType.Directed, from: "AD5FS", to: "K8JOK", cmd: " SNR", num: "-03", snr: -3, directed: ["AD5FS", "K8JOK", " SNR", "-03"] });

    const msg = unpackFrame("Vk9FAnBbC8a0", 1);
    expect(msg).toMatchObject({ from: "K2IRE", to: "KC2HJU", cmd: " MSG", isFirst: true, isLast: false });
    expect(msg.num).toBeUndefined();

    const cd = unpackFrame("J+4UccwCO+k8", 2);
    expect(cd).toMatchObject({ frameType: FrameType.CompoundDirected, from: "<....>", to: "W9ML", cmd: " HEARTBEAT SNR", snr: -8, isLast: true });
    expect(cd.directed).toEqual(["<....>", "W9ML", " HEARTBEAT SNR", "-08"]);

    const cmp = unpackFrame("ABgw685MykFm", 1);
    expect(cmp).toMatchObject({ frameType: FrameType.Compound, compound: "HP3/VA3QR", from: "HP3/VA3QR" });

    const data = unpackFrame("Txylw1++++++", 6, Submode.Fast);
    expect(data).toMatchObject({ frameType: FrameType.Data, data: "COPY WELL", isDataFlag: true, isLast: true, isFirst: false });
  });
});

/** Messages as sent on the air, rebuilt from their text: frame for frame what JS8Call sent. */
describe("buildMessageFrames reproduces real transmissions", () => {
  it("heartbeat", () => {
    expect(fmt(buildMessageFrames("N5DEN", "DM62", "", "@HB HEARTBEAT DM62", false, false, Submode.Normal))).toEqual(["2t0gWLSTOoWm:3"]);
  });

  it("CQ", () => {
    expect(fmt(buildMessageFrames("KW9W", "DM42", "", "@ALLCALL CQ CQ CQ DM42", false, false, Submode.Normal))).toEqual(["2auXydvsPpDm:3"]);
  });

  it("directed replies with an SNR", () => {
    expect(fmt(buildMessageFrames("K5OOM", "", "", "K8JOK SNR +01", false, false, Submode.Normal))).toEqual(["VkG-5-vUxhaW:3"]);
    expect(fmt(buildMessageFrames("K2MJ", "", "", "W9ML HEARTBEAT SNR +12", false, false, Submode.Fast))).toEqual(["Vk9aR+BguLqh:3"]);
    // own callsign at the start is removed
    expect(fmt(buildMessageFrames("AD5FS", "", "", "AD5FS: K8JOK SNR -03", false, false, Submode.Normal))).toEqual(["QCEeHUvUxhaS:3"]);
  });

  it("directed query to the selected call", () => {
    expect(fmt(buildMessageFrames("WW4GPL", "", "W9ML", "SNR?", false, false, Submode.Fast))).toEqual(["UygI1VBguK00:3"]);
  });

  it("multi-frame Fast message: directed free-text frame then JSC data frames", () => {
    const frames = buildMessageFrames("AB8FJ", "", "W9ML", "TED HERE IN LOVELAND OHIO NEAR CINCINNATI. WAS 67F YESTERDAY.", false, false, Submode.Fast);
    expect(fmt(frames)).toEqual(["QBbmEVBguLy0:1", "41oxnKBUTx6l:4", "hANFQDwV5I5+:4", "U9JYCL0zrqI1:6"]);
    expect(framesToText(frames, Submode.Fast)).toBe("AB8FJ: W9ML  TED HERE IN LOVELAND OHIO NEAR CINCINNATI. WAS 67F YESTERDAY.");
  });

  it("multi-frame Normal message mixing JSC and Huffman data frames", () => {
    expect(fmt(buildMessageFrames("AB8FJ", "", "W9ML", "GM FROM COLD OHIO. SEEING SNOW FLURRIES", false, false, Submode.Normal))).toEqual([
      "QBbmEVBguLy0:1",
      "ue-uEivjPIf2:0",
      "-YM+EjVSboF+:2",
    ]);
    expect(fmt(buildMessageFrames("AB8FJ", "", "W9ML", "WINDS ARE STILL GUSTING TO 40 MPH. ", false, false, Submode.Normal))).toEqual([
      "QBbmEVBguLy0:1",
      "to+FbdUwA+++:0",
      "utlWuZt2tdF0:0",
      "v2++++++++++:2",
    ]);
  });

  it("long Fast message with punctuation and a double space", () => {
    expect(
      fmt(buildMessageFrames("WW4GPL", "", "W9ML", "YEAH, I'M RUNNING A YAESU FT DX-10 HERE WITH A VERTICAL HAM STICK MULTI-BAND ON 75 WATTS.", false, false, Submode.Fast)),
    ).toEqual(["UygI1VBguLy0:1", "Yi53NUWtTm4h:4", "gpm8SEIl3l5V:4", "+XbdrnQSc0l+:4", "g799it0cNYi2:4", "fpI1++++++++:6"]);
    expect(fmt(buildMessageFrames("AB8FJ", "", "W9ML", "CLDY 36F ON SAT, 40F ON SUN. MASON JUST A FEW MILES  NORTH OF ME.", false, false, Submode.Fast))).toEqual([
      "QBbmEVBguLy0:1",
      "VGsp4GCos44+:4",
      "Xjmg1cNaKgGl:4",
      "lBXBp3IljDV+:4",
      "Z8Jw9ZbzOUWZ:4",
      "a3++++++++++:6",
    ]);
  });
});

describe("buildMessageFrames on representative messages", () => {
  it("@HB HEARTBEAT EN61 is one heartbeat frame", () => {
    const frames = buildMessageFrames("W9ML", "EN61", "", "@HB HEARTBEAT EN61", false, false, Submode.Normal);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.i3).toBe(TransmissionType.First | TransmissionType.Last);
    const d = unpackFrame(frames[0]!.frame, frames[0]!.i3);
    expect(d.frameType).toBe(FrameType.Heartbeat);
    expect(d.message).toBe("W9ML: @HB HEARTBEAT EN61 ");
    // W9ML's 50-bit callsign field, as seen in K2MJ's compound-directed reply "J+4UccwCO+k8"
    expect(frames[0]!.frame.slice(1, 9)).toBe("+4UccwCO");
  });

  it("CQ variants set the alt bit and the CQ number", () => {
    for (const cq of ["CQ CQ CQ", "CQ DX", "CQ QRP", "CQ CONTEST", "CQ FIELD", "CQ FD", "CQ CQ", "CQ"]) {
      const frames = buildMessageFrames("W9ML", "EN61", "", `@ALLCALL ${cq} EN61`, false, false, Submode.Normal);
      expect(frames).toHaveLength(1);
      expect(framesToText(frames)).toBe(`W9ML: @ALLCALL ${cq} EN61 `);
    }
  });

  it('"W9ML: K1ABC SNR?" is one directed frame', () => {
    const { frames, info } = buildMessageFramesWithInfo("W9ML", "EN61", "", "W9ML: K1ABC SNR?", false, false, Submode.Normal);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.i3).toBe(3);
    expect(info).toMatchObject({ dirTo: "K1ABC", dirCmd: " SNR?", dirNum: "" });
    expect(unpackFrame(frames[0]!.frame, 3)).toMatchObject({ from: "W9ML", to: "K1ABC", cmd: " SNR?", message: "W9ML: K1ABC SNR? " });
  });

  it('reply "K1ABC W9ML SNR -12" from K1ABC', () => {
    const { frames, info } = buildMessageFramesWithInfo("K1ABC", "FN42", "", "K1ABC W9ML SNR -12", false, false, Submode.Normal);
    expect(frames).toHaveLength(1);
    expect(info.dirNum).toBe(" -12");
    expect(unpackFrame(frames[0]!.frame, frames[0]!.i3)).toMatchObject({ from: "K1ABC", to: "W9ML", cmd: " SNR", snr: -12, message: "K1ABC: W9ML SNR -12 " });
  });

  it("free text with forced identification goes out as data frames", () => {
    const fast = buildMessageFrames("W9ML", "EN61", "", "HELLO WORLD", true, false, Submode.Fast);
    expect(fast.every((f) => (f.i3 & TransmissionType.Data) !== 0)).toBe(true);
    expect(framesToText(fast, Submode.Fast)).toBe("W9ML: HELLO WORLD");

    const normal = buildMessageFrames("W9ML", "EN61", "", "HELLO WORLD", true, false, Submode.Normal);
    expect(normal.every((f) => (f.i3 & TransmissionType.Data) === 0)).toBe(true);
    expect(framesToText(normal)).toBe("W9ML: HELLO WORLD");
  });

  it("chooses Huffman over JSC in Normal when it carries more characters", () => {
    // characters outside the dictionary's common words favour Huffman
    const text = "XQZJ KQXZ VQZX";
    const huff = packDataMessage(text);
    expect(huff.frame.length).toBe(12);
    const bits = intToBits(unpack72bits(huff.frame).value, 64);
    expect(bits.slice(0, 2)).toEqual([true, false]); // 10 = Huffman
    expect(unpackDataMessage(huff.frame)).toBe(text.slice(0, huff.n));

    const jsc = packDataMessage("THE QUICK BROWN FOX");
    expect(intToBits(unpack72bits(jsc.frame).value, 64).slice(0, 2)).toEqual([true, true]); // 11 = JSC
    expect(unpackDataMessage(jsc.frame)).toBe("THE QUICK BROWN FOX".slice(0, jsc.n));
  });

  it("multi-frame message sets First on the first frame and Last on the last", () => {
    const text = "W9ML: K1ABC HELLO THERE THIS IS A LONGER MESSAGE THAT TAKES SEVERAL FRAMES TO SEND";
    const frames = buildMessageFrames("W9ML", "EN61", "", text, false, false, Submode.Fast);
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[0]!.i3).toBe(TransmissionType.First);
    expect(frames.slice(1, -1).every((f) => f.i3 === TransmissionType.Data)).toBe(true);
    expect(frames[frames.length - 1]!.i3).toBe(TransmissionType.Data | TransmissionType.Last);
    expect(framesToText(frames, Submode.Fast)).toBe("W9ML: K1ABC  HELLO THERE THIS IS A LONGER MESSAGE THAT TAKES SEVERAL FRAMES TO SEND");
  });

  it("compound destination: our compound frame then a compound-directed frame", () => {
    const { frames, info } = buildMessageFramesWithInfo("W9ML", "EN61", "", "VE3/K1ABC SNR?", false, false, Submode.Normal);
    expect(info.dirTo).toBe("VE3/K1ABC");
    expect(frames.map((f) => unpackFrame(f.frame, f.i3).frameType)).toEqual([FrameType.Compound, FrameType.CompoundDirected]);
    expect(frames.map((f) => f.i3)).toEqual([1, 2]);
    expect(framesToText(frames)).toBe("W9ML: VE3/K1ABC SNR? ");
    expect(unpackFrame(frames[0]!.frame, 1).grid).toBe("EN61");
  });

  it("compound source", () => {
    const frames = buildMessageFrames("VE3/K1ABC", "FN03", "", "W9ML SNR?", false, false, Submode.Normal);
    expect(frames).toHaveLength(2);
    expect(framesToText(frames)).toBe("VE3/K1ABC: W9ML SNR? ");
  });

  it("@ALLCALL with free text", () => {
    const frames = buildMessageFrames("W9ML", "EN61", "", "@ALLCALL NET TONIGHT 0100Z", false, false, Submode.Fast);
    expect(unpackFrame(frames[0]!.frame, frames[0]!.i3)).toMatchObject({ frameType: FrameType.Directed, to: "@ALLCALL", cmd: " " });
    expect(framesToText(frames, Submode.Fast)).toBe("W9ML: @ALLCALL  NET TONIGHT 0100Z");
  });

  it("relay K1ABC>W9XYZ MSG ... carries a CRC-16 checksum on the buffered text", () => {
    const { frames, info } = buildMessageFramesWithInfo("W9ML", "EN61", "", "W9ML: K1ABC>W9XYZ MSG HELLO WORLD", false, false, Submode.Normal);
    expect(info).toMatchObject({ dirTo: "K1ABC", dirCmd: ">" });
    expect(isCommandChecksumed(">")).toBe(16);
    const head = unpackFrame(frames[0]!.frame, frames[0]!.i3);
    expect(head).toMatchObject({ from: "W9ML", to: "K1ABC", cmd: ">", message: "W9ML: K1ABC> " });
    const body = frames.slice(1).map((f) => unpackFrame(f.frame, f.i3).message).join("");
    const sum = checksum16("W9XYZ MSG HELLO WORLD");
    expect(body).toBe(`W9XYZ MSG HELLO WORLD ${sum}`);
    expect(checkBufferedMessage(">", body)).toEqual({ valid: true, message: "W9XYZ MSG HELLO WORLD", checksum: sum });
    expect(checkBufferedMessage(">", body.replace("HELLO", "HULLO")).valid).toBe(false);
  });

  it("@APRSIS MSG skips the checksum", () => {
    const frames = buildMessageFrames("W9ML", "EN61", "", "@APRSIS MSG HELLO", false, false, Submode.Fast);
    expect(framesToText(frames, Submode.Fast)).toBe("W9ML: @APRSIS MSG HELLO");
  });

  it("forceData sends everything as data", () => {
    const frames = buildMessageFrames("W9ML", "EN61", "K1ABC", "K1ABC SNR?", true, true, Submode.Fast);
    expect(frames.every((f) => unpackFrame(f.frame, f.i3).frameType === FrameType.Data)).toBe(true);
  });

  it("stops (instead of spinning like JS8Call) on text nothing can encode", () => {
    const { frames, info } = buildMessageFramesWithInfo("W9ML", "EN61", "", "hello", false, false, Submode.Fast);
    expect(frames).toEqual([]);
    expect(info.unencoded).toBe("hello");
  });
});

describe("frame round trips", () => {
  it("heartbeat and CQ", () => {
    const hb = packHeartbeatMessage("HB EM73", "KN4CRD");
    expect(hb.n).toBe(7);
    expect(unpackFrame(hb.frame, 3).message).toBe("KN4CRD: @HB HEARTBEAT EM73 ");
    const cq = packHeartbeatMessage("CQ DX EM73", "KN4CRD");
    expect(unpackFrame(cq.frame, 3)).toMatchObject({ isAlt: true, hb: "CQ DX", grid: "EM73" });
    const nogrid = packHeartbeatMessage("@HB HEARTBEAT", "W9ML");
    expect(unpackFrame(nogrid.frame, 3).message).toBe("W9ML: @HB HEARTBEAT  ");
    // "HEARTBEAT SNR" is a command, not a heartbeat
    expect(packHeartbeatMessage("HEARTBEAT SNR +05", "W9ML").n).toBe(0);
  });

  it("compound with grid, compound directed with command and SNR", () => {
    const c = packCompoundMessage("`KN4CRD/P EM73");
    expect(c.n).toBe(14);
    expect(unpackFrame(c.frame, 1)).toMatchObject({ frameType: FrameType.Compound, compound: "KN4CRD/P", grid: "EM73", extra: " EM73" });
    const d = packCompoundMessage("`VE3/LB9YHX ACK");
    expect(unpackFrame(d.frame, 2)).toMatchObject({ frameType: FrameType.CompoundDirected, to: "VE3/LB9YHX", cmd: " ACK", message: "VE3/LB9YHX ACK " });
    const s = packCompoundMessage("`W9ML/M SNR -07");
    expect(unpackFrame(s.frame, 2)).toMatchObject({ to: "W9ML/M", cmd: " SNR", snr: -7, message: "W9ML/M SNR -07 " });
    const g = packCompoundMessage("`@RACES SNR?");
    expect(unpackFrame(g.frame, 2).message).toBe("@RACES SNR? ");
  });

  it("directed: every command survives", () => {
    const cmds = [" SNR?", " DIT DIT", " HEARING?", " GRID?", ">", " STATUS?", " STATUS", " HEARING", " MSG", " MSG TO:", " QUERY", " QUERY MSGS", " QUERY CALL", " GRID", " INFO?", " INFO", " FB", " HW CPY?", " SK", " RR", " QSL?", " QSL", " CMD", " NO", " YES", " 73", " NACK", " ACK", " AGN?"];
    for (const cmd of cmds) {
      const p = packDirectedMessage(`K1ABC${cmd}`, "W9ML");
      expect(p.n, cmd).toBe(5 + cmd.length);
      expect(unpackFrame(p.frame, 3).message, cmd).toBe(`W9ML: K1ABC${cmd} `);
    }
    // "?" is the compat spelling of SNR? and comes back as " SNR?" (QMap key order)
    expect(unpackFrame(packDirectedMessage("K1ABC?", "W9ML").frame, 3).message).toBe("W9ML: K1ABC SNR? ");
  });

  it("directed: portable calls, SNR range clamping, groups", () => {
    const p = packDirectedMessage("K1ABC/P SNR +31", "W9ML/P");
    // /P is not compound: it rides in the portable bits of the directed frame
    expect(unpackFrame(p.frame, 3).message).toBe("W9ML/P: K1ABC/P SNR +31 ");
    // any other suffix is compound, so the from field becomes the placeholder
    expect(unpackFrame(packDirectedMessage("K1ABC SNR?", "W9ML/M").frame, 3).message).toBe("<....>: K1ABC SNR? ");
    for (const snr of [-30, -12, -1, 0, 5, 30, 31]) {
      const q = packDirectedMessage(`K1ABC SNR ${snr}`, "W9ML");
      expect(unpackFrame(q.frame, 3).snr).toBe(snr);
    }
    const g = packDirectedMessage("@ALLCALL QUERY MSGS", "W9ML");
    expect(unpackFrame(g.frame, 3).message).toBe("W9ML: @ALLCALL QUERY MSGS ");
  });

  it("Normal and fast data frames", () => {
    const text = "THIS IS A TEST";
    const d = packDataMessage(text);
    expect(d.n).toBe(text.length);
    expect(unpackDataMessage(d.frame)).toBe(text);
    const f = packFastDataMessage(text);
    expect(f.n).toBe(text.length);
    expect(unpackFastDataMessage(f.frame)).toBe(text);
    expect(unpackFrame(f.frame, TransmissionType.Data).message).toBe(text);
  });

  it("72-bit packing", () => {
    const v = 0xfedcba9876543210n;
    const frame = pack72bits(v, 0xa5);
    expect(frame).toHaveLength(12);
    expect([...frame].every((c) => ALPHABET72.includes(c))).toBe(true);
    expect(unpack72bits(frame)).toEqual({ value: v, rem: 0xa5 });
    expect(pack72bits(0n, 0)).toBe("000000000000");
    expect(pack72bits(0xffffffffffffffffn, 0xff)).toBe("++++++++++++"); // only the first 64 symbols are reachable
  });
});

describe("packing primitives", () => {
  it("callsigns (28-bit WSJT-X scheme)", () => {
    // " K1ABC": ((((36*36+20)*10+1)*27+0)*27+1)*27+2
    expect(packCallsign("K1ABC")).toEqual({ packed: 259047992, portable: false });
    expect(unpackCallsign(259047992, false)).toBe("K1ABC");
    expect(packCallsign("W9ML/P")).toMatchObject({ portable: true });
    expect(unpackCallsign(packCallsign("W9ML/P").packed, true)).toBe("W9ML/P");
    expect(unpackCallsign(packCallsign("3DA0XYZ").packed, false)).toBe("3DA0XYZ");
    expect(unpackCallsign(packCallsign("3XA1B").packed, false)).toBe("3XA1B");
    expect(packCallsign("@ALLCALL").packed).toBe(37 * 36 * 10 * 27 * 27 * 27 + 2);
    expect(unpackCallsign(packCallsign("@QRO").packed, false)).toBe("@QRO");
    expect(packCallsign("TOOLONGCALL").packed).toBe(0);
  });

  it("50-bit alphanumeric", () => {
    for (const s of ["KN4CRD/QRP", "VE3/LB9YHX", "@RACES", "W9ML", "HP3/VA3QR"]) {
      expect(unpackAlphaNumeric50(packAlphaNumeric50(s))).toBe(s);
    }
  });

  it("grids", () => {
    for (const g of ["EN61", "DM62", "AA00", "RR99", "FN42", "JO65", "QF56"]) expect(unpackGrid(packGrid(g))).toBe(g);
    expect(packGrid("")).toBe(32767);
    expect(unpackGrid(32767)).toBe("");
    expect(parseGrids("EN61 RR73 DM62ab")).toEqual(["EN61", "DM62"]);
  });

  it("numbers and SNR formatting", () => {
    expect(packNum("")).toEqual({ value: 0, ok: false });
    expect(packNum("-12")).toEqual({ value: 19, ok: true });
    expect(packNum("+99")).toEqual({ value: 62, ok: true });
    expect(packNum("-99")).toEqual({ value: 1, ok: true });
    expect(formatSNR(-3)).toBe("-03");
    expect(formatSNR(0)).toBe("+00");
    expect(formatSNR(12)).toBe("+12");
    expect(formatSNR(61)).toBe("");
  });

  it("base-41 16-bit packing", () => {
    expect(pack16bits(0)).toBe("000");
    expect(unpack16bits(pack16bits(65535))).toBe(65535);
    expect(unpack16bits("???")).toBe(0); // 70643 overflows 16 bits
  });

  it("bit helpers", () => {
    expect(bitsToStr(intToBits(5, 8))).toBe("00000101");
    expect(bitsToInt(intToBits(0x1234n, 16))).toBe(0x1234n);
  });
});

describe("checksums", () => {
  it("use CRC-16/KERMIT and CRC-32/BZIP2 (standard check values)", () => {
    expect(crc16Kermit(ascii("123456789"))).toBe(0x2189);
    expect(crc32Bzip2(ascii("123456789"))).toBe(0xfc891918);
  });

  it("render in base 41", () => {
    // 0x2189 = 8585 = 5*1681 + 4*41 + 16
    expect(checksum16("123456789")).toBe("54G");
    // 0xFC89 = 64649 -> 38,18,33 ; 0x1918 = 6424 -> 3,33,28 (alphabet[38] is ".")
    expect(checksum32("123456789")).toBe(".IX3XS");
    expect(checksum16Valid("54G", "123456789")).toBe(true);
    expect(checksum32Valid(".IX3XS", "123456789")).toBe(true);
    expect(checksum16Valid("54H", "123456789")).toBe(false);
  });
});

describe("callsign validation and command tables", () => {
  it("valid and compound callsigns", () => {
    expect(isValidCallsign("W9ML")).toEqual({ valid: true, isCompound: false });
    expect(isValidCallsign("VE3/K1ABC")).toEqual({ valid: true, isCompound: true });
    expect(isValidCallsign("@ALLCALL")).toEqual({ valid: true, isCompound: false });
    expect(isValidCallsign("@GHOSTNET")).toEqual({ valid: true, isCompound: true });
    expect(isValidCallsign("HELLO").valid).toBe(false);
    expect(isCompoundCallsign("W9ML/P")).toBe(false); // /P is part of the base pattern
    expect(isCompoundCallsign("W9ML/M")).toBe(true);
    expect(isCompoundCallsign("W9ML")).toBe(false);
    expect(parseCallsigns("HELLO W9ML DE VE3/K1ABC EN61")).toEqual(["W9ML", "VE3/K1ABC"]);
  });

  it("command sets", () => {
    expect(directedCmdKey(0)).toBe(" SNR?");
    expect(directedCmdKey(12)).toBe(" QUERY MSGS");
    expect(directedCmdKey(31)).toBe(" ");
    expect(isCommandAutoreply(" SNR?")).toBe(true);
    expect(isCommandAutoreply(" SNR")).toBe(false);
    expect(isCommandBuffered(" MSG")).toBe(true);
    expect(isCommandBuffered(">")).toBe(true);
    expect(isCommandBuffered("?")).toBe(false);
    expect(isCommandChecksumed(" MSG")).toBe(16);
    expect(isCommandChecksumed(" GRID")).toBe(0);
  });
});

describe("escapes", () => {
  it("round trip non-ASCII characters", () => {
    expect(escape("73 de Jörg")).toBe("73 de J\\U00f6rg");
    expect(unescape("73 de J\\U00f6rg")).toBe("73 de Jörg");
    expect(unescape("U+00e9t\\u00e9")).toBe("été");
  });
});

describe("JSC compression", () => {
  it("dictionary lookups", () => {
    expect(jscLookup("HELLO")).toEqual({ index: 6571, ok: true });
    expect(jscLookup("JS8CALL")).toEqual({ index: 71, ok: true });
    expect(jscLookup("hello").ok).toBe(false);
    expect(jscExists("HELLO").exists).toBe(true);
    expect(jscExists("HELLOX").exists).toBe(false);
    // "@" is a single-character prefix, so "@ALLCALL" is never matched as a whole word
    expect(jscLookup("@ALLCALL")).toEqual({ index: 54, ok: true });
    expect(jscEntry(262143)).toEqual({ str: "ROSIDS", size: 1 });
  });

  it("dense codewords", () => {
    // 6571 = 938*7 + 5 ; 938 -> continuers 7,8,11,8 then stopper 5 with separator bit
    expect(bitsToStr(jscCodeword(6571, false))).toBe("0111" + "1000" + "1011" + "1000" + "01010");
    expect(bitsToStr(jscCodeword(0, true))).toBe("00001");
    expect(jscDecompress(jscCodeword(6571, true))).toBe("HELLO ");
  });

  it("compress/decompress round trip", () => {
    for (const text of ["HELLO WORLD", "CQ CQ DE W9ML", "  LEADING", "A  B", "73 TNX FER QSO.", "WX IS 45F AND CLDY"]) {
      const bits = jscCompress(text).flatMap((p) => p.bits);
      expect(jscDecompress(bits)).toBe(text);
    }
  });

  it("reproduces the ROSIDS table quirk", () => {
    // the entry claims size 1: it consumes "R" but decodes as the whole word
    const pairs = jscCompress("ROSIDS");
    expect(pairs[0]!.chars).toBe(1);
    expect(jscDecompress(pairs.flatMap((p) => p.bits)).startsWith("ROSIDS")).toBe(true);
  });
});
