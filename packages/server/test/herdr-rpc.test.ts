import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/herdr.ts";

const dir = mkdtempSync(join(tmpdir(), "af-rpc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Herdr socket calls", () => {
  test("a reply split in the middle of a character is decoded whole", async () => {
    const sock = join(dir, "h.sock");
    const text = `${"▀".repeat(200)}\n > Type your message\n${"▄".repeat(200)}`;
    const reply = Buffer.from(JSON.stringify({ id: "af", result: { read: { text } } }) + "\n", "utf8");
    // cut inside a 3-byte "▀": the first chunk ends with half of it
    const cut = reply.indexOf(Buffer.from("▀", "utf8")) + 301;
    const server = Bun.listen({
      unix: sock,
      socket: {
        async data(s) {
          s.write(reply.subarray(0, cut));
          s.flush();
          await Bun.sleep(30);
          s.write(reply.subarray(cut));
        },
      },
    });
    try {
      const h = new Herdr("herdr", sock);
      const got = await h.readScreen("w1:p1");
      expect(got).toBe(text);
      expect(got.includes("�")).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
