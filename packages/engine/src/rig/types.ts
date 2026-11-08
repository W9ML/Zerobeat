/**
 * What the station needs from a radio, whichever kind it is. FlexRadio (network,
 * SmartSDR API + DAX) and ICOM (CI-V over USB serial + the radio's USB sound card) both
 * implement this, and nothing above this line knows which one is connected.
 *
 * Audio in both directions is 24 kHz mono float; the receiver decimates to 12 kHz.
 */
import type { EventEmitter } from "node:events";

export interface RadioInfo {
  model: string;
  serial: string;
  version: string;
  nickname: string;
  callsign: string;
  atu: boolean;
}

/** The receiver we operate on: a Flex slice, or an ICOM's main VFO (index 0). */
export interface SliceState {
  index: number;
  freqHz: number;
  mode: string;
  rxAnt: string;
  txAnt: string;
  antList: string[];
  txAntList: string[];
  tx: boolean;
  dax: number;
  owned: boolean;
}

export interface Telemetry {
  fwdW: number | null;
  swr: number | null;
  paTempC: number | null;
  supplyV: number | null;
  sLevelDbm: number | null;
  at: number;
}

export interface TxRequest {
  samples: Float32Array; // 24 kHz mono
  startAt: number; // epoch ms the audio should start
  lateLimitMs: number; // refuse if we cannot start within this of startAt
  /** Asked just before keying: false means the transmission is no longer wanted (halted). */
  stillWanted?: () => boolean;
}

export interface TxReport {
  ok: boolean;
  detail: string;
  startedLateMs: number;
  packets: number;
  peakFwdW: number;
  peakSwr: number;
  /** False when the radio offered no power reading during the over: peakFwdW means nothing. */
  metered?: boolean;
}

export type RigEvents = {
  /** lost: samples (24 kHz) the radio sent that never arrived, when the transport can tell. */
  audio: [samples: Float32Array, arrivedAt: number, lost?: number];
  slice: [SliceState];
  transmitting: [boolean];
  telemetry: [Telemetry];
  closed: [Error | null];
  message: [string];
  /** Another client on a shared radio (a SmartSDR GUI) keyed it. */
  otherTx: [string];
  /** The radio's own readiness to transmit changed (see Rig.txProblem). */
  txReady: [];
};

export interface Rig extends EventEmitter<RigEvents> {
  /** Where the radio is: an address, or a device path. */
  readonly host: string;
  info: RadioInfo;
  slice: SliceState | null;
  telemetry: Telemetry;
  transmit: { rfpower: number };
  readonly isKeyed: boolean;
  /** Why the radio itself will not transmit now (a Flex interlock fault), or null. */
  readonly txProblem?: string | null;
  connect(): Promise<void>;
  close(reason?: Error | null): Promise<void>;
  tune(hz: number): Promise<void>;
  setRfPower(pct: number): Promise<void>;
  atuStart(): Promise<void>;
  transmitAudio(req: TxRequest): Promise<TxReport>;
  unkey(): Promise<void>;
}
