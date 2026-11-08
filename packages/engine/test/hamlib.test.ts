import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { HamlibRadio } from "../src/rig/hamlib.ts";

/**
 * A rigctld that answers the way Hamlib 4.6.2's does in the extended protocol (checked
 * against the real one with its dummy radio): the command echoed, then "Key: value" or
 * a bare value, then RPRT.
 */
function fakeRigctld(opts: { noPktusb?: boolean; noDataPtt?: boolean } = {}) {
  const state = { freq: 14_074_000, mode: "USB", ptt: 0, rfpower: 0.5, log: [] as string[] };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const [cmd, ...args] = line.replace(/^\+\\/, "").split(" ");
        state.log.push(line);
        const echo = `${cmd}:${args.length ? " " + args.join(" ") : ""}\n`;
        const ok = (body = "") => sock.write(echo + body + "RPRT 0\n");
        const err = (n: number) => sock.write(echo + `RPRT -${n}\n`);
        switch (cmd) {
          case "dump_caps":
            ok("Caps dump for model: 1035\nModel name:\tFT-991A\nMfg name:\tYaesu\nHamlib version:\tHamlib 4.6.2\nVFO Ops: CPY UP DOWN TUNE \n");
            break;
          case "get_freq":
            ok(`Frequency: ${state.freq}\n`);
            break;
          case "set_freq":
            if (!/^\d+$/.test(args[0] ?? "")) err(1);
            else {
              state.freq = Number(args[0]);
              ok();
            }
            break;
          case "set_mode":
            if (args[0] === "PKTUSB" && opts.noPktusb) err(9);
            else {
              state.mode = args[0]!;
              ok();
            }
            break;
          case "get_level":
            ok(`${args[0] === "RFPOWER" ? state.rfpower : args[0] === "STRENGTH" ? -10 : args[0] === "RFPOWER_METER_WATTS" ? (state.ptt ? 42 : 0) : args[0] === "SWR" ? (state.ptt ? 1.3 : 0) : 0}\n`);
            break;
          case "set_level":
            state.rfpower = Number(args[1]);
            ok();
            break;
          case "set_ptt":
            if (args[0] === "3" && opts.noDataPtt) err(11);
            else {
              state.ptt = Number(args[0]);
              ok();
            }
            break;
          case "vfo_op":
            ok();
            break;
          default:
            err(4);
        }
      }
    });
  });
  return new Promise<{ port: number; state: typeof state; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, state, close: () => server.close() })),
  );
}

const fakeIo = () => {
  const played: number[] = [];
  return {
    played,
    startCapture: (_d: string, _r: number, on: (s: Float32Array) => void) => {
      const t = setInterval(() => on(new Float32Array(480)), 20);
      return { stop: () => clearInterval(t) };
    },
    openPlayback: () => ({
      write: async (s: Int16Array) => void played.push(s.length),
      finish: () => new Promise<void>((r) => setTimeout(r, 300)),
      kill: () => {},
    }),
  };
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

describe("Hamlib radio through rigctld", () => {
  it("connects, reads the model, sets USB data mode, tunes, keys with data PTT and reads watts and SWR", async () => {
    const rig = await fakeRigctld();
    cleanup.push(rig.close);
    const io = fakeIo();
    const r = new HamlibRadio({ host: "127.0.0.1", port: rig.port, model: 0, device: "", baud: 0, pttMethod: "cat", audioDevice: "x", ratedWatts: 100, defaultFreqHz: 7_074_000, log: () => {}, io });
    cleanup.push(() => void r.close());
    await r.connect();
    expect(r.info.model).toBe("Yaesu FT-991A");
    expect(r.info.atu).toBe(true);
    expect(r.slice).toMatchObject({ freqHz: 14_074_000, mode: "USB-D" });
    expect(rig.state.mode).toBe("PKTUSB");
    expect(r.transmit.rfpower).toBe(50);
    await r.tune(21_074_000);
    expect(rig.state.freq).toBe(21_074_000);
    const keyed: boolean[] = [];
    r.on("transmitting", (t) => keyed.push(t));
    const rep = await r.transmitAudio({ samples: new Float32Array(24_000), startAt: Date.now() + 200, lateLimitMs: 500 });
    expect(rep.ok).toBe(true);
    expect(rep.peakFwdW).toBe(42);
    expect(rep.peakSwr).toBe(1.3);
    expect(keyed).toEqual([true, false]);
    expect(rig.state.log).toContain("+\\set_ptt 3");
    expect(rig.state.ptt).toBe(0);
    expect(io.played[0]).toBeGreaterThan(23_000);
  });

  it("falls back to USB and plain PTT on radios without data mode or data PTT", async () => {
    const rig = await fakeRigctld({ noPktusb: true, noDataPtt: true });
    cleanup.push(rig.close);
    const r = new HamlibRadio({ host: "127.0.0.1", port: rig.port, model: 0, device: "", baud: 0, pttMethod: "cat", audioDevice: "x", ratedWatts: 100, defaultFreqHz: 7_074_000, log: () => {}, io: fakeIo() });
    cleanup.push(() => void r.close());
    await r.connect();
    expect(r.slice?.mode).toBe("USB");
    expect(rig.state.mode).toBe("USB");
    const rep = await r.transmitAudio({ samples: new Float32Array(4_800), startAt: Date.now() + 150, lateLimitMs: 500 });
    expect(rep.ok).toBe(true);
    expect(rig.state.log).toContain("+\\set_ptt 1");
  });

  it("refuses to transmit when cancelled, and explains Hamlib errors", async () => {
    const rig = await fakeRigctld();
    cleanup.push(rig.close);
    const r = new HamlibRadio({ host: "127.0.0.1", port: rig.port, model: 0, device: "", baud: 0, pttMethod: "cat", audioDevice: "x", ratedWatts: 100, defaultFreqHz: 7_074_000, log: () => {}, io: fakeIo() });
    cleanup.push(() => void r.close());
    await r.connect();
    const rep = await r.transmitAudio({ samples: new Float32Array(4_800), startAt: Date.now() + 150, lateLimitMs: 500, stillWanted: () => false });
    expect(rep).toMatchObject({ ok: false, detail: "cancelled" });
    expect(rig.state.ptt).toBe(0);
  });

  it("starts rigctld with the model, port, speed and PTT line", () => {
    expect(HamlibRadio.rigctldArgs({ model: 1035, device: "/dev/ttyUSB0", baud: 38400, pttMethod: "cat", port: 4532 })).toEqual(["-m", "1035", "-r", "/dev/ttyUSB0", "-T", "127.0.0.1", "-t", "4532", "-s", "38400"]);
    expect(HamlibRadio.rigctldArgs({ model: 3088, device: "/dev/ttyUSB1", baud: 0, pttMethod: "rts", port: 4533 })).toEqual(["-m", "3088", "-r", "/dev/ttyUSB1", "-T", "127.0.0.1", "-t", "4533", "-P", "RTS", "-p", "/dev/ttyUSB1"]);
  });

  it("reports a missing rigctld clearly", async () => {
    const r = new HamlibRadio({ host: "127.0.0.1", port: 1, model: 0, device: "", baud: 0, pttMethod: "cat", audioDevice: "x", ratedWatts: 100, defaultFreqHz: 7_074_000, log: () => {}, io: fakeIo() });
    await expect(r.connect()).rejects.toThrow(/rigctld at 127.0.0.1:1/);
  });
});
