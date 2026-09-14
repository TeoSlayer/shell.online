/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "web/vendor/refstream/v0.1.0-alpha.5");

interface Manifest {
  version: string;
  gitRevision: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

describe("vendored Refstream browser release", () => {
  it("matches every file in the signed alpha.5 release manifest", async () => {
    const manifest = JSON.parse(await readFile(join(vendor, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.version).toBe("0.1.0-alpha.5");
    expect(manifest.gitRevision).toBe("131a71335f05344f3018c43a76ffbe7376493a34");

    for (const [name, expected] of Object.entries(manifest.files)) {
      const contents = await readFile(join(vendor, name));
      expect(contents.byteLength, name).toBe(expected.bytes);
      expect(createHash("sha256").update(contents).digest("hex"), name).toBe(expected.sha256);
    }
  });
});
