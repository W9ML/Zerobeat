import net from "node:net";
import { describe, expect, it } from "vitest";

import { parseSpot, SpotFeed, type Spot } from "../src/services/spots.ts";

const NOW = Date.UTC(2026, 9, 20, 18, 45);

describe("DX spots", () => {
  it("reads cluster and RBN spot lines", () => {
    expect(parseSpot("DX de K1TTT-#:   14074.0  W9ML         FT8 -12 dB                     1830Z", "rbn", NOW)).toMatchObject({
      freqHz: 14_074_000,
      call: "W9ML",
      spotter: "K1TTT",
      mode: "FT8",
      snr: -12,
      at: Date.UTC(2026, 9, 20, 18, 30),
    });
    expect(parseSpot("DX de W3LPL-#:    7025.1  JA1ABC       CW    23 dB  28 WPM  CQ      1831Z", "rbn", NOW)).toMatchObject({ freqHz: 7_025_100, call: "JA1ABC", mode: "CW", snr: 23, wpm: 28 });
    expect(parseSpot("DX de N0XYZ:     21025.5  3Y0K         loud in IN                    1832Z FN42", "cluster", NOW)).toMatchObject({ call: "3Y0K", mode: null, grid: "FN42", comment: "loud in IN" });
    // Just after midnight, a 2359Z spot is yesterday's.
    expect(parseSpot("DX de N0XYZ:     14025.0  K1ABC        cq                            2359Z", "cluster", Date.UTC(2026, 9, 21, 0, 1))!.at).toBe(Date.UTC(2026, 9, 20, 23, 59));
    expect(parseSpot("Hello W9ML, this is NC7J DX cluster", "cluster", NOW)).toBeNull();
    expect(parseSpot("WWV de VE7CC <18>:   SFI=150, A=5, K=1, No Storms", "cluster", NOW)).toBeNull();
  });

  it("logs in with the callsign at the prompt, reads spots, and drops repeats", async () => {
    const got: string[] = [];
    const server = net.createServer((sock) => {
      sock.write("Welcome to the test cluster\r\nPlease enter your call: ");
      sock.on("data", (d) => {
        got.push(d.toString());
        sock.write("Hello W9ML\r\n");
        sock.write("DX de K1TTT-#:   14074.0  JA1ABC       FT8 -12 dB                     1830Z\r\n");
        sock.write("DX de K1TTT-#:   14074.0  JA1ABC       FT8 -11 dB                     1831Z\r\n"); // repeat
        sock.write("DX de W3LPL-#:   21074.0  VK3XYZ       FT8 -05 dB                     1832Z\r\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const feed = new SpotFeed(() => {});
    const spots: Spot[] = [];
    feed.on("spot", (s) => spots.push(s));
    feed.configure([{ id: "test", host: "127.0.0.1", port, source: "cluster" }], "W9ML");
    for (let i = 0; i < 40 && spots.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    feed.stop();
    server.close();
    expect(got.join("")).toBe("W9ML\r\n");
    expect(spots.map((s) => s.call)).toEqual(["JA1ABC", "VK3XYZ"]);
    expect(feed.status()).toEqual([]);
  });
});
