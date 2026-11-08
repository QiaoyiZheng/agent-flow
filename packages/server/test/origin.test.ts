import { expect, test } from "bun:test";
import { isLocalOrigin } from "../src/origin.ts";

test("accepts loopback origins on server, Vite, and forwarded ports", () => {
  for (const origin of [null, "http://127.0.0.1:7477", "http://localhost:5173", "http://127.0.0.1:59551", "http://localhost:59551", "http://[::1]:17477", "https://localhost:59551"]) {
    expect(isLocalOrigin(origin)).toBe(true);
  }
});

test("rejects external, malformed, and misleading origins", () => {
  for (const origin of ["", "null", "garbage", "https://example.com", "http://192.168.1.2:7477", "http://localhost.evil.test:5173", "http://localhost:5173@evil.test", "http://evil.test@localhost:5173", "http://localhost:5173/path", "http://localhost:5173?x=1", "http://localhost:5173#x", "ftp://localhost:5173"]) {
    expect(isLocalOrigin(origin)).toBe(false);
  }
});
