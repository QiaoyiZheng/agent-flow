/** SSH and editor tunnels may expose a different local port than the server's.
 * This is only an origin check: callers must still authenticate the token.
 */
export function isLocalOrigin(origin: string | null): boolean {
  // CLI clients do not send Origin.
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash
    );
  } catch {
    return false;
  }
}
