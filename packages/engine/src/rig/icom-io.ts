/**
 * The ICOM driver's links to the outside world, behind small interfaces so tests can
 * drive the driver against a simulated radio.
 *
 * Serial: the radio's USB port A is a CDC-ACM device (/dev/ttyACM0, or better a
 * /dev/serial/by-id/… path). stty sets speed and raw mode; reads go through Node's
 * tty stream, which is event-driven, so a radio that goes quiet can never park a
 * thread-pool thread on a blocking read.
 *
 * Audio: the radio's USB sound card ("USB Audio CODEC") through ALSA's arecord and aplay
 * at 24 kHz mono, 16-bit. plughw does the conversion to the card's native 48 kHz.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import tty from "node:tty";

export interface SerialLink {
  write(b: Buffer): Promise<void>;
  onData(fn: (b: Buffer) => void): void;
  onClose(fn: (err: Error | null) => void): void;
  close(): void;
}

export interface Playback {
  /** Queue samples; resolves when the pipe accepted them. */
  write(samples: Int16Array): Promise<void>;
  /** No more samples; resolves when the sound card has played them all. */
  finish(): Promise<void>;
  kill(): void;
}

export interface Capture {
  stop(): void;
}

export interface IcomIo {
  openSerial(path: string, baud: number): Promise<SerialLink>;
  startCapture(device: string, rate: number, onSamples: (s: Float32Array) => void, onEnd: (err: Error | null) => void): Capture;
  openPlayback(device: string, rate: number): Playback;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 5000 }, (err, _out, stderr) => (err ? reject(new Error(`${cmd}: ${String(stderr).trim() || err.message}`)) : resolve())),
  );
}

export const linuxIo: IcomIo = {
  async openSerial(path, baud) {
    if (!fs.existsSync(path)) throw new Error(`${path} does not exist (is the radio's USB cable connected, and is the VM given the device?)`);
    await run("stty", ["-F", path, String(baud), "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke", "-ixon", "-ixoff", "-crtscts", "-hupcl", "cs8", "-cstopb", "-parenb", "clocal"]);
    const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    if (!tty.isatty(fd)) {
      fs.closeSync(fd);
      throw new Error(`${path} is not a serial device`);
    }
    const rs = new tty.ReadStream(fd);
    rs.setRawMode(true);
    let closed = false;
    const closers: ((e: Error | null) => void)[] = [];
    const end = (e: Error | null) => {
      if (closed) return;
      closed = true;
      try {
        rs.destroy();
      } catch {
        /* gone */
      }
      for (const f of closers) f(e);
    };
    rs.on("error", (e) => end(e));
    rs.on("close", () => end(new Error("serial port closed")));
    return {
      write: (b) =>
        new Promise((resolve, reject) => {
          if (closed) return reject(new Error("serial port closed"));
          fs.write(fd, b, (err) => (err ? reject(err) : resolve()));
        }),
      onData: (fn) => rs.on("data", (d: Buffer | string) => fn(typeof d === "string" ? Buffer.from(d, "binary") : d)),
      onClose: (fn) => closers.push(fn),
      close: () => end(null),
    };
  },

  startCapture(device, rate, onSamples, onEnd) {
    const p = spawn("arecord", ["-q", "-D", device, "-t", "raw", "-f", "S16_LE", "-r", String(rate), "-c", "1", "--buffer-time=100000", "--period-time=10000"], { stdio: ["ignore", "pipe", "pipe"] });
    let rest: Buffer | null = null;
    let stderr = "";
    let stopped = false;
    p.stdout.on("data", (chunk: Buffer) => {
      const b = rest ? Buffer.concat([rest, chunk]) : chunk;
      const n = b.length >> 1;
      rest = b.length & 1 ? b.subarray(b.length - 1) : null;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2) / 32768;
      onSamples(out);
    });
    p.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-400)));
    p.on("error", (e) => onEnd(new Error(`arecord: ${e.message} (is alsa-utils installed?)`)));
    p.on("exit", (code) => {
      if (!stopped) onEnd(new Error(`audio capture stopped (arecord exit ${code}${stderr ? `: ${stderr.trim()}` : ""})`));
    });
    return {
      stop: () => {
        stopped = true;
        p.kill("SIGTERM");
      },
    };
  },

  openPlayback(device, rate) {
    const p: ChildProcess = spawn("aplay", ["-q", "-D", device, "-t", "raw", "-f", "S16_LE", "-r", String(rate), "-c", "1", "--buffer-time=200000", "--period-time=20000"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    p.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-400)));
    const exited = new Promise<void>((resolve, reject) => {
      p.on("error", (e) => reject(new Error(`aplay: ${e.message} (is alsa-utils installed?)`)));
      p.on("exit", (code, sig) => (code === 0 || sig === "SIGTERM" ? resolve() : reject(new Error(`aplay exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`))));
    });
    exited.catch(() => {});
    return {
      write: (s) =>
        new Promise((resolve, reject) => {
          const buf = Buffer.from(s.buffer, s.byteOffset, s.byteLength);
          if (!p.stdin || p.stdin.destroyed) return reject(new Error("playback is closed"));
          p.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
        }),
      finish: () => {
        p.stdin?.end();
        return exited;
      },
      kill: () => {
        p.stdin?.destroy();
        p.kill("SIGTERM");
      },
    };
  },
};
