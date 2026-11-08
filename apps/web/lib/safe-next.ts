/**
 * Where to go after signing in: only a path on this site. "//evil.example" and
 * "/\\evil.example" (browsers read the backslash as a slash) both leave the site, so a
 * second leading slash of either kind, any backslash and any control character send the
 * user to the dashboard instead.
 */
export function safeNextPath(next: string | undefined | null): string {
  return next && /^\/(?![\/\\])[^\\\u0000-\u001f]*$/.test(next) ? next : "/";
}
