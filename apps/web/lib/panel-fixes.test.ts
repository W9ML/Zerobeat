/** Fixes from the 2026-10-20 panel review that live in the web tier. */
import { describe, expect, it } from "vitest";

import { senderOf } from "./grab-call.ts";
import { isPushService } from "./push-endpoint.ts";
import { safeNextPath } from "./safe-next.ts";

describe("after sign-in", () => {
  it("only goes to a path on this site", () => {
    expect(safeNextPath("/log/abc?x=1#top")).toBe("/log/abc?x=1#top");
    expect(safeNextPath("/")).toBe("/");
    for (const bad of [undefined, "", "//evil.example", "/\\evil.example", "/\\\\evil.example", "https://evil.example", "/x\\y", "/x\ny", "javascript:alert(1)", "\\/evil"]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});

describe("push subscriptions", () => {
  it("accept the browsers' push services and nothing else", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/QAbc", "https://updates-autopush.stage.mozaws.net/wpush/v2/x"]) {
      expect(isPushService(ok)).toBe(true);
    }
    for (const bad of ["https://192.168.0.1/", "https://proxmox.lan:8006/api2/json", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://evil.example/?u=fcm.googleapis.com", "not a url"]) {
      expect(isPushService(bad)).toBe(false);
    }
  });
});

describe("grabbing a call from copied text", () => {
  it("skips CQ, modifiers and DE and wants a digit", () => {
    expect(senderOf("CQ TEST DE PY2TF PY2TF TEST", null)).toBe("PY2TF");
    expect(senderOf("CQ CQ CQ DE K5DOC K5DOC K5DOC PSE K", null)).toBe("K5DOC");
    expect(senderOf("CQ POTA DE KE0JK KE0JK K", null)).toBe("KE0JK");
    expect(senderOf("CQ DX JA1QRP PM95", null)).toBe("JA1QRP");
    expect(senderOf("CQ 9H1AB JM75", null)).toBe("9H1AB");
    expect(senderOf("CQ W9ML EN61", "W9ML")).toBe("W9ML");
    expect(senderOf("DL2FOO DE G4ZZZ 599 599 TU", "W9ML")).toBe("DL2FOO");
    expect(senderOf("TNX 73 GL", null)).toBeNull();
  });
});
