/**
 * Keeps one radio connected: a FlexRadio on the network, or an ICOM on USB.
 *
 * One state machine, one cancellation point: stop() cancels any pending retry and closes
 * the radio, and nothing reconnects afterwards. Backoff doubles to a 60 s ceiling.
 * Discovery is used only when no address is configured, and the last address that
 * worked is always tried first, so a missing LAN broadcast cannot strand the engine
 * (the old install retried a failing discovery 8,000 times).
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";

import { FlexRadio, type FlexRadioOptions } from "./radio.ts";
import { IcomRadio, type IcomOptions } from "../rig/icom.ts";
import { IcomLanSession } from "../rig/icom-lan.ts";
import { HamlibRadio, type HamlibOptions } from "../rig/hamlib.ts";
import type { Rig } from "../rig/types.ts";
import { FLEX_TCP_PORT, parseDiscovery } from "./protocol.ts";

export type RadioLinkState = "stopped" | "discovering" | "connecting" | "connected" | "waiting";

export interface DiscoveredRadio {
  address: string;
  model: string;
  nickname: string;
  serial: string;
  version: string;
  guiClients: string[];
}

export function discover(timeoutMs = 4000): Promise<DiscoveredRadio | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = (r: DiscoveredRadio | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.on("message", (buf, rinfo) => {
      const kv = parseDiscovery(buf);
      if (!kv) return;
      finish({
        address: rinfo.address,
        model: kv.model ?? "",
        nickname: kv.nickname ?? "",
        serial: kv.serial ?? "",
        version: kv.version ?? "",
        guiClients: (kv.gui_client_programs ?? "").split(",").filter(Boolean),
      });
    });
    sock.bind(FLEX_TCP_PORT, "0.0.0.0");
  });
}

type Events = {
  state: [RadioLinkState, string];
  radio: [Rig | null];
};

export interface SupervisorConfig {
  kind: "flex" | "icom" | "hamlib";
  host: string;
  lastGoodHost: string | null;
  radio: Omit<FlexRadioOptions, "host">;
  icom: Omit<IcomOptions, "log" | "defaultFreqHz"> & { connection: "usb" | "lan"; lan: { host: string; port: number; username: string; password: string } };
  hamlib?: Omit<HamlibOptions, "log" | "defaultFreqHz">;
}

export class RadioSupervisor extends EventEmitter<Events> {
  state: RadioLinkState = "stopped";
  detail = "";
  radio: Rig | null = null;
  attempt = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(
    private readonly config: () => SupervisorConfig,
    private readonly onGoodHost: (host: string) => void,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    super();
  }

  private set(state: RadioLinkState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.emit("state", state, detail);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connectOnce(++this.generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = this.radio;
    this.radio = null;
    this.emit("radio", null);
    if (r) await r.close();
    this.set("stopped", "");
  }

  /** Drop the current connection and reconnect now (e.g. after a settings change). */
  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  private scheduleRetry(gen: number, why: string): void {
    if (!this.running || gen !== this.generation) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.attempt, 5));
    this.set("waiting", `${why} — retrying in ${Math.round(delay / 1000)}s`);
    this.timer = setTimeout(() => void this.connectOnce(gen), delay);
  }

  private async connectOnce(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    this.attempt++;
    const cfg = this.config();
    if (cfg.kind === "icom") return this.connectIcom(gen, cfg);
    if (cfg.kind === "hamlib") return this.connectHamlib(gen, cfg);
    let host = cfg.host || cfg.lastGoodHost || "";
    if (!cfg.host) {
      this.set("discovering", "listening for the radio's LAN broadcast");
      const found = await discover();
      if (gen !== this.generation) return;
      if (found) host = found.address;
    }
    if (!host) return this.scheduleRetry(gen, "no radio found and no address configured");

    this.set("connecting", `connecting to ${host}`);
    const radio = new FlexRadio({ ...cfg.radio, host });
    try {
      await radio.connect();
    } catch (e) {
      if (attemptLogged(this.attempt)) this.log("warn", `radio connect to ${host} failed (attempt ${this.attempt}): ${(e as Error).message}`);
      return this.scheduleRetry(gen, (e as Error).message);
    }
    if (gen !== this.generation || !this.running) {
      await radio.close();
      return;
    }
    this.attempt = 0;
    this.radio = radio;
    this.onGoodHost(host);
    this.log("info", `connected to ${radio.info.model} ${radio.info.nickname} (${host}), SmartSDR ${radio.info.version}, slice ${radio.slice?.index}`);
    this.adopt(gen, radio, `${radio.info.model} at ${host}`);
  }

  private async connectIcom(gen: number, cfg: SupervisorConfig): Promise<void> {
    const lan = cfg.icom.connection === "lan";
    const where = lan ? `${cfg.icom.lan.host} (LAN)` : cfg.icom.serialPath;
    this.set("connecting", `${lan ? "logging in to" : "opening"} ${where}`);
    let radio: IcomRadio;
    try {
      if (lan) {
        if (!cfg.icom.lan.host || !cfg.icom.lan.username) throw new Error("set the radio's address, network username and password in Settings → Radio");
        const session = new IcomLanSession({ ...cfg.icom.lan, log: cfg.radio.log });
        await session.connect();
        radio = new IcomRadio({
          ...cfg.icom,
          serialPath: where,
          civAddress: session.radio?.civ || cfg.icom.civAddress,
          modelName: session.radio?.name,
          dataModSource: 0x05,
          defaultFreqHz: cfg.radio.defaultFreqHz,
          log: cfg.radio.log,
          io: session.io(),
        });
      } else {
        radio = new IcomRadio({ ...cfg.icom, dataModSource: 0x01, defaultFreqHz: cfg.radio.defaultFreqHz, log: cfg.radio.log });
      }
      await radio.connect();
    } catch (e) {
      if (attemptLogged(this.attempt)) this.log("warn", `ICOM on ${where} failed (attempt ${this.attempt}): ${(e as Error).message}`);
      return this.scheduleRetry(gen, (e as Error).message);
    }
    if (gen !== this.generation || !this.running) {
      await radio.close();
      return;
    }
    this.attempt = 0;
    this.radio = radio;
    this.log("info", `connected to ${radio.info.model} on ${where}${lan ? "" : ` (${cfg.icom.audioDevice})`}`);
    this.adopt(gen, radio, `${radio.info.model} on ${where}`);
  }

  private async connectHamlib(gen: number, cfg: SupervisorConfig): Promise<void> {
    const h = cfg.hamlib!;
    const radio = new HamlibRadio({ ...h, defaultFreqHz: cfg.radio.defaultFreqHz, log: cfg.radio.log });
    this.set("connecting", h.model ? `starting rigctld for ${h.device}` : `connecting to rigctld at ${h.host}:${h.port}`);
    try {
      await radio.connect();
    } catch (e) {
      if (attemptLogged(this.attempt)) this.log("warn", `Hamlib radio failed (attempt ${this.attempt}): ${(e as Error).message}`);
      return this.scheduleRetry(gen, (e as Error).message);
    }
    if (gen !== this.generation || !this.running) {
      await radio.close();
      return;
    }
    this.attempt = 0;
    this.radio = radio;
    this.log("info", `connected to ${radio.info.model} through Hamlib${radio.info.version ? ` ${radio.info.version}` : ""} (${h.audioDevice})`);
    this.adopt(gen, radio, `${radio.info.model} through ${radio.host}`);
  }

  private adopt(gen: number, radio: Rig, detail: string): void {
    this.set("connected", detail);
    this.emit("radio", radio);
    radio.once("closed", (err) => {
      if (this.radio !== radio) return;
      this.radio = null;
      this.emit("radio", null);
      this.log("warn", `radio connection lost: ${err?.message ?? "closed"}`);
      this.scheduleRetry(gen, err?.message ?? "connection closed");
    });
  }
}

/** Log the first few failures, then one in ten, so an outage is visible but not a flood. */
function attemptLogged(n: number): boolean {
  return n <= 3 || n % 10 === 0;
}
