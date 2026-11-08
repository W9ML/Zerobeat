/**
 * WSPR-2 for Zerobeat: a TypeScript port of WSJT-X's WSPR encoder (genwspr/wqencode)
 * and of its wsprd decoder. See codec.ts (message packing and the callsign hash table),
 * fec.ts (convolutional code, interleaver, sync vector, Fano decoder), modem.ts (tones
 * and waveform) and decoder.ts (wsprd's search, sync, demodulation and subtraction).
 */

export {
  WSPR_POWERS,
  WsprHashTable,
  normalizeWsprPower,
  packWspr,
  unpackWspr,
  wsprHash,
  type WsprMessage,
  type WsprMessageType,
} from "./codec.ts";
export { WSPR_SYNC, channelTones } from "./fec.ts";
export { WSPR_BAUD, WSPR_NSPS, WSPR_SYMBOLS, WSPR_TONE_SPACING_HZ, wsprTones, wsprWaveform } from "./modem.ts";
export { decodeWspr, type WsprDecode, type WsprDecodeOptions } from "./decoder.ts";
