"use client";
import Link from "next/link";
import { useMemo, useState, useEffect } from "react";

import { Badge, Button, Card, cn, Dot, Notice, Select } from "@/components/ui";
import { clearDecodes, control, useLive, type EngineSnapshot, type SlimDecode } from "@/lib/client/live";
import { parseDial } from "@/lib/dial";
import { duration, mhz, utcTime } from "@/lib/format";

import { FoldCard } from "@/components/fold";
import { AwayStrip } from "@/components/away-strip";
import { ArrangedCards, useCardOrder, type CardSlot } from "@/components/arrange";
import { usePopped } from "@/lib/client/popout";
import { useMedia } from "@/lib/client/media";

import { KeyboardChat, KeyboardContactCard } from "./keyboard";
import { SstvLogCard, SstvPanel, SstvSendCard } from "./sstv";
import { WsprPanel } from "./wspr";
import { JS8_PERIOD_SEC, Js8Panel, Js8SideCard } from "./js8";
import { HeardByCard, SpotsCard, WantedCard } from "./panels";
import { Waterfall } from "./waterfall";
import { CycleBar } from "./cycle-bar";
import { StationCard } from "./station-card";
import { ContestDesk } from "./contest-desk";
import { DistanceUnitContext } from "@/lib/client/units";
import { fmtDistance } from "@/lib/distance";

const BANDS = ["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "2M"];
const FT4_BANDS = new Set(["80M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "2M"]);
type OpMode = EngineSnapshot["mode"];
/** The bands each mode has a frequency on (the engine's CALLING_FREQS). */
const MODE_BANDS: Partial<Record<OpMode, Set<string>>> = {
  FT4: FT4_BANDS,
  JTTY: new Set(["160M", "80M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "2M"]),
  RTTY: new Set(["80M", "40M", "20M", "17M", "15M", "12M", "10M"]),
  SSTV: new Set(["80M", "40M", "20M", "15M", "10M", "6M"]),
  CW: new Set(["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M"]),
  PSK31: new Set(["160M", "80M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M"]),
  HELL: new Set(["80M", "40M", "20M"]),
  JS8: new Set(["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "2M"]),
};
/** The engine's list for the band plan in use; the built-in sets until it says. */
const bandsOf = (snap: EngineSnapshot, m: OpMode): string[] => snap.radio.bands?.[m] ?? BANDS.filter((b) => MODE_BANDS[m]?.has(b) ?? true);
const hasBand = (snap: EngineSnapshot, m: OpMode, b: string) => bandsOf(snap, m).includes(b);

/**
 * In a freely tuned mode: keep the dial as your own frequency for this band (the band
 * button goes there from now on), or go back to the built-in one.
 */
function BandFreqNote({ snap, act, canOperate }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  const f = snap.radio.bandFreq;
  if (!f || !canOperate) return null;
  const name = `${f.band.toLowerCase()} ${MODE_LABEL[f.mode as OpMode] ?? f.mode}`;
  const usual = f.mine ?? f.builtIn;
  const at = (hz: number) => (hz / 1e6).toFixed(4);
  if (usual === snap.dialHz) {
    if (!f.mine) return null;
    return (
      <div className="mt-1 text-[11px] text-subtle">
        Your {name} frequency ·{" "}
        <button type="button" disabled={act.busy} onClick={() => void act.run("/band-freq", { reset: true })} className="underline hover:text-fg">
          {f.builtIn ? `use the built-in ${at(f.builtIn)}` : "forget it"}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-1 text-[11px] text-subtle">
      <button type="button" disabled={act.busy} onClick={() => void act.run("/band-freq", {})} className="underline hover:text-fg" title={`The ${f.band.toLowerCase()} button will tune here in this mode`}>
        Save as my {name} frequency
      </button>
      {usual ? ` (the ${f.band.toLowerCase()} button goes to ${at(usual)})` : ""}
    </div>
  );
}

/** The dial readout; operators click it to type a frequency. */
function DialEntry({ snap, act, canOperate }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  if (text === null)
    return (
      <button
        type="button"
        disabled={!canOperate}
        title={canOperate ? "Click to type a frequency" : undefined}
        onClick={() => {
          setText((snap.dialHz / 1e6).toFixed(4));
          setBad(false);
        }}
        className="group flex items-center gap-1.5 font-mono text-2xl font-semibold tabular leading-none enabled:hover:text-accent-strong disabled:cursor-default"
      >
        {mhz(snap.dialHz)}
        {canOperate && (
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 text-subtle group-hover:text-accent-strong" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" />
          </svg>
        )}
      </button>
    );
  const go = async () => {
    const hz = parseDial(text);
    if (!hz) return setBad(true);
    setText(null);
    await act.run("/tune", { hz });
  };
  return (
    <input
      autoFocus
      aria-label="Frequency in MHz"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") void go();
        if (e.key === "Escape") setText(null);
      }}
      onBlur={() => setText(null)}
      inputMode="decimal"
      placeholder="MHz"
      className={cn("w-40 rounded-md border bg-panel-2 px-2 py-0.5 font-mono text-2xl font-semibold tabular", bad ? "border-bad" : "border-line-strong")}
    />
  );
}
const MODES: OpMode[] = ["FT8", "FT4", "FT2", "JTTY", "RTTY", "PSK31", "CW", "HELL", "SSTV", "WSPR", "JS8"];
const MODE_HELP: Record<OpMode, string> = {
  FT8: "FT8: 15-second slots",
  FT4: "FT4: 7.5-second slots",
  FT2: "FT2: 3.75-second slots (Decodium)",
  JTTY: "JTTY: keyboard chat from WSJT-X 3.2, untimed",
  RTTY: "RTTY: 45.45 baud, 170 Hz shift",
  PSK31: "PSK31: keyboard chat, 31.25 baud",
  CW: "CW: Morse, sent as a keyed tone",
  HELL: "Hell: Feld Hell, text printed as a picture you read by eye",
  SSTV: "SSTV: pictures, Martin, Scottie, Robot and PD modes",
  WSPR: "WSPR: two-minute beacons, propagation to and from you",
  JS8: "JS8: JS8Call's keyboard network, directed messages, heartbeats and store-and-forward",
};
const MODE_LABEL: Partial<Record<OpMode, string>> = { PSK31: "PSK", HELL: "Hell" };
const AUTO: { id: EngineSnapshot["auto"]["mode"]; label: string; help: string }[] = [
  { id: "off", label: "Off", help: "Nothing automatic. Click a station to call it." },
  { id: "cq", label: "CQ", help: "Call CQ and work whoever answers." },
  { id: "hunt", label: "Hunt", help: "Call the most valuable CQ each cycle." },
  { id: "hunt-pota", label: "POTA hunt", help: "Call POTA activators calling CQ POTA." },
  { id: "pota-chase", label: "POTA chase", help: "Follow the POTA spot feed and call activators." },
];
const PHASES = ["calling", "report-sent", "rreport-sent", "rr73-sent", "signing-off"];
const PHASE_LABEL: Record<string, string> = {
  calling: "Calling",
  "report-sent": "Report sent",
  "rreport-sent": "R-report sent",
  "rr73-sent": "RR73 sent",
  "signing-off": "73",
  done: "Done",
  abandoned: "Stopped",
};

type Filter = "all" | "cq" | "me" | "new";

export function useAction() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setErr(null);
    const r = await control(path, body);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "failed");
    return r.ok;
  };
  return { err, busy, run, clear: () => setErr(null) };
}

export function OperateView({ canOperate, me }: { canOperate: boolean; me: string }) {
  const { snap, decodes, windows, activity, status, needed, keyLines } = useLive();
  const wide = useMedia("(min-width: 1280px)");
  const act = useAction();
  const [filter, setFilter] = useState<Filter>("all");
  const [js8Sel, setJs8Sel] = useState<string | null>(null);
  const popped = usePopped();
  const allSlots = snap ? sideSlots({ snap, act, canOperate, decodes, needed, activity, keyLines, js8Sel, setJs8Sel }) : [];
  const columnId = !snap ? "ft" : snap.mode === "JS8" ? "js8" : snap.mode === "WSPR" ? "wspr" : snap.mode === "SSTV" ? "sstv" : snap.keyboard.mode ? "keys" : "ft";
  const { ordered, order, setOrder } = useCardOrder(columnId, allSlots);

  if (!snap) {
    return (
      <div className="mx-auto max-w-xl pt-10">
        <Notice tone={status === "engine-down" ? "bad" : "info"}>
          {status === "engine-down" ? "The engine is not running. Start the zerobeat-engine service." : "Connecting to the engine…"}
        </Notice>
      </div>
    );
  }

  const connected = snap.radio.link === "connected";
  const isKeys = !!snap.keyboard.mode;
  const isSstv = snap.mode === "SSTV";
  const isWspr = snap.mode === "WSPR";
  const isJs8 = snap.mode === "JS8";
  const isFt = !isKeys && !isJs8 && !isWspr && !isSstv;
  // The cards that own the job right now: beside the decodes on a wide screen, above
  // everything on a phone or narrow window (they used to be two screens down).
  const lead = !wide && isFt ? ordered.filter((c) => c.lead) : [];
  const side = ordered.filter((c) => !lead.includes(c));
  return (
    <DistanceUnitContext.Provider value={snap.distanceUnit ?? "mi"}>
      <div className="mx-auto max-w-[1600px] space-y-4">
        <ControlBar snap={snap} act={act} canOperate={canOperate} me={me} />
        <RadioRequest snap={snap} act={act} me={me} />
        <AwayStrip />
        {act.err && (
          <Notice tone="bad">
            {act.err}{" "}
            <button className="ml-2 underline" onClick={act.clear}>
              dismiss
            </button>
          </Notice>
        )}
        {!connected && <Notice tone="warn">{snap.ft0 ? "FT-0 is engaged: the radio is released and transmit is off." : `Radio: ${snap.radio.detail || snap.radio.link}`}</Notice>}
        {snap.auto.paused?.cause === "fault" ? (
          <Notice tone="bad">
            <span className="font-semibold">Transmitting stopped:</span> {snap.auto.paused.reason}.
            {canOperate && (
              <button className="ml-3 rounded-md border border-bad px-2 py-0.5 text-xs font-medium hover:bg-bad/10" onClick={() => void act.run("/rearm")}>
                Re-arm
              </button>
            )}
          </Notice>
        ) : (
          snap.tx.blocked && snap.tx.allowed && connected && !snap.ft0 && <Notice tone="info">Transmit is blocked: {snap.tx.blocked}.</Notice>
        )}
        {lead.length > 0 && (
          <div className="space-y-4">
            <ArrangedCards slots={lead} order={order} setOrder={setOrder} popped={popped} />
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-4">
            <Card pad={false}>
              <Waterfall
                txHz={snap.txOffsetHz}
                qsoHz={!isKeys && !isSstv && !isWspr && !isJs8 && snap.qso && !["done", "abandoned"].includes(snap.qso.phase) ? snap.qso.txOffsetHz : null}
                onPick={canOperate ? (hz) => void act.run("/tx-offset", { hz }) : undefined}
                cycleSec={isJs8 ? JS8_PERIOD_SEC[snap.js8.submode] : isWspr ? 120 : isKeys || isSstv ? 60 : snap.mode === "FT2" ? 3.75 : snap.mode === "FT4" ? 7.5 : 15}
              />
            </Card>
            {isJs8 ? (
              <Js8Panel snap={snap} run={act.run} busy={act.busy} canOperate={canOperate} selected={js8Sel} setSelected={setJs8Sel} />
            ) : isWspr ? (
              <WsprPanel snap={snap} />
            ) : isSstv ? (
              <SstvPanel snap={snap} />
            ) : isKeys ? (
              <KeyboardChat snap={snap} lines={keyLines} run={act.run} busy={act.busy} canOperate={canOperate} />
            ) : (
              <DecodeList decodes={decodes} windows={windows} snap={snap} filter={filter} setFilter={setFilter} canOperate={canOperate} act={act} />
            )}
          </div>
          <div className="min-w-0 space-y-4">
            {/* Drag a card by its title bar to move it; ⧉ on hover opens it in its own window. */}
            <ArrangedCards slots={side} order={order} setOrder={setOrder} popped={popped} />
          </div>
        </div>
      </div>
    </DistanceUnitContext.Provider>
  );
}

const LICENSE_NAME: Record<string, string> = { T: "Technician", G: "General", A: "Advanced", E: "Amateur Extra" };

/** Who has the radio, the control operator, and the privileges that apply. */
function OperatorChip({ snap, act, canOperate, me }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean; me: string }) {
  const h = snap.radio.holder;
  const c = snap.radio.controlOp;
  const label = (p: NonNullable<typeof h>) => `${p.callsign ?? p.name}${p.licenseClass ? ` (${LICENSE_NAME[p.licenseClass]})` : ""}`;
  const mine = h?.userId === me;
  const asked = snap.radio.radioRequest?.userId === me;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={cn("rounded-full border px-2 py-0.5", snap.radio.privilegeBlock ? "border-bad text-bad" : mine ? "border-accent text-fg" : "border-line-strong text-muted")} title={snap.radio.privilegeBlock ?? undefined}>
        {h ? <>{mine ? "You have the radio" : <>{label(h)} has the radio</>}</> : "Nobody has operated yet"}
        {c && c.userId !== h?.userId && <> · control op {label(c)}</>}
      </span>
      <BookingNote snap={snap} me={me} />
      {canOperate && h && !mine && !asked && !(snap.radio.booking?.holding && snap.radio.booking.current?.userId !== me) && (
        <button className="font-medium text-accent-strong underline hover:text-fg" disabled={act.busy} title="Yours at once if it is idle; otherwise they have 30 seconds to keep it" onClick={() => void act.run("/radio/request")}>
          Ask for the radio
        </button>
      )}
      {canOperate &&
        (c ? (
          <button className="text-muted underline hover:text-fg" disabled={act.busy} onClick={() => void act.run("/control", { take: false })}>
            Release control
          </button>
        ) : (
          <button className="text-muted underline hover:text-fg" disabled={act.busy} title="Be the control operator: your license's privileges apply while someone else operates" onClick={() => void act.run("/control", { take: true })}>
            Take control
          </button>
        ))}
    </div>
  );
}

/** Radio time booked now or next (today), linking to the bookings. */
function BookingNote({ snap, me }: { snap: EngineSnapshot; me: string }) {
  const b = snap.radio.booking;
  if (!b) return null;
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const name = (x: NonNullable<typeof b.current>) => (x.userId === me ? "you" : (x.callsign ?? x.name));
  let text: string | null = null;
  if (b.current) text = b.holding ? `Booked by ${name(b.current)} until ${t(b.current.endsAt)}` : `Booked by ${name(b.current)} until ${t(b.current.endsAt)}, not signed in: radio open`;
  else if (b.next && b.next.startsAt - Date.now() < 12 * 3_600_000) text = `Next booked: ${name(b.next)} at ${t(b.next.startsAt)}`;
  if (!text) return null;
  return (
    <Link href="/bookings" className={cn("rounded-full border px-2 py-0.5 hover:text-fg", b.current && b.holding && b.current.userId !== me ? "border-warn text-warn" : "border-line-strong text-muted")} title="Radio time: who has the radio booked">
      {text}
    </Link>
  );
}

/**
 * A request for the radio: the holder can keep it or hand it over (no answer in 30 s
 * hands it over); the one who asked sees it counting down.
 */
function RadioRequest({ snap, act, me }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; me: string }) {
  const r = snap.radio.radioRequest;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!r) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [r]);
  if (!r) return null;
  const left = Math.max(0, Math.ceil((r.until - now) / 1000));
  const who = r.callsign ?? r.name;
  if (snap.radio.holder?.userId === me) {
    return (
      <Notice tone="warn">
        <span className="font-semibold">{who} asked for the radio.</span> It goes to them in {left} s unless you keep it; your automatic stops and any contact ends.
        <span className="ml-3 inline-flex gap-2">
          <Button size="sm" variant="primary" disabled={act.busy} onClick={() => void act.run("/radio/answer", { release: false })}>
            Keep it
          </Button>
          <Button size="sm" variant="secondary" disabled={act.busy} onClick={() => void act.run("/radio/answer", { release: true })}>
            Hand it over
          </Button>
        </span>
      </Notice>
    );
  }
  if (r.userId === me) {
    const h = snap.radio.holder;
    return <Notice tone="info">You asked {h?.callsign ?? h?.name ?? "the operator"} for the radio: it is yours in {left} s unless they keep it.</Notice>;
  }
  return null;
}

interface SlotProps {
  snap: EngineSnapshot;
  act: ReturnType<typeof useAction>;
  canOperate: boolean;
  decodes: SlimDecode[];
  needed: ReturnType<typeof useLive>["needed"];
  activity: ReturnType<typeof useLive>["activity"];
  keyLines: ReturnType<typeof useLive>["keyLines"];
  js8Sel: string | null;
  setJs8Sel: (c: string | null) => void;
}

/**
 * The cards beside the decodes, in their default order, for the mode on now. The operator
 * can reorder them (components/arrange.tsx) and open any of them in its own window
 * (app/pop/[card]). A card with nothing to show has node null.
 */
export function sideSlots({ snap, act, canOperate, decodes, needed, activity, keyLines, js8Sel, setJs8Sel }: SlotProps): CardSlot[] {
  const isKeys = !!snap.keyboard.mode;
  const contestOn = snap.auto.contest.id !== "none";
  const inContact = !!snap.qso && !["done", "abandoned"].includes(snap.qso.phase);
  const common: CardSlot[] = [
    { id: "spots", label: "Spots", node: <SpotsCard snap={snap} canOperate={canOperate} /> },
    { id: "radio", label: "Radio", node: <RadioCard snap={snap} /> },
    { id: "heard", label: "Heard by", node: <HeardByCard lastTxAt={snap.tx.last?.ok ? snap.tx.last.at : null} canOperate={canOperate} /> },
    { id: "activity", label: "Activity", node: <Activity lines={activity} /> },
  ];
  const contest: CardSlot = { id: "contest", label: "Contest", node: <ContestDesk snap={snap} run={act.run} busy={act.busy} canOperate={canOperate} />, lead: contestOn };
  if (snap.mode === "JS8") return [{ id: "js8", label: "JS8", node: <Js8SideCard snap={snap} run={act.run} busy={act.busy} canOperate={canOperate} selected={js8Sel} setSelected={setJs8Sel} /> }, ...common];
  if (snap.mode === "WSPR") return common;
  if (snap.mode === "SSTV")
    return [
      { id: "sstv-log", label: "Log a contact", node: <SstvLogCard snap={snap} canOperate={canOperate} /> },
      { id: "sstv-send", label: "Send a picture", node: <SstvSendCard snap={snap} canOperate={canOperate} /> },
      ...common,
    ];
  if (isKeys) {
    const his = snap.keyboard.ctx.hisCall;
    return [
      { id: "keyboard-contact", label: "Contact", node: <KeyboardContactCard snap={snap} lines={keyLines} run={act.run} busy={act.busy} canOperate={canOperate} /> },
      {
        id: "station",
        label: "Station",
        hint: "when a call is entered",
        node: /^[A-Z0-9/]{3,}$/.test(his) && /\d/.test(his) ? <StationCard call={his} grid={null} band={snap.band} mode={snap.keyboard.mode ?? "JTTY"} /> : null,
      },
      contest,
      ...common,
    ];
  }
  const q = snap.qso;
  const ft: CardSlot[] = [
    // Both stay put between contacts (showing the last one), so the column does not jump.
    { id: "contact", label: "Contact", node: <QsoCard snap={snap} act={act} canOperate={canOperate} />, lead: inContact },
    { id: "station", label: "Station", node: q ? <StationCard call={q.them} grid={q.grid} band={snap.band} mode={snap.mode} /> : <NoStation />, lead: inContact },
    { id: "wanted", label: "Wanted on the air", node: <WantedCard needed={needed} canOperate={canOperate} />, lead: true },
    { id: "callers", label: "Calling you", hint: "when someone calls you", node: snap.callers.length > 0 ? <Callers snap={snap} decodes={decodes} act={act} canOperate={canOperate} /> : null },
    { id: "auto", label: "Automatic", node: <AutoCard snap={snap} act={act} canOperate={canOperate} /> },
  ];
  // A contest running leads; otherwise it is a line under Automatic.
  return contestOn ? [contest, ...ft, ...common] : [...ft, contest, ...common];
}

function ControlBar({ snap, act, canOperate, me }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean; me: string }) {
  const [power, setPower] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const shownPower = power ?? snap.radio.rfPowerPct;
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 max-sm:py-2">
        <div className="max-sm:flex max-sm:w-full max-sm:items-center max-sm:gap-3">
          <DialEntry snap={snap} act={act} canOperate={canOperate} />
          <div className="mt-1 text-xs text-muted max-sm:mt-0">
            {snap.band ?? "out of band"} · <span className="max-sm:hidden">{snap.radio.sliceMode ?? "—"} · slice {snap.radio.sliceIndex ?? "—"}</span>
            <span className="sm:hidden">{MODE_LABEL[snap.mode] ?? snap.mode}</span>
          </div>
          <BandFreqNote snap={snap} act={act} canOperate={canOperate} />
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="ml-auto rounded-md border border-line-strong px-2 py-1 text-xs text-muted sm:hidden">
            {more ? "Less" : "Band & mode"}
          </button>
        </div>
        <div className={cn("contents", !more && "max-sm:hidden")}>
        {/* Ten modes do not fit a phone: the strip scrolls sideways there. */}
        <div className="flex max-w-full overflow-x-auto rounded-md border border-line-strong">
          {MODES.map((m) => (
            <button
              key={m}
              title={MODE_HELP[m]}
              disabled={!canOperate || act.busy || (!!snap.band && !hasBand(snap, m, snap.band))}
              onClick={() => snap.band && void act.run("/tune", { band: snap.band, mode: m })}
              className={cn("shrink-0 px-3 py-1.5 text-sm font-medium disabled:opacity-40", snap.mode === m ? "bg-accent text-white" : "bg-panel-2 text-muted hover:text-fg")}
            >
              {MODE_LABEL[m] ?? m}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {bandsOf(snap, snap.mode).map((b) => {
            // Outside the privileges that apply: still tunable (listening is always
            // allowed), drawn struck through, and transmitting there is refused.
            const noPriv = snap.radio.privilegeBands?.[b] === false;
            // Band memory: a bar under the band for what it usually holds at this hour.
            const yv = snap.radio.bandYield?.[b];
            const yMax = Math.max(1, ...Object.values(snap.radio.bandYield ?? {}).map((v) => v.avg));
            const yTitle = yv && yv.samples >= 2 ? `Usually ${yv.avg} stations a window at this hour (${yv.samples} days of band memory)` : undefined;
            return (
            <button
              key={b}
              disabled={!canOperate || act.busy}
              title={[noPriv ? `Receive only: a ${LICENSE_NAME[snap.radio.licenseClass ?? "T"]} license has no ${MODE_LABEL[snap.mode] ?? snap.mode} privileges on ${b.toLowerCase()}` : null, yTitle].filter(Boolean).join(". ") || undefined}
              onClick={() => void act.run("/tune", { band: b, mode: snap.mode })}
              className={cn(
                "relative h-7 overflow-hidden rounded-md border px-2 font-mono text-xs disabled:opacity-40",
                snap.band === b ? "border-accent bg-accent-soft text-accent-strong" : "border-line-strong bg-panel-2 text-muted hover:text-fg",
                noPriv && "line-through opacity-60",
              )}
            >
              {b.toLowerCase()}
              {yv && yv.samples >= 2 && (
                <span className="absolute inset-x-0 bottom-0 h-[3px] bg-ok/25" aria-hidden>
                  <span className="block h-full bg-ok" style={{ width: `${Math.max(8, Math.round((yv.avg / yMax) * 100))}%` }} />
                </span>
              )}
            </button>
            );
          })}
        </div>
        <OperatorChip snap={snap} act={act} canOperate={canOperate} me={me} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span
            className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", snap.tx.allowed ? "border-accent text-accent-strong" : "border-line-strong text-muted")}
            title="Arm or disarm transmit with the switch at the top of the page"
          >
            {snap.tx.allowed ? "TX armed" : "TX off"}
          </span>
          {snap.radio.powerNote && (
            <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn" title="Effective radiated power: transmitter power less feed-line loss, times antenna gain over a dipole.">
              {snap.radio.powerNote}
            </span>
          )}
          <label className="flex items-center gap-2 text-xs text-muted">
            Power
            <input
              type="range"
              min={1}
              max={100}
              value={shownPower}
              disabled={!canOperate}
              onChange={(e) => setPower(Number(e.target.value))}
              onMouseUp={() => power !== null && void act.run("/power", { pct: power }).then(() => setPower(null))}
              onTouchEnd={() => power !== null && void act.run("/power", { pct: power }).then(() => setPower(null))}
              onKeyUp={() => power !== null && void act.run("/power", { pct: power }).then(() => setPower(null))}
              onBlur={() => power !== null && void act.run("/power", { pct: power }).then(() => setPower(null))}
              className="w-24 accent-[var(--color-accent)]"
            />
            <span className="w-9 font-mono text-fg">{shownPower}%</span>
          </label>
          {snap.radio.atu && (
            <Button size="sm" disabled={!canOperate || act.busy || !!snap.tx.blocked} onClick={() => void act.run("/atu")}>
              ATU
            </Button>
          )}
        </div>
        </div>
      </div>
    </Card>
  );
}

/** "United States of America" is "USA" in a row; long entity names keep their start. */
function shortCountry(name: string): string {
  const SHORT: Record<string, string> = { "United States of America": "USA", "United States": "USA", "European Russia": "Russia", "Asiatic Russia": "Russia (AS)", "Federal Republic of Germany": "Germany", "Fed. Rep. of Germany": "Germany", "United Kingdom": "UK", "England": "England" };
  const s = SHORT[name] ?? name;
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

/** A badge's text, short: "new DXCC (Japan)" is "DXCC", "new grid FN31" is "grid". */
function shortReason(r: string): string {
  const m = /^new (DXCC|grid|state|zone|continent|park|band)/i.exec(r);
  if (m) return `new ${m[1]!.toUpperCase() === "DXCC" ? "DXCC" : m[1]!.toLowerCase()}`;
  return r.length > 14 ? `${r.slice(0, 13)}…` : r;
}

function worthTone(d: SlimDecode): "ok" | "info" | "neutral" {
  if (!d.worth) return "neutral";
  const r = d.worth.reasons.filter((x) => x !== "never worked");
  return r.length ? "ok" : d.worth.reasons.length ? "info" : "neutral";
}

function DecodeList({
  decodes,
  windows,
  snap,
  filter,
  setFilter,
  canOperate,
  act,
}: {
  decodes: SlimDecode[];
  windows: { index: number; decodeMs: number; skipped: string | null; ownTx: boolean; count: number; start: number }[];
  snap: EngineSnapshot;
  filter: Filter;
  setFilter: (f: Filter) => void;
  canOperate: boolean;
  act: ReturnType<typeof useAction>;
}) {
  const unit = snap.distanceUnit ?? "mi";
  const shown = useMemo(() => {
    const f = decodes.filter((d) => {
      if (filter === "cq") return d.kind === "cq";
      if (filter === "me") return d.kind === "to-me" || d.kind === "from-me";
      if (filter === "new") return d.kind === "cq" && worthTone(d) === "ok";
      return true;
    });
    // Window numbers are per mode (an FT2 window is a quarter of an FT8 one), so group by
    // mode and number, and order by when the window started: newest first.
    const byWindow = new Map<string, SlimDecode[]>();
    for (const d of f) {
      const k = `${d.mode}:${d.w}`;
      const list = byWindow.get(k);
      if (list) list.push(d);
      else byWindow.set(k, [d]);
    }
    return [...byWindow.entries()].sort((a, b) => b[1][0]!.at - a[1][0]!.at).slice(0, 12);
  }, [decodes, filter]);
  const last = windows.at(-1);

  const periodSec = snap.mode === "FT2" ? 3.75 : snap.mode === "FT4" ? 7.5 : 15;

  async function call(d: SlimDecode) {
    if (!canOperate || !d.from || act.busy) return; // a double-click is one call
    await act.run("/call", { callsign: d.from, offsetHz: d.f, windowIndex: d.w, snr: d.snr, grid: d.grid, text: d.text });
  }

  // On a touch screen a scroll that ends on a row is a tap, and one tap used to call
  // the station: the first tap picks the row, a second tap on it calls.
  const [armed, setArmed] = useState<{ key: string; at: number } | null>(null);
  function tap(d: SlimDecode, rowKey: string, e: React.MouseEvent) {
    const touch = (e.nativeEvent as PointerEvent).pointerType === "touch";
    if (!touch || (armed?.key === rowKey && Date.now() - armed.at < 5000)) {
      setArmed(null);
      void call(d);
    } else setArmed({ key: rowKey, at: Date.now() });
  }

  return (
    <Card
      pad={false}
      title={
        <span className="flex items-center gap-2">
          Decodes
          {last && (
            <span className="text-xs font-normal text-muted">
              {last.skipped ? last.skipped : `${last.count} in the last window${last.decodeMs > 1800 ? ` · slow decode, ${last.decodeMs} ms` : ""}${!snap.qso && canOperate ? " · click a CQ to call it" : ""}`}
            </span>
          )}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={clearDecodes} disabled={decodes.length === 0} className="rounded-md border border-line-strong bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40" title="Empty the list. New decodes keep coming in.">
          Clear
        </button>
        <div className="flex overflow-hidden rounded-md border border-line-strong text-xs">
          {(
            [
              ["all", "All"],
              ["cq", "CQ"],
              ["new", "Needed"],
              ["me", "Mine"],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("px-2.5 py-1", filter === k ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}>
              {l}
            </button>
          ))}
        </div>
        </div>
      }
    >
      <CycleBar periodSec={periodSec} engineNow={snap.now} transmitting={snap.radio.transmitting} />
      {shown.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">{snap.radio.link === "connected" ? "Waiting for the next window…" : "No decodes while the radio is disconnected."}</div>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto font-mono text-[13px]">
          <div className="sticky top-0 z-[2] grid grid-cols-[34px_56px_1fr_auto] items-center gap-2 border-b border-line bg-panel px-3 py-0.5 font-sans text-[10px] text-subtle sm:grid-cols-[34px_38px_56px_1fr_auto]" aria-hidden>
            <span className="text-right" title="Signal to noise, dB">dB</span>
            <span className="hidden text-right sm:block" title="Time offset, seconds">DT</span>
            <span className="text-right" title="Audio offset, Hz">Hz</span>
            <span>Message</span>
            <span className="text-right">Where</span>
          </div>
          {shown.map(([key, rows]) => (
            <div key={key}>
              <div className="sticky top-[17px] z-[1] flex items-center gap-2 border-y border-line bg-panel-2 px-3 py-1 text-[11px] text-subtle">
                <span>{utcTime(rows[0]!.at, true)}Z</span>
                <span>{rows[0]!.mode}</span>
                <span>· {rows.length}</span>
                <span title={(rows[0]!.w & 1) === 0 ? "Even slot: :00 and :30 in FT8" : "Odd slot: :15 and :45 in FT8"}>· {(rows[0]!.w & 1) === 0 ? "even" : "odd"}</span>
              </div>
              {[...rows]
                .sort((a, b) => a.f - b.f)
                .map((d, i) => {
                  const clickable = canOperate && !!d.from && (d.kind === "cq" || d.kind === "to-me");
                  const rowKey = `${key}-${d.f}-${d.from}`;
                  const isArmed = armed?.key === rowKey;
                  return (
                    <div
                      key={`${key}-${i}`}
                      onClick={(e) => clickable && tap(d, rowKey, e)}
                      className={cn(
                        "grid grid-cols-[34px_56px_1fr_auto] items-center gap-2 px-3 py-[3px] pointer-coarse:py-2 sm:grid-cols-[34px_38px_56px_1fr_auto]",
                        clickable && "cursor-pointer hover:bg-panel-3",
                        isArmed && "ring-2 ring-inset ring-accent",
                        d.contest?.dupe && "opacity-50",
                        d.kind === "to-me" && "bg-me-soft",
                        d.kind === "from-me" && "bg-accent-soft",
                      )}
                      title={clickable ? `Call ${d.from}` : undefined}
                    >
                      <span className={cn("text-right tabular", d.snr >= -10 ? "text-fg" : "text-muted")}>{d.snr}</span>
                      <span className="hidden text-right tabular text-subtle sm:block">{d.dt.toFixed(1)}</span>
                      <span className="text-right tabular text-subtle">{d.f}</span>
                      <span className={cn("min-w-0 truncate", d.kind === "cq" && "text-info", d.kind === "to-me" && "font-semibold text-me", d.kind === "from-me" && "text-accent-strong")}>
                        {d.text}
                        {d.ap && <span className="ml-1 text-[10px] text-subtle">a{""}</span>}
                        {isArmed && <span className="ml-2 font-sans text-xs text-accent-strong">tap again to call {d.from}</span>}
                      </span>
                      <span className="flex items-center justify-end gap-1 font-sans">
                        {(d.country || d.km != null) && (
                          <span className="hidden whitespace-nowrap text-[11px] text-muted md:inline" title={d.country ?? undefined}>
                            {d.country ? shortCountry(d.country) : ""}
                            {d.km != null && <span className="text-subtle">{d.country ? " · " : ""}{fmtDistance(d.km, unit)}</span>}
                          </span>
                        )}
                        {d.contest?.dupe && <Badge title="Worked already on this band in the contest: no points">dupe</Badge>}
                        {d.contest?.mult && <Badge tone="ok" title="A new multiplier in the contest">mult</Badge>}
                        {d.mod === "POTA" && <Badge tone="ok">POTA</Badge>}
                        {d.worth && worthTone(d) === "ok" && (
                          <Badge tone="ok" title={d.worth.reasons.join(", ")}>
                            {shortReason(d.worth.reasons[0]!)}
                          </Badge>
                        )}
                        {d.worth && worthTone(d) === "info" && <Badge tone="info">new call</Badge>}
                      </span>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The station card before the first contact: one line, picked up to drag like the rest. */
function NoStation() {
  return (
    <section className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2" data-drag>
      <h2 className="text-[13px] font-semibold tracking-wide text-fg">Station</h2>
      <span className="text-xs text-muted">who you work, with the map</span>
    </section>
  );
}

/** The UDP feed (GridTracker, Log4OM…) on and off, keeping its address in Settings. */
function UdpFeedSwitch({ feed, act, canOperate }: { feed: { on: boolean; name: string; targets: string }; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  const name = feed.name.trim() || feed.targets.split(/[,;\n]+/)[0]!.trim().split(/\s+/)[0]!;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="min-w-0">
        <span className="text-fg">Send to {name}</span>
        <span className="block truncate text-subtle" title={feed.targets}>
          {feed.on ? "UDP feed on" : "UDP feed off"}
          {feed.name.trim() ? ` · ${feed.targets}` : ""}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={feed.on}
        aria-label={`Send to ${name}`}
        disabled={!canOperate || act.busy}
        onClick={() => void act.run("/udp", { on: !feed.on })}
        className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50", feed.on ? "border-accent bg-accent" : "border-line-strong bg-panel-3")}
      >
        <span className={cn("inline-block size-3.5 rounded-full bg-white transition-transform", feed.on ? "translate-x-4.5" : "translate-x-0.5")} />
      </button>
    </div>
  );
}

function QsoCard({ snap, act, canOperate }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  const q = snap.qso;
  const active = q && !["done", "abandoned"].includes(q.phase);
  const step = q ? PHASES.indexOf(q.phase) : -1;
  return (
    <Card
      title={q && !active ? "Last contact" : "Contact"}
      actions={
        active && canOperate ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void act.run("/skip")}>
              Skip
            </Button>
            <Button size="sm" variant="danger" onClick={() => void act.run("/halt")}>
              Halt
            </Button>
          </>
        ) : null
      }
    >
      {!q ? (
        <p className="text-sm text-muted">
          {snap.auto.mode === "cq" ? "Calling CQ: whoever answers shows here." : snap.auto.mode === "off" ? "Click a CQ in the decodes to call it." : "Hunting: the station it calls shows here."}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="font-mono text-xl font-semibold">{q.them}</div>
            <div className="text-xs text-muted">
              {q.grid ?? ""} {q.park && <Badge tone="ok">{q.park}</Badge>} {q.hound && <Badge tone="info" title="FT8 DXpedition mode: the Fox's rules">Hound</Badge>}
            </div>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {PHASES.map((p, i) => (
              <div key={p} className={cn("h-1.5 rounded-full", q.phase === "abandoned" ? "bg-bad/50" : i <= step || q.phase === "done" ? "bg-accent" : "bg-panel-3")} />
            ))}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className={cn(q.phase === "abandoned" ? "text-bad" : q.phase === "done" ? "text-ok" : "text-fg")}>
              {PHASE_LABEL[q.phase] ?? q.phase}
              {q.logged && " · logged"}
            </span>
            <span className="text-xs text-muted">
              sent {q.phase === "calling" ? "—" : q.reportSent} · rcvd {q.reportRcvd ?? "—"} · try {q.repeats}/{q.maxRepeats}
            </span>
          </div>
          {active && <TxTiming snap={snap} parity={q.ourParity} />}
          {q.reason && <div className="text-xs text-muted">{q.reason}</div>}
          <div className="max-h-48 overflow-y-auto rounded-md border border-line bg-bg p-2 font-mono text-[12px] leading-5">
            {q.transcript.length === 0 && <div className="text-subtle">{snap.radio.transmitting ? "Transmitting the first call…" : "Nothing sent yet."}</div>}
            {/* Newest first, so the latest exchange is where the eye lands. */}
            {[...q.transcript].reverse().map((l, i) => (
              <div key={i} className="grid grid-cols-[58px_78px_1fr_auto] gap-x-2">
                <span className="text-subtle">{utcTime(l.at, true)}</span>
                <span className={cn("truncate font-semibold", l.dir === "tx" ? "text-accent-strong" : "text-me")}>{l.dir === "tx" ? "You" : q.them}</span>
                <span className={l.dir === "tx" ? "text-accent-strong" : "text-fg"}>{l.text}</span>
                <span className={l.live ? "text-accent-strong" : "text-subtle"}>{l.live ? "sending" : l.dir === "rx" && l.snr !== undefined ? `${l.snr} dB` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

const SLOT_TIMES: Record<string, [string, string]> = { FT8: [":00 and :30", ":15 and :45"], FT4: [":00, :15, :30, :45", ":07.5, :22.5, :37.5, :52.5"], FT2: ["every other 3.75 s", "every other 3.75 s"] };

/** Which slot this contact transmits in, and when the next transmission goes out. */
function TxTiming({ snap, parity }: { snap: EngineSnapshot; parity: 0 | 1 }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const at = snap.tx.nextAt;
  const slot = parity === 0 ? "even" : "odd";
  const times = SLOT_TIMES[snap.mode]?.[parity] ?? "";
  let what: string;
  if (snap.radio.transmitting) what = "transmitting now";
  else if (at && at > now) what = `next transmission at ${utcTime(at, true)}Z, in ${Math.ceil((at - now) / 1000)} s`;
  else if (snap.tx.blocked) what = `not transmitting: ${snap.tx.blocked}`;
  else what = "waiting for their next transmission";
  return (
    <div className={cn("text-xs", snap.tx.blocked && !snap.radio.transmitting ? "text-warn" : "text-muted")}>
      You transmit in the <span className="text-fg">{slot}</span> slot{times ? ` (${times})` : ""}: {what}.
    </div>
  );
}

function AutoCard({ snap, act, canOperate }: { snap: EngineSnapshot; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  const a = snap.auto;
  const cur = AUTO.find((x) => x.id === a.mode)!;
  // The choice waits for Start: a dropdown that acts on change starts a run from an arrow key.
  // While a run is going the button stops it; picking another mode turns it into Switch.
  const [pick, setPick] = useState<EngineSnapshot["auto"]["mode"] | null>(null);
  const running = a.mode !== "off";
  const shown = pick ?? (running ? a.mode : "cq");
  const switching = running && pick !== null && pick !== a.mode;
  return (
    <FoldCard
      id="auto"
      title="Automatic"
      summary={a.paused ? `paused: ${a.paused.reason}` : a.mode === "off" ? "off" : `${cur.label} · ${a.qsosThisRun} this run${a.hound ? " · Hound" : ""}`}
      tone={a.paused?.cause === "fault" ? "bad" : a.paused ? "warn" : undefined}
      forceOpen={a.mode !== "off" || !!a.paused}
      actions={a.paused && canOperate ? <Button size="sm" onClick={() => void act.run("/rearm")}>Re-arm</Button> : null}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Select aria-label="Automatic mode" value={shown} disabled={!canOperate || act.busy} onChange={(e) => setPick(e.target.value as EngineSnapshot["auto"]["mode"])} className="flex-1">
            {AUTO.filter((m) => m.id !== "off").map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          {running && !switching ? (
            <Button size="sm" variant="danger" disabled={!canOperate || act.busy} onClick={() => { const was = a.mode; void act.run("/auto", { mode: "off" }).then(() => setPick(was)); }}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!canOperate || act.busy} onClick={() => void act.run("/auto", { mode: shown }).then(() => setPick(null))}>
              {switching ? "Switch" : "Start"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">{(AUTO.find((x) => x.id === shown) ?? cur).help}</p>
        {(shown !== "cq" || a.hound) && (
          <label className="flex items-start gap-2 text-xs" title="WSJT-X Fox and Hound, the mode big DXpeditions use: the Fox works several Hounds at once in the even slot below 1000 Hz, and Hounds call it in the odd slot above 1000 Hz until it moves them.">
            <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={a.hound} disabled={!canOperate || act.busy} onChange={(e) => void act.run("/hound", { on: e.target.checked })} />
            <span>
              <span className="text-fg">Call every station as a Hound (DXpedition mode)</span>
              <span className="block text-muted">Leave off. It only matters for a DXpedition running Fox and Hound, and is turned on by itself for a station seen working as a Fox.</span>
            </span>
          </label>
        )}
        {a.mode === "cq" && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">Call CQ in the</span>
            <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label="CQ slot">
              {([0, 1] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!canOperate || act.busy}
                  onClick={() => void act.run("/cq-slot", { slot: p })}
                  title={SLOT_TIMES[snap.mode]?.[p]}
                  className={cn("px-2.5 py-1", a.cqParity === p ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}
                >
                  {p === 0 ? "Even" : "Odd"}
                </button>
              ))}
            </div>
            <span className="text-subtle">slot</span>
          </div>
        )}
        {snap.udpFeed && <UdpFeedSwitch feed={snap.udpFeed} act={act} canOperate={canOperate} />}
        {(a.mode === "hunt" || a.mode === "hunt-pota") && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted" title="An answer goes out in the slot opposite the CQ: choosing a slot calls only stations calling in the other one.">
              Transmit in
            </span>
            <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label="Hunt slot">
              {([null, 0, 1] as const).map((p) => (
                <button
                  key={String(p)}
                  type="button"
                  disabled={!canOperate || act.busy}
                  onClick={() => void act.run("/hunt-slot", { slot: p })}
                  title={p === null ? "Call anyone, in whichever slot their CQ leaves us" : SLOT_TIMES[snap.mode]?.[p]}
                  className={cn("px-2.5 py-1", (a.huntSlot ?? null) === p ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}
                >
                  {p === null ? "Either" : p === 0 ? "Even" : "Odd"}
                </button>
              ))}
            </div>
            <span className="text-subtle">slot</span>
          </div>
        )}
        {a.paused && (
          <Notice tone={a.paused.cause === "fault" ? "bad" : "warn"}>
            Paused ({a.paused.cause}): {a.paused.reason}
          </Notice>
        )}
        {a.paResting && <Notice tone="warn">PA resting</Notice>}
        {a.mode !== "off" && (
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md bg-panel-2 py-1.5">
              <div className="font-mono text-base text-fg">{a.qsosThisRun}</div>
              <div className="text-muted">this run</div>
            </div>
            <div className="rounded-md bg-panel-2 py-1.5">
              <div className="font-mono text-base text-fg">{a.runStartedAt ? duration(Date.now() - a.runStartedAt) : "—"}</div>
              <div className="text-muted">running</div>
            </div>
            <div className="rounded-md bg-panel-2 py-1.5">
              <div className="font-mono text-base text-fg">{a.unansweredCqs}</div>
              <div className="text-muted">no answer</div>
            </div>
          </div>
        )}
        {a.chase && (
          <div className="text-xs text-muted">
            Waiting for <span className="font-mono text-fg">{a.chase.activator}</span> at {a.chase.park}
          </div>
        )}
        {a.candidates.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted">Best calls last window</div>
            {a.candidates.map((c) => (
              <div key={c.callsign} className="flex items-center justify-between py-0.5 text-xs">
                <Link href={`/call/${encodeURIComponent(c.callsign)}`} className="font-mono text-fg hover:text-accent-strong">{c.callsign}</Link>
                <span className="truncate pl-2 text-right text-muted">{c.reasons.join(", ") || "routine"}</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-[11px] text-subtle">Mode set by {a.source}</div>
      </div>
    </FoldCard>
  );
}

function Callers({ snap, decodes, act, canOperate }: { snap: EngineSnapshot; decodes: SlimDecode[]; act: ReturnType<typeof useAction>; canOperate: boolean }) {
  return (
    <Card title="Calling you">
      <div className="space-y-1">
        {snap.callers.map((c) => (
          <div key={c.callsign} className="flex items-center justify-between gap-2 text-sm">
            <Link href={`/call/${encodeURIComponent(c.callsign)}`} className="font-mono hover:text-accent-strong">{c.callsign}</Link>
            <span className="truncate font-mono text-xs text-muted">{c.text}</span>
            {canOperate && (
              <Button
                size="sm"
                onClick={() => {
                  const d = decodes.find((x) => x.w === c.windowIndex && x.text === c.text);
                  void act.run("/call", { callsign: c.callsign, offsetHz: c.offsetHz, windowIndex: c.windowIndex, snr: c.snr, grid: d?.grid ?? null, text: c.text });
                }}
              >
                Answer
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Meter({ label, value, unit, pct, tone }: { label: string; value: string; unit?: string; pct: number; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-fg">
          {value}
          {unit && <span className="text-muted"> {unit}</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-panel-3">
        <div className={cn("h-full rounded-full", tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-ok")} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

function RadioCard({ snap }: { snap: EngineSnapshot }) {
  const t = snap.radio.telemetry;
  const s = t?.sLevelDbm ?? null;
  const last = snap.tx.last;
  // Near a brake: SWR 2 or more, PA 65 degrees or more. The card opens and colors itself.
  const bad = (t?.swr ?? 0) >= 2.5 || (t?.paTempC ?? 0) >= 70;
  const warn = bad || (t?.swr ?? 0) >= 2 || (t?.paTempC ?? 0) >= 65 || (!!last?.ok && last.fwdW !== null && last.fwdW < 0.5);
  const line = [
    last?.ok && last.fwdW !== null ? `${Math.round(last.fwdW)} W` : null,
    t?.swr != null ? `SWR ${t.swr.toFixed(1)}` : null,
    t?.paTempC != null ? `${t.paTempC.toFixed(0)} °C` : null,
    t?.supplyV != null ? `${t.supplyV.toFixed(1)} V` : null,
  ].filter(Boolean).join(" · ");
  return (
    <FoldCard
      id="radio"
      title="Radio"
      summary={snap.radio.link === "connected" ? line || snap.radio.model : snap.radio.link}
      tone={bad ? "bad" : warn ? "warn" : undefined}
      forceOpen={snap.radio.transmitting || warn}
      actions={
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Dot tone={snap.radio.link === "connected" ? "ok" : "warn"} /> {snap.radio.model ?? snap.radio.link}
        </span>
      }
    >
      <div className="space-y-3">
        <Meter label="Signal" value={s !== null ? s.toFixed(0) : "—"} unit="dBm" pct={s !== null ? ((s + 130) / 90) * 100 : 0} />
        <Meter label="Forward power" value={t?.fwdW != null ? t.fwdW.toFixed(0) : "—"} unit="W" pct={((t?.fwdW ?? 0) / 100) * 100} tone="warn" />
        <Meter label="SWR" value={t?.swr != null ? t.swr.toFixed(1) : "—"} pct={t?.swr ? ((t.swr - 1) / 2) * 100 : 0} tone={t?.swr && t.swr > 2 ? "bad" : "ok"} />
        <Meter label="PA temperature" value={t?.paTempC != null ? t.paTempC.toFixed(0) : "—"} unit="°C" pct={((t?.paTempC ?? 0) / 80) * 100} tone={t?.paTempC && t.paTempC > 65 ? "bad" : "ok"} />
        {snap.tx.last && (
          <div className="rounded-md bg-panel-2 px-2.5 py-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Last transmission</span>
              <span className={snap.tx.last.ok ? (snap.tx.last.fwdW !== null && snap.tx.last.fwdW < 0.5 ? "text-bad" : "text-ok") : "text-warn"}>
                {snap.tx.last.ok ? (snap.tx.last.fwdW !== null ? `${Math.round(snap.tx.last.fwdW)} W${snap.tx.last.swr ? ` · SWR ${snap.tx.last.swr.toFixed(1)}` : ""}` : "sent") : "not sent"}
              </span>
            </div>
            <div className="truncate font-mono text-subtle">{snap.tx.last.message}</div>
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>RX {snap.radio.rxAnt ?? "—"}</span>
          <span>TX {snap.radio.txAnt ?? "—"}</span>
          {t?.supplyV != null && <span>{t.supplyV.toFixed(1)} V</span>}
          {snap.radio.version && (
            <span>
              {snap.radio.type === "hamlib" ? "Hamlib" : snap.radio.type === "icom" ? "Firmware" : "SmartSDR"} {snap.radio.version.split(".").slice(0, 3).join(".")}
            </span>
          )}
        </div>
      </div>
    </FoldCard>
  );
}

function Activity({ lines: all }: { lines: { at: number; level: string; text: string }[] }) {
  const lines = all.filter((l) => l.level !== "state");
  const latest = lines.at(-1);
  return (
    <FoldCard
      id="activity"
      title="Activity"
      summary={latest ? `${utcTime(latest.at)} ${latest.text}` : "nothing yet"}
      pad={false}
      actions={
        <Link href="/runs#activity" className="text-xs text-muted hover:text-fg">
          History
        </Link>
      }
    >
      <div className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5">
        {lines.length === 0 && <div className="text-subtle">Nothing yet.</div>}
        {[...lines].reverse().slice(0, 40).map((l, i) => (
          <div key={i} className={cn(l.level === "warn" && "text-warn", l.level === "tx" && "text-accent-strong", l.level === "log" && "text-ok", l.level === "info" && "text-muted")}>
            <span className="text-subtle">{utcTime(l.at, true)} </span>
            {l.text}
          </div>
        ))}
      </div>
    </FoldCard>
  );
}
