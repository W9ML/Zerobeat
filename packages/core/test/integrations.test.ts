import { describe, expect, it } from "vitest";
import forge from "node-forge";
import { createVerify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readP12, buildTq8, signData, lotwMode, mhz, type LotwContact } from "../src/integrations/lotw.ts";
import { classifyEqslReply } from "../src/integrations/eqsl.ts";
import { parseQrzReply } from "../src/integrations/qrz.ts";
import { renderTemplate, unsubscribeToken, verifyUnsubscribe } from "../src/qsl/queue.ts";
import { renderCard } from "../src/qsl/card.ts";
import sharp from "sharp";

function makeP12(password: string) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.UTC(2024, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2030, 0, 1));
  const attrs = [{ type: "1.3.6.1.4.1.12348.1.1", value: "W9ML" }, { name: "commonName", value: "Michael L" }];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: "commonName", value: "Test CA" }]);
  const der = (s: string) => forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.IA5STRING, false, s)).getBytes();
  cert.setExtensions([
    { id: "1.3.6.1.4.1.12348.1.2", value: der("2025-01-01") },
    { id: "1.3.6.1.4.1.12348.1.3", value: der("2028-12-31") },
    { id: "1.3.6.1.4.1.12348.1.4", value: der("291") },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

describe("LoTW", () => {
  const p12 = makeP12("pw123");
  it("reads a TQSL-style p12 with callsign, DXCC and QSO window", () => {
    const c = readP12(p12, "pw123");
    expect(c.callsign).toBe("W9ML");
    expect(c.dxcc).toBe(291);
    expect(c.qsoStart).toBe(Date.UTC(2025, 0, 1));
    expect(c.qsoEnd).toBe(Date.UTC(2028, 11, 31));
    expect(() => readP12(p12, "wrong")).toThrow(/password/i);
  });
  it("signs every contact with a signature that verifies, excluding out-of-window ones", () => {
    const cert = readP12(p12, "pw123");
    const st = { callsign: "W9ML", dxcc: 291, grid: "EN61jk", state: "IN", county: "Porter", cqZone: 4, ituZone: 8 };
    const qs: LotwContact[] = [
      { id: "a", callsign: "JA1XYZ", band: "20M", mode: "FT8", submode: null, freqHz: 14_074_500, propMode: null, satName: null, startTime: Date.UTC(2026, 9, 19, 23, 5, 7) },
      { id: "b", callsign: "K1ABC", band: "40M", mode: "MFSK", submode: "FT4", freqHz: 7_047_500, propMode: null, satName: null, startTime: Date.UTC(2026, 9, 19, 1, 0, 0) },
      { id: "c", callsign: "OLD1", band: "40M", mode: "CW", submode: null, freqHz: null, propMode: null, satName: null, startTime: Date.UTC(2020, 0, 1) },
    ];
    expect(signData(st, qs[0]!)).toBe("4EN61JK8PORTERIN20MJA1XYZ14.0745FT82026-10-1923:05:07Z");
    const tq8 = buildTq8(cert, st, qs);
    expect(tq8.included).toEqual(["a", "b"]);
    expect(tq8.excluded[0]!.id).toBe("c");
    const body = gunzipSync(tq8.gz).toString("utf8");
    expect(body).toContain("<Rec_Type:5>tCERT");
    expect(body).toContain("<MODE:3>FT4");
    const sigs = [...body.matchAll(/<SIGN_LOTW_V2\.0:(\d+):6>([^\n]+)\n<SIGNDATA:(\d+)>([^\n]+)/g)];
    expect(sigs).toHaveLength(2);
    for (const m of sigs) {
      expect(Number(m[1])).toBe(m[2]!.length + 1);
      expect(createVerify("RSA-SHA1").update(m[4]!, "utf8").verify(cert.certPem, m[2]!, "base64")).toBe(true);
    }
  }, 30000);
  it("maps modes the way LoTW names them", () => {
    expect(lotwMode("MFSK", "FT4")).toBe("FT4");
    expect(lotwMode("FT8")).toBe("FT8");
    expect(lotwMode("SSB", "USB")).toBe("SSB");
    expect(lotwMode("MFSK", "OLIVIA4")).toBe("DATA");
    expect(mhz(14_074_000)).toBe("14.074");
  });
});

describe("eQSL reply classification", () => {
  it("separates sent, duplicate, rejected and auth", () => {
    expect(classifyEqslReply("<BODY>Result: 1 out of 1 records added<BR></BODY>").status).toBe("sent");
    expect(classifyEqslReply("Warning: Y=2026 Bad record: Duplicate<BR>Result: 0 out of 1 records added").status).toBe("duplicate");
    expect(classifyEqslReply("Warning: Y=2026 Bad Mode: FT2<BR>Result: 0 out of 1 records added").status).toBe("rejected");
    expect(classifyEqslReply("Error: No match on eQSL_User/eQSL_Pswd").status).toBe("auth");
  });
});

describe("QRZ reply parsing", () => {
  it("parses pairs and keeps the ADIF tail verbatim", () => {
    const r = parseQrzReply("RESULT=OK&COUNT=1&ADIF=&lt;call:4&gt;W9ML&lt;eor&gt;&more=1");
    expect(r.RESULT).toBe("OK");
    expect(r.ADIF).toBe("<call:4>W9ML<eor>&more=1");
  });
});

describe("QSL", () => {
  const q = { callsign: "JA1XYZ", name: "Taro Yamada", startTime: Date.UTC(2026, 9, 19, 23, 5), band: "20M", mode: "FT8", submode: null, rstSent: "-10", rstRcvd: "-12", myGrid: null, freqHz: 14_074_000 } as any;
  it("renders templates", () => {
    expect(renderTemplate("{call} de {mycall} {date} {time} {band} {mode} {rst_sent} {name} {unknown}", q, { callsign: "W9ML", grid: "EN61" }, "")).toBe("JA1XYZ de W9ML 2026-10-19 23:05 20m FT8 -10 Taro {unknown}");
  });
  it("signs unsubscribe links", () => {
    process.env.ZEROBEAT_SECRET_KEY = "11".repeat(32);
    const t = unsubscribeToken("ja1xyz");
    expect(verifyUnsubscribe("JA1XYZ", t)).toBe(true);
    expect(verifyUnsubscribe("JA1XYA", t)).toBe(false);
  });
  it("renders a card without artwork", async () => {
    const jpg = await renderCard(q, { callsign: "W9ML" }, { imagePath: "/nonexistent.png", settings: { "qsl.card.tableX": 0.05, "qsl.card.tableY": 0.72, "qsl.card.tableWidth": 0.9, "qsl.card.textColor": "#111111", "qsl.card.backgroundColor": "#ffffffdd" } });
    const m = await sharp(jpg).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.width).toBe(1600);
  });
});
