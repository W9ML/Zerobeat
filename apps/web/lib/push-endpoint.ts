/**
 * Browser push subscriptions always point at the browser vendor's push service. The
 * engine POSTs to the endpoint, so anything else would let a signed-in viewer make the
 * station send requests wherever they liked (into the station's own LAN included).
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^updates-autopush(\.\w+)?\.(mozaws\.net|services\.mozilla\.com)$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

export function isPushService(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}
