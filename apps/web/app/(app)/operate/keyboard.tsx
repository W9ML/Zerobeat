"use client";
/**
 * The keyboard modes on the Operate page (JTTY, RTTY, PSK31, CW, Hell): everything heard across
 * the passband (Hell: the tape printed at the marker), the conversation at the operator's frequency, a keyboard and eight
 * function keys. These modes are untimed, so Send goes out at once; the engine refuses
 * (with the reason) when transmit is off or a message is still on the air.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, cn, Input, Select } from "@/components/ui";
import { type EngineSnapshot, type HellSpeed, type KeyLine, type KeyMode, type KeyProfile } from "@/lib/client/live";

import { HellSeenBar } from "./hell-seen";
import { HellTape } from "./hell-tape";
import { utcTime } from "@/lib/format";

type Run = (path: string, body?: unknown) => Promise<boolean>;

const FKEY_HELP: Record<string, string> = {
  "CQ %M CQ": "Call CQ",
  "%H %E": "Report and exchange",
  "%H TU CQ %M CQ": "Thanks, and CQ again",
  "%M": "Your call",
  "%H": "Their call",
  "TU NOW %Q %E": "Thanks, then the next station in the queue",
  "%H AGN?": "Ask for a repeat",
  "%E": "Exchange only",
  // RTTY
  "CQ CQ CQ DE %M %M %M K": "Call CQ",
  "%H 599 %X %X": "Report and exchange",
  "%H TU %M CQ": "Thanks, and CQ again",
  "%M %M": "Your call",
  "%H %H": "Their call",
  "%H TU NOW %Q 599 %X %X": "Thanks, then the next station",
  "%H AGN AGN": "Ask for a repeat",
  "599 %X %X": "Exchange only",
  // PSK31
  "CQ CQ CQ de %M %M %M pse k": "Call CQ",
  "%H de %M - UR %E - %H de %M kn": "Report and exchange",
  "%H de %M - TNX QSO 73 - %H de %M sk": "Thanks and 73",
  "%H de %M kn": "Over to them",
  "%H TU - %Q de %M %E": "Thanks, then the next station",
  "%H de %M - pse agn - kn": "Ask for a repeat",
  // CW
  "CQ CQ DE %M %M K": "Call CQ",
  "%H 5NN %X": "Report and exchange",
  "%H TU 73 %M": "Thanks and 73",
  "TU %Q 5NN %X": "Thanks, then the next station",
  "AGN?": "Ask for a repeat",
  "5NN %X": "Exchange only",
  // Hell
  "%H DE %M UR %E %H DE %M K": "Report",
  "%H DE %M TNX QSO 73 %H DE %M SK": "Thanks and 73",
  "%H DE %M K": "Over to them",
  "%H TU %Q DE %M %E": "Thanks, then the next station",
  "%H DE %M PSE AGN K": "Ask for a repeat",
};

const HELL_SPEEDS: { id: HellSpeed; label: string; help: string; adif: string }[] = [
  { id: "feld", label: "Feld Hell", help: "On/off keyed, 2.5 characters a second, about 350 Hz wide: the classic, used on the EU nets", adif: "MODE HELL" },
  { id: "fsk105", label: "FSK Hell 105", help: "FSKH105: two tones 55 Hz apart (ink low), Feld Hell's speed. The Feld Hell Club's North American nets use it", adif: "MODE HELL, SUBMODE FSKHELL" },
  { id: "fsk245", label: "FSK Hell 245", help: "FSKH245: two tones 122.5 Hz apart (ink low), Feld Hell's speed", adif: "MODE HELL, SUBMODE FSKHELL" },
  { id: "hell80", label: "Hell 80", help: "Two tones 300 Hz apart (ink low), twice Feld Hell's speed", adif: "MODE HELL, SUBMODE HELL80" },
  { id: "slow", label: "Slow Hell", help: "An eighth of Feld Hell's speed, about 30 Hz wide, for very weak paths", adif: "MODE HELL, SUBMODE SLOWHELL" },
  { id: "x5", label: "Hell x5", help: "Five times Feld Hell, about 1.5 kHz wide", adif: "MODE HELL, SUBMODE HELLX5" },
  { id: "x9", label: "Hell x9", help: "Nine times Feld Hell, about 2.5 kHz wide", adif: "MODE HELL, SUBMODE HELLX9" },
];

/** The two-tone speeds, which can be sent and printed reversed. */
const HELL_FSK = new Set<HellSpeed>(["fsk105", "fsk245", "hell80"]);

const MODE_NOTE: Record<KeyMode, string> = {
  JTTY: "Text is packed into 1.9-second frames, 5 characters or one call, report or exchange each, up to 16 frames.",
  RTTY: "45.45 baud, 170 Hz shift, Baudot: capitals, figures and a little punctuation. The marker is the center; mark is 85 Hz above it.",
  PSK31: "BPSK at 31.25 baud: any printable character, lower case included (it is quicker to send).",
  CW: "Sent as a clean keyed tone at the marker, so on the air at dial + tone. Prosigns as <AR> <SK> <BT> <KN>.",
  HELL: "Printed, not decoded: each character goes out as a 7×14 grid of dots and you read the tape by eye. Capitals, figures and common punctuation. Put the marker on the signal (FSK Hell: between its two tones; the club's nets are at 1500 Hz).",
};

const PROFILES: { id: KeyProfile; label: string; help: string }[] = [
  { id: "unknown", label: "General", help: "Exchange is a serial number." },
  { id: "field-day", label: "Field Day", help: "Exchange is class and section, like 1D EMA." },
  { id: "rtty-roundup", label: "RTTY Roundup", help: "Exchange is a serial or a state/province." },
];

import { senderOf } from "@/lib/grab-call";

/** The station a line is from, as far as the text says: the CQ caller, else the first call that is not ours. */
export { senderOf };

function exchangeShown(snap: EngineSnapshot): string {
  const c = snap.keyboard.ctx;
  if (c.exchange) return c.exchange;
  return c.serialOn || snap.keyboard.mode === "JTTY" ? String(c.serial).padStart(3, "0") : "";
}

/** A template with its fields filled, for the button label. */
function preview(t: string, snap: EngineSnapshot): string {
  const c = snap.keyboard.ctx;
  return t
    .replace(/%M/g, snap.station?.callsign ?? "MYCALL")
    .replace(/%H/g, c.hisCall || "—")
    .replace(/%Q/g, c.queueCall || "—")
    .replace(/%X/g, exchangeShown(snap))
    .replace(/%E/g, `599 ${exchangeShown(snap)}`.trim())
    .replace(/ {2,}/g, " ")
    .trim();
}

function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

export function KeyboardChat({ snap, lines: all, run, busy, canOperate }: { snap: EngineSnapshot; lines: KeyLine[]; run: Run; busy: boolean; canOperate: boolean }) {
  const [editing, setEditing] = useState(false);
  const me = snap.station?.callsign ?? null;
  const mode = snap.keyboard.mode ?? "JTTY";
  const lines = useMemo(() => all.filter((l) => l.mode === mode), [all, mode]);
  const caps = mode !== "PSK31";
  const [text, setText] = useState("");
  const [onlyRx, setOnlyRx] = useState(false);
  const convoRef = useRef<HTMLDivElement>(null);
  const sending = snap.keyboard.sending;
  const now = useNow(200, !!sending);

  const rxHz = snap.txOffsetHz;
  const conversation = useMemo(() => lines.filter((l) => l.dir === "tx" || l.atRx), [lines]);
  const band = useMemo(() => [...lines].filter((l) => l.dir === "rx" && (!onlyRx || l.atRx)).sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 80), [lines, onlyRx]);

  // The conversation reads top to bottom like a chat; keep the newest line in view.
  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length, conversation.at(-1)?.text]);

  async function send(body: { text?: string; fkey?: number }) {
    if (!canOperate) return;
    const ok = await run("/keyboard/send", body);
    if (ok && body.text !== undefined) setText("");
  }

  // F1–F8 send the function keys, Esc halts, from anywhere on the page.
  useEffect(() => {
    if (!canOperate) return;
    const onKey = (e: KeyboardEvent) => {
      const m = /^F([1-8])$/.exec(e.key);
      if (m && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        void run("/keyboard/send", { fkey: Number(m[1]) });
      } else if (e.key === "Escape" && snap.keyboard.sending) {
        e.preventDefault();
        void run("/keyboard/halt");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canOperate, snap.keyboard.sending, run]);

  function pick(l: KeyLine) {
    if (!canOperate) return;
    void run("/tx-offset", { hz: l.freqHz });
    const who = senderOf(l.text, me);
    if (who && who !== snap.keyboard.ctx.hisCall) void run("/keyboard/context", { hisCall: who });
  }

  const pct = sending ? Math.max(0, Math.min(100, ((now - sending.startedAt) / sending.durationMs) * 100)) : 0;

  return (
    <div className="space-y-4">
      <Card
        pad={false}
        title={
          <span className="flex items-center gap-2">
            {mode}
            <span className="text-xs font-normal text-muted">
              {snap.radio.link !== "connected" ? "radio disconnected" : mode === "HELL" ? `printing at ${rxHz} Hz · ${HELL_SPEEDS.find((s) => s.id === (snap.keyboard.ctx.hellSpeed ?? "feld"))?.label}` : `listening 200–3000 Hz · RX/TX ${rxHz} Hz`}
            </span>
          </span>
        }
        actions={
          canOperate ? (
            <div className="flex items-center gap-3">
            {mode === "CW" && <WpmControl wpm={snap.keyboard.ctx.wpm} run={run} />}
            {mode === "HELL" && (
              <Select
                aria-label="Hell speed"
                value={snap.keyboard.ctx.hellSpeed ?? "feld"}
                onChange={(e) => void run("/keyboard/context", { hellSpeed: e.target.value })}
                title={HELL_SPEEDS.find((s) => s.id === (snap.keyboard.ctx.hellSpeed ?? "feld"))?.help}
                className="h-7 w-auto! text-xs"
              >
                {HELL_SPEEDS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
            {mode === "HELL" && HELL_FSK.has(snap.keyboard.ctx.hellSpeed ?? "feld") && (
              <label className="flex items-center gap-1.5 text-xs text-muted" title="Swap the two tones, sending and printing (as fldigi's Rev). Use it when a station prints as a negative.">
                <input type="checkbox" checked={!!snap.keyboard.ctx.hellReverse} onChange={(e) => void run("/keyboard/context", { hellReverse: e.target.checked })} className="accent-[var(--color-accent)]" />
                Reverse
              </label>
            )}
            <button type="button" onClick={() => void run("/keyboard/clear")} disabled={lines.length === 0 && mode !== "HELL"} className="rounded-md border border-line-strong bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40">
              Clear
            </button>
            </div>
          ) : null
        }
      >
        {mode === "HELL" ? (
          <>
            <HellSeenBar
              rxHz={rxHz}
              speed={snap.keyboard.ctx.hellSpeed ?? "feld"}
              reverse={!!snap.keyboard.ctx.hellReverse}
              labelOf={(s) => HELL_SPEEDS.find((x) => x.id === s)?.label ?? s}
              canOperate={canOperate}
              run={run}
            />
            <HellTape rxHz={rxHz} empty={snap.radio.link === "connected" ? `Nothing printed at ${rxHz} Hz yet. Click a Hell signal on the waterfall to put the marker on it.` : "Nothing prints while the radio is disconnected."} />
          </>
        ) : (
        <div ref={convoRef} className="h-64 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-6">
          {conversation.length === 0 && <div className="py-8 text-center font-sans text-sm text-muted">Nothing at {rxHz} Hz yet. Click a signal below or on the waterfall to move there.</div>}
          {conversation.map((l) => (
            <div key={l.id} className="grid grid-cols-[62px_44px_1fr_auto] gap-x-2">
              <span className="text-subtle">{utcTime(l.startMs, true)}</span>
              <span className={cn("font-semibold", l.dir === "tx" ? "text-accent-strong" : "text-me")}>{l.dir === "tx" ? "You" : "RX"}</span>
              <span className={cn("break-words", l.dir === "tx" ? "text-accent-strong" : "text-fg")}>
                {l.text}
                {!l.complete && <span className="ml-1 animate-pulse text-subtle">▌</span>}
              </span>
              <span className="text-[11px] text-subtle">{l.dir === "rx" && l.snr !== null ? `${l.snr} dB` : ""}</span>
            </div>
          ))}
          {sending && (
            <div className="grid grid-cols-[62px_44px_1fr_auto] gap-x-2 opacity-80">
              <span className="text-subtle">{utcTime(sending.startedAt, true)}</span>
              <span className="font-semibold text-accent-strong">TX</span>
              <span className="text-accent-strong">{sending.text}</span>
              <span className="text-[11px] text-subtle">{sending.frames} fr</span>
            </div>
          )}
        </div>
        )}
        {mode === "HELL" && sending && (
          <div className="border-t border-line px-3 py-1.5 font-mono text-xs text-accent-strong">TX {sending.text}</div>
        )}

        <div className="space-y-2 border-t border-line px-3 py-3">
          {sending && (
            <div className="flex items-center gap-3 text-xs">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
                <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-28 text-right text-muted">
                {now < sending.startedAt ? "keying…" : `${Math.max(0, Math.ceil((sending.startedAt + sending.durationMs - now) / 1000))} s left`}
              </span>
              <Button size="sm" variant="danger" onClick={() => void run("/keyboard/halt")}>
                Halt TX
              </Button>
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send({ text });
            }}
          >
            <Input
              value={text}
              maxLength={mode === "JTTY" ? 80 : 500}
              disabled={!canOperate}
              onChange={(e) => setText(caps ? e.target.value.toUpperCase() : e.target.value)}
              placeholder={canOperate ? "Type and press Enter. %M %H %E %Q work here too." : "Sign in as an operator to transmit"}
              className={cn("flex-1 font-mono placeholder:normal-case", caps && "uppercase")}
              aria-label="Message to send"
            />
            <Button type="submit" variant="primary" disabled={!canOperate || busy || !text.trim() || !!sending} title={snap.tx.blocked ? `Transmit is blocked: ${snap.tx.blocked}` : undefined}>
              Send
            </Button>
          </form>
          {editing ? (
            <FkeyEditor mode={mode} keys={snap.keyboard.fkeys} custom={!!snap.keyboard.fkeysCustom} run={run} onDone={() => setEditing(false)} />
          ) : (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {snap.keyboard.fkeys.map((t, i) => (
              <button
                key={i}
                type="button"
                disabled={!canOperate || busy || !!sending}
                onClick={() => void send({ fkey: i + 1 })}
                title={`${FKEY_HELP[t] ?? t} · ${t}`}
                className="min-w-0 rounded-md border border-line-strong bg-panel-2 px-2 py-1.5 text-left hover:border-accent disabled:opacity-40"
              >
                <div className="flex items-center justify-between gap-1 text-[11px] text-subtle">
                  <span className="font-semibold text-muted">F{i + 1}</span>
                  <span className="truncate">{FKEY_HELP[t]}</span>
                </div>
                <div className="truncate font-mono text-xs text-fg">{preview(t, snap)}</div>
              </button>
            ))}
          </div>
          )}
          <p className="text-[11px] text-subtle">
            F1–F8 on the keyboard send these, Esc halts. {MODE_NOTE[mode]}{" "}
            {canOperate && !editing && (
              <button type="button" onClick={() => setEditing(true)} className="text-muted underline hover:text-fg">
                Edit keys
              </button>
            )}
          </p>
        </div>
      </Card>

      {mode !== "HELL" && (
      <Card
        pad={false}
        title={
          <span className="flex items-center gap-2">
            Band activity
            <span className="text-xs font-normal text-muted">newest first · click to move there</span>
          </span>
        }
        actions={
          <div className="flex overflow-hidden rounded-md border border-line-strong text-xs">
            {(
              [
                [false, "All"],
                [true, "My frequency"],
              ] as [boolean, string][]
            ).map(([k, l]) => (
              <button key={l} onClick={() => setOnlyRx(k)} className={cn("px-2.5 py-1", onlyRx === k ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        {band.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted">{snap.radio.link === "connected" ? `No ${mode} signals heard yet.` : "No decodes while the radio is disconnected."}</div>
        ) : (
          <div className="max-h-[40vh] overflow-y-auto font-mono text-[13px]">
            {band.map((l) => {
              const who = senderOf(l.text, me);
              const toMe = !!me && l.text.includes(me);
              return (
                <div
                  key={l.id}
                  onClick={() => pick(l)}
                  className={cn("grid grid-cols-[62px_34px_50px_1fr_auto] items-center gap-2 px-3 py-[3px]", canOperate && "cursor-pointer hover:bg-panel-3", toMe && "bg-me-soft", l.atRx && !toMe && "bg-accent-soft/40")}
                  title={canOperate ? `Move to ${l.freqHz} Hz${who ? ` and work ${who}` : ""}` : undefined}
                >
                  <span className="text-subtle">{utcTime(l.startMs, true)}</span>
                  <span className={cn("text-right tabular", (l.snr ?? -99) >= 10 ? "text-fg" : "text-muted")}>{l.snr}</span>
                  <span className="text-right tabular text-subtle">{l.freqHz}</span>
                  <span className={cn("truncate", /^CQ /.test(l.text) && "text-info", toMe && "font-semibold text-me")}>
                    {l.text}
                    {!l.complete && <span className="ml-1 text-subtle">…</span>}
                  </span>
                  <span className="font-sans">{l.atRx && <Badge tone="info">RX</Badge>}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}
    </div>
  );
}

/** A text field that edits one piece of the JTTY context, saved when it loses focus. */
function CtxField({ label, value, onSave, placeholder, disabled, className }: { label: string; value: string; onSave: (v: string) => void; placeholder?: string; disabled?: boolean; className?: string }) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setV(value);
  }, [value, editing]);
  return (
    <label className={cn("block text-xs text-muted", className)}>
      {label}
      <Input
        value={v}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(e) => setV(e.target.value.toUpperCase())}
        onBlur={() => {
          setEditing(false);
          if (v.trim() !== value) onSave(v.trim());
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="mt-1 w-full font-mono uppercase placeholder:normal-case"
      />
    </label>
  );
}

/** CW speed, saved when the slider is let go. */
function WpmControl({ wpm, run }: { wpm: number; run: Run }) {
  const [v, setV] = useState<number | null>(null);
  const shown = v ?? wpm;
  const save = () => v !== null && void run("/keyboard/context", { wpm: v }).then(() => setV(null));
  return (
    <label className="flex items-center gap-2 text-xs text-muted" title="Sending speed">
      <input type="range" min={5} max={50} value={shown} onChange={(e) => setV(Number(e.target.value))} onMouseUp={save} onTouchEnd={save} onKeyUp={save} className="w-24 accent-[var(--color-accent)]" />
      <span className="w-14 font-mono text-fg">{shown} WPM</span>
    </label>
  );
}

export function KeyboardContactCard({ snap, lines: all, run, busy, canOperate }: { snap: EngineSnapshot; lines: KeyLine[]; run: Run; busy: boolean; canOperate: boolean }) {
  const mode = snap.keyboard.mode ?? "JTTY";
  const lines = useMemo(() => all.filter((l) => l.mode === mode), [all, mode]);
  const c = snap.keyboard.ctx;
  const [rstSent, setRstSent] = useState("599");
  const [rstRcvd, setRstRcvd] = useState("599");
  const [exchRcvd, setExchRcvd] = useState("");
  const [grid, setGrid] = useState("");
  const [name, setName] = useState("");
  const [qth, setQth] = useState("");
  const [logged, setLogged] = useState<string | null>(null);
  const inContest = snap.auto.contest.id !== "none";
  const ctx = (patch: Record<string, unknown>) => void run("/keyboard/context", patch);

  // When this contact started: the first line that mentions them in the last quarter hour.
  const startedAt = useMemo(() => {
    if (!c.hisCall) return null;
    const since = Date.now() - 15 * 60_000;
    // The contact starts with the conversation on our frequency, not with the first time
    // the call was seen anywhere on the band (a CQ heard minutes earlier).
    const first = lines.find((l) => l.startMs >= since && (l.dir === "tx" || l.atRx) && l.text.includes(c.hisCall));
    return first?.startMs ?? null;
  }, [lines, c.hisCall]);

  useEffect(() => {
    setExchRcvd("");
    setGrid("");
    setName("");
    setQth("");
    setLogged(null);
  }, [c.hisCall]);

  async function log() {
    const exchSent = exchangeShown(snap);
    const ok = await run("/keyboard/log", { callsign: c.hisCall, rstSent, rstRcvd, grid: grid || null, exchSent, exchRcvd: inContest ? exchRcvd : "", startTime: startedAt, name: name || null, qth: qth || null });
    if (ok) setLogged(`${c.hisCall} logged`);
  }

  return (
    <Card title={`${mode} contact`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <CtxField label="Their call (%H)" value={c.hisCall} disabled={!canOperate} placeholder="K1ABC" onSave={(v) => ctx({ hisCall: v })} />
          <CtxField label="Next in queue (%Q)" value={c.queueCall} disabled={!canOperate} placeholder="optional" onSave={(v) => ctx({ queueCall: v })} />
        </div>
        {inContest && (
          <p className="text-[11px] text-subtle">
            {snap.auto.contest.desk?.name ?? "Contest"}: sending <span className="font-mono text-muted">{exchangeShown(snap) || "—"}</span> (%E sends <span className="font-mono text-muted">599 {exchangeShown(snap)}</span>). The exchange and serial are set on the contest desk.
          </p>
        )}

        <div className="border-t border-line pt-3">
          <div className="grid grid-cols-4 gap-2">
            <label className="block text-xs text-muted">
              Sent
              <Input value={rstSent} onChange={(e) => setRstSent(e.target.value.slice(0, 3))} className="mt-1 w-full font-mono" />
            </label>
            <label className="block text-xs text-muted">
              Rcvd
              <Input value={rstRcvd} onChange={(e) => setRstRcvd(e.target.value.slice(0, 3))} className="mt-1 w-full font-mono" />
            </label>
            {inContest ? (
              <label className="col-span-2 block text-xs text-muted">
                Their exchange
                <Input value={exchRcvd} onChange={(e) => setExchRcvd(e.target.value.toUpperCase().slice(0, 16))} className="mt-1 w-full font-mono uppercase placeholder:normal-case" />
              </label>
            ) : (
              <label className="col-span-2 block text-xs text-muted">
                Name
                <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} className="mt-1 w-full" />
              </label>
            )}
          </div>
          {!inContest && (
            <label className="mt-2 block text-xs text-muted">
              QTH
              <Input value={qth} placeholder="optional" onChange={(e) => setQth(e.target.value.slice(0, 80))} className="mt-1 w-full" />
            </label>
          )}
          <div className="mt-2 flex items-end gap-2">
            <label className="block flex-1 text-xs text-muted">
              Their grid
              <Input value={grid} placeholder="optional" onChange={(e) => setGrid(e.target.value.toUpperCase().slice(0, 6))} className="mt-1 w-full font-mono uppercase placeholder:normal-case" />
            </label>
            <Button variant="primary" disabled={!canOperate || busy || !c.hisCall} onClick={() => void log()}>
              Log contact
            </Button>
          </div>
          <div className="mt-2 text-[11px] text-subtle">
            {logged ? <span className="text-ok">{logged}</span> : c.hisCall ? (startedAt ? `Started ${utcTime(startedAt, true)}Z; the conversation goes into the log entry.` : mode === "JTTY" ? "Logged as MODE JTTY, the way WSJT-X writes it." : mode === "PSK31" ? "Logged as MODE PSK, SUBMODE PSK31." : mode === "HELL" ? `Logged as ${HELL_SPEEDS.find((s) => s.id === (c.hellSpeed ?? "feld"))?.adif}.` : `Logged as MODE ${mode}.`) : "Set their call to log a contact."}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Edit a mode's eight function keys; saved on the engine for every operator. */
function FkeyEditor({ mode, keys, custom, run, onDone }: { mode: KeyMode; keys: string[]; custom: boolean; run: Run; onDone: () => void }) {
  const [draft, setDraft] = useState<string[]>(() => [...keys]);
  const [err, setErr] = useState<string | null>(null);
  const save = async (k: string[] | null) => {
    setErr(null);
    const r = await fetch("/api/engine/keyboard/fkeys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, keys: k }) }).catch(() => null);
    if (!r?.ok) {
      const j = (await r?.json().catch(() => null)) as { error?: string } | null;
      setErr(j?.error ?? "not saved");
      return;
    }
    void run;
    onDone();
  };
  return (
    <div className="space-y-2 rounded-md border border-line-strong p-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {draft.map((t, i) => (
          <label key={i} className="flex items-center gap-2 text-xs">
            <span className="w-6 font-semibold text-muted">F{i + 1}</span>
            <input
              value={t}
              maxLength={120}
              onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)))}
              className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-panel-2 px-2 font-mono text-fg"
            />
          </label>
        ))}
      </div>
      <p className="text-[11px] text-subtle">%M your call · %H theirs · %Q the next in the queue · %X the exchange (or the serial) · %E 599 and the exchange.</p>
      {err && <p className="text-xs text-bad">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => void save(draft)}>
          Save {mode} keys
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {custom && (
          <Button size="sm" variant="ghost" onClick={() => void save(null)}>
            Back to the defaults
          </Button>
        )}
      </div>
    </div>
  );
}
