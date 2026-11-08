import { describe, expect, it } from "vitest";
import { parseAdif, recordToContact, qsoToAdif, adifField, dupeKey } from "../src/adif/adif.ts";
import type { Qso } from "../src/db/schema.ts";

describe("adif parse", () => {
  it("parses header and records with byte-accurate lengths", () => {
    const doc = parseAdif("hello\n<ADIF_VER:5>3.1.4 <EOH>\n<CALL:4>W9ML <NAME:6>Zoë A <QSO_DATE:8>20261019<TIME_ON:4>2305<BAND:3>20m<MODE:3>FT4<EOR>\n<CALL:5>K1ABC<eor>");
    expect(doc.header.ADIF_VER).toBe("3.1.4");
    expect(doc.records).toHaveLength(2);
    expect(doc.records[0]!.NAME).toBe("Zoë A");
    expect(doc.records[1]!.CALL).toBe("K1ABC");
  });
  it("accepts files without a header and a trailing record without EOR", () => {
    const doc = parseAdif("<CALL:4>W9ML<BAND:3>40M");
    expect(doc.records).toEqual([{ CALL: "W9ML", BAND: "40M" }]);
    const d2 = parseAdif("<CALL:4>W9ML<eor><CALL:4>N0CA<BAND:3>20M");
    expect(d2.records).toHaveLength(2);
  });
});

describe("adif record mapping", () => {
  it("maps FT4 to MFSK/FT4, keeps unknown fields, derives band from freq", () => {
    const r = recordToContact({
      CALL: "k1abc", QSO_DATE: "20261019", TIME_ON: "230507", BAND: "40M", FREQ: "14.080500", MODE: "MFSK", SUBMODE: "FT4",
      RST_SENT: "-10", RST_RCVD: "-12", GRIDSQUARE: "fn42", CONTEST_ID: "WW-DIGI", SRX_STRING: "FN42", CNTY: "IN,Porter", STATE: "in",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.qso;
    expect(q.callsign).toBe("K1ABC");
    expect(q.band).toBe("20M");
    expect(q.freqHz).toBe(14_080_500);
    expect(q.mode).toBe("MFSK");
    expect(q.submode).toBe("FT4");
    expect(q.grid).toBe("FN42");
    expect(q.county).toBe("Porter");
    expect(q.state).toBe("IN");
    expect(JSON.parse(q.extras!)).toEqual({ CONTEST_ID: "WW-DIGI", SRX_STRING: "FN42" });
    expect(r.value.warnings.some((w) => w.includes("disagrees"))).toBe(true);
  });
  it("keeps modes it has never heard of", () => {
    const r = recordToContact({ CALL: "W1AW", QSO_DATE: "20200101", TIME_ON: "0000", BAND: "20M", MODE: "Q65" });
    expect(r.ok && [r.value.qso.mode, r.value.qso.submode]).toEqual(["MFSK", "Q65"]);
    const u = recordToContact({ CALL: "W1AW", QSO_DATE: "20200101", TIME_ON: "0000", BAND: "20M", MODE: "NEWMODE" });
    expect(u.ok && u.value.qso.mode).toBe("NEWMODE");
  });
  it("carries POTA n-fers", () => {
    const r = recordToContact({ CALL: "N7XAK", QSO_DATE: "20261019", TIME_ON: "1911", BAND: "20M", MODE: "FT8", SIG: "POTA", SIG_INFO: "US-1234", APP_ZEROBEAT_SIGREFS: "US-1234,US-5678" });
    expect(r.ok && r.value.sigRefs).toEqual([{ sig: "POTA", ref: "US-1234" }, { sig: "POTA", ref: "US-5678" }]);
    const z = recordToContact({ CALL: "N7XAK", QSO_DATE: "20261019", TIME_ON: "1911", BAND: "20M", MODE: "FT8", SIG: "POTA", SIG_INFO: "US-1234", APP_ZEROBEAT_SIGREFS: "US-1234,US-9999", APP_ZEROBEAT_TRANSCRIPT: "CQ N7XAK" });
    expect(z.ok && z.value.sigRefs.map((x) => x.ref)).toEqual(["US-1234", "US-9999"]);
    expect(z.ok && z.value.qso.transcript).toBe("CQ N7XAK");
  });
  it("rejects records it cannot place", () => {
    expect(recordToContact({ CALL: "W1AW", QSO_DATE: "2020", TIME_ON: "0000", BAND: "20M", MODE: "CW" }).ok).toBe(false);
    expect(recordToContact({ CALL: "W1AW", QSO_DATE: "20200101", TIME_ON: "0000", MODE: "CW" }).ok).toBe(false);
  });
});

describe("adif write", () => {
  it("counts bytes, not characters", () => {
    expect(adifField("NAME", "Zoë")).toBe("<NAME:4>Zoë");
  });
  it("round-trips a contact including extras", () => {
    const r = recordToContact({ CALL: "JA1XYZ", QSO_DATE: "20261019", TIME_ON: "2305", TIME_OFF: "0001", FREQ: "14.074", MODE: "FT8", NAME: "Taro", CONTEST_ID: "X" });
    if (!r.ok) throw new Error(r.error);
    const q = { id: "x", stationId: "s", operatorId: null, clientId: null, createdAt: 0, updatedAt: 0, ...r.value.qso } as unknown as Qso;
    const text = qsoToAdif(q, { callsign: "W9ML", grid: "EN61jk" }, [], { full: true });
    const back = parseAdif(text).records[0]!;
    expect(back.CALL).toBe("JA1XYZ");
    expect(back.QSO_DATE_OFF).toBe("20261020");
    expect(back.TIME_OFF).toBe("000100");
    expect(back.FREQ).toBe("14.074000");
    expect(back.CONTEST_ID).toBe("X");
    expect(back.STATION_CALLSIGN).toBe("W9ML");
    expect(back.MY_GRIDSQUARE).toBe("EN61jk");
  });
  it("builds a minute dupe key", () => {
    expect(dupeKey({ callsign: "w1aw", band: "20M", mode: "MFSK", submode: "FT4", startTime: Date.UTC(2026, 0, 1, 0, 0, 59) }))
      .toBe(dupeKey({ callsign: "W1AW", band: "20M", mode: "MFSK", submode: "FT4", startTime: Date.UTC(2026, 0, 1, 0, 0, 1) }));
  });
});
