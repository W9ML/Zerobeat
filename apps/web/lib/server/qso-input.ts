/** Validation for contacts created or edited through the API (web form and v1). */
import "server-only";

import { z } from "zod";

import { bandForHz, normaliseBand, bandByName } from "@zerobeat/core/ham/bands";
import { isGrid } from "@zerobeat/core/ham/grid";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { QSL_ROUTE, QSL_STATUS } from "@zerobeat/core/db/schema";

const opt = <T extends z.ZodType>(s: T) => s.optional().nullable();
const str = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v));

export const QsoBody = z
  .object({
    clientId: opt(z.string().max(64)),
    stationId: opt(z.string().max(40)),
    callsign: z.string().trim().min(3).max(16).transform(normaliseCallsign).refine(looksLikeCallsign, "not a callsign"),
    // "14,074" from a keypad that uses a decimal comma is 14.074, not an error or null.
    freqMHz: opt(z.preprocess((v) => (typeof v === "string" ? v.trim().replace(",", ".") : v), z.coerce.number().positive().max(7_500_000))),
    band: opt(z.string().max(8)),
    mode: z.string().trim().min(1).max(16),
    submode: opt(str(16)),
    startTime: z.coerce.number().int().positive(),
    endTime: opt(z.coerce.number().int().positive()),
    rstSent: opt(str(12)),
    rstRcvd: opt(str(12)),
    txPowerW: opt(z.coerce.number().int().min(0).max(2000)),
    grid: opt(str(10).refine((g) => g === null || isGrid(g), "not a grid locator")),
    name: opt(str(64)),
    qth: opt(str(96)),
    state: opt(str(8)),
    county: opt(str(64)),
    dxcc: opt(z.coerce.number().int().min(1).max(999)),
    cqZone: opt(z.coerce.number().int().min(1).max(40)),
    ituZone: opt(z.coerce.number().int().min(1).max(90)),
    iota: opt(str(16)),
    email: opt(str(120)),
    notes: opt(str(2000)),
    qslSent: z.enum(QSL_STATUS).optional(),
    qslRcvd: z.enum(QSL_STATUS).optional(),
    qslSentVia: opt(z.enum(QSL_ROUTE)),
    qslRcvdVia: opt(z.enum(QSL_ROUTE)),
    mySigInfo: opt(str(32)),
    myGrid: opt(str(10)),
    parks: opt(z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}-\d{4,6}$/, "park references look like US-1234")).max(10)),
  })
  .transform((b, ctx) => {
    const hz = b.freqMHz ? Math.round(b.freqMHz * 1e6) : null;
    // The frequency decides the band. A band given as well must agree with it: the form
    // always sends its dropdown, and a 7.074 MHz contact used to be stored as 20M.
    const fromHz = hz ? (bandForHz(hz)?.name ?? null) : null;
    const given = b.band ? normaliseBand(b.band) : null;
    if (hz && !fromHz) {
      ctx.addIssue({ code: "custom", message: `${b.freqMHz} MHz is not in an amateur band`, path: ["freqMHz"] });
      return z.NEVER;
    }
    if (fromHz && given && fromHz !== given) {
      ctx.addIssue({ code: "custom", message: `${b.freqMHz} MHz is on ${fromHz}, not ${given}`, path: ["band"] });
      return z.NEVER;
    }
    let band = fromHz ?? given;
    if (!band) {
      ctx.addIssue({ code: "custom", message: "give a frequency or a band", path: ["band"] });
      return z.NEVER;
    }
    const freqHz = hz ?? bandByName(band)!.lowHz;
    const { parks, freqMHz: _f, mySigInfo, ...rest } = b;
    return {
      ...rest,
      band,
      freqHz,
      mySig: mySigInfo ? "POTA" : null,
      mySigInfo: mySigInfo?.toUpperCase() ?? null,
      sigRefs: parks?.map((ref) => ({ sig: "POTA", ref })) ?? undefined,
    };
  });

export type QsoBodyT = z.infer<typeof QsoBody>;
