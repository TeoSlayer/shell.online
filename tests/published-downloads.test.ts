import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLES,
  MIN_BINARY_BYTES,
  SIGNED_EXTRAS,
  evaluate,
  looksLikeHtml,
  parseChecksumManifest,
  parseReleaseTargets,
  renderReport,
  tableCell,
} from "../scripts/lib/published-downloads.mjs";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const TARGETS = "# artifact\tGOOS\tGOARCH\tvariant\nshell-darwin-arm64\tdarwin\tarm64\t-\nshell-linux-amd64\tlinux\tamd64\t-\n";

/* A bundle in which everything agrees, to be broken one piece at a time. */
function healthyBundle() {
  const artifacts = parseReleaseTargets(TARGETS);
  const install = text("#!/bin/sh\nset -eu\n");
  const installPs1 = text("[CmdletBinding()]\nparam()\n");
  const binary = new Uint8Array(MIN_BINARY_BYTES + 1).fill(7);
  const hashes = new Map<string, string>([
    ["install", sha256(install)],
    ["install.ps1", sha256(installPs1)],
    ["SKILL.md", "a".repeat(64)],
    ["release.json", "b".repeat(64)],
    ...artifacts.map((name): [string, string] => [name, sha256(binary)]),
  ]);
  const manifest = [...hashes.entries()].map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n";
  const release = JSON.stringify({ version: "0.15.1", artifacts: Object.fromEntries(artifacts.map((name) => [name, sha256(binary)])) });
  const ok = (bytes: Uint8Array) => ({ status: 200, contentType: "application/octet-stream", bytes });
  return {
    artifacts,
    samples: ["shell-darwin-arm64"],
    sha256,
    fetched: {
      files: {
        install: ok(install),
        "install.ps1": ok(installPs1),
        SHA256SUMS: ok(text(manifest)),
        "release.json": ok(text(release)),
        "shell-darwin-arm64": ok(binary),
      } as Record<string, { status: number; contentType: string | null; bytes: Uint8Array }>,
      binaries: Object.fromEntries(artifacts.map((name) => [name, { status: 200, contentType: "application/octet-stream", length: binary.length }])) as Record<string, { status: number; contentType: string | null; length: number | null }>,
    },
  };
}

describe("release targets and checksum manifests", () => {
  it("reads the artifact list and refuses a malformed or repeated row", () => {
    expect(parseReleaseTargets(TARGETS)).toEqual(["shell-darwin-arm64", "shell-linux-amd64"]);
    expect(() => parseReleaseTargets("shell-x\tlinux\n")).toThrow("invalid");
    expect(() => parseReleaseTargets(`${TARGETS}shell-darwin-arm64\tdarwin\tarm64\t-\n`)).toThrow("repeats");
  });

  it("parses sha256sum output and nothing looser", () => {
    const manifest = parseChecksumManifest(`${"c".repeat(64)}  install\n${"d".repeat(64)}  shell-linux-amd64\n`);
    expect(manifest.get("install")).toBe("c".repeat(64));
    expect(() => parseChecksumManifest(`${"c".repeat(64)} install\n`)).toThrow("invalid entry");
    expect(() => parseChecksumManifest(`${"c".repeat(64)}  install\n${"c".repeat(64)}  install\n`)).toThrow("invalid entry");
  });

  it("recognises an HTML page standing in for a file", () => {
    expect(looksLikeHtml(text("  <!DOCTYPE html><html>"))).toBe(true);
    expect(looksLikeHtml(text("#!/bin/sh"))).toBe(false);
  });

  it("expects the four signed extras beside the binaries", () => {
    expect(SIGNED_EXTRAS).toEqual(["install", "install.ps1", "SKILL.md", "release.json"]);
    expect(DEFAULT_SAMPLES).toContain("shell-darwin-arm64");
  });
});

describe("evaluate", () => {
  it("passes a bundle in which everything agrees", () => {
    const verdict = evaluate(healthyBundle());
    expect(verdict.ok).toBe(true);
    expect(verdict.version).toBe("0.15.1");
    expect(verdict.checks.map((check) => check.name)).toEqual([
      "install",
      "install.ps1",
      "SHA256SUMS",
      "install matches SHA256SUMS",
      "install.ps1 matches SHA256SUMS",
      "release.json",
      "release binaries (2)",
      "shell-darwin-arm64 bytes",
    ]);
  });

  it("names every binary that is missing, and stays readable when many are", () => {
    const bundle = healthyBundle();
    bundle.fetched.binaries["shell-linux-amd64"] = { status: 404, contentType: "text/plain", length: 19 };
    const verdict = evaluate(bundle);
    expect(verdict.ok).toBe(false);
    const row = verdict.checks.find((check) => check.name.startsWith("release binaries"));
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("1 of 2 unavailable: shell-linux-amd64 (answered 404)");
  });

  it("treats a served HTML page as a failure even with a 200", () => {
    const bundle = healthyBundle();
    bundle.fetched.files.SHA256SUMS = { status: 200, contentType: "text/html", bytes: text("<!doctype html><html></html>") };
    const verdict = evaluate(bundle);
    expect(verdict.checks.find((check) => check.name === "SHA256SUMS")?.detail).toContain("HTML page");
    expect(verdict.ok).toBe(false);
  });

  it("catches a script that is not the one the manifest was built with", () => {
    const bundle = healthyBundle();
    bundle.fetched.files.install = { status: 200, contentType: "text/x-shellscript", bytes: text("#!/bin/sh\necho changed\n") };
    const verdict = evaluate(bundle);
    expect(verdict.checks.find((check) => check.name === "install")?.ok).toBe(true);
    expect(verdict.checks.find((check) => check.name === "install matches SHA256SUMS")?.ok).toBe(false);
  });

  it("catches a sample whose bytes disagree with the manifest", () => {
    const bundle = healthyBundle();
    bundle.fetched.files["shell-darwin-arm64"] = { status: 200, contentType: "application/octet-stream", bytes: new Uint8Array(MIN_BINARY_BYTES + 1).fill(9) };
    const verdict = evaluate(bundle);
    expect(verdict.checks.find((check) => check.name === "shell-darwin-arm64 bytes")?.detail).toContain("does not match");
  });

  it("catches a release manifest that disagrees with the checksum manifest", () => {
    const bundle = healthyBundle();
    bundle.fetched.files["release.json"] = { status: 200, contentType: "application/json", bytes: text(JSON.stringify({ version: "0.15.1", artifacts: { "shell-darwin-arm64": "e".repeat(64), "shell-linux-amd64": "e".repeat(64) } })) };
    const verdict = evaluate(bundle);
    expect(verdict.checks.find((check) => check.name === "release.json")?.detail).toContain("disagree with SHA256SUMS");
  });
});

describe("tableCell", () => {
  it("escapes backslashes before pipes, so a pipe cannot be un-escaped, and flattens line breaks", () => {
    expect(tableCell("a|b")).toBe("a\\|b");
    expect(tableCell("a\\|b")).toBe("a\\\\\\|b");
    expect(tableCell("one\ntwo\r\nthree")).toBe("one two three");
  });
});

describe("renderReport", () => {
  it("leads with the verdict and lists one row per check", () => {
    const verdict = evaluate(healthyBundle());
    const report = renderReport({ origin: "https://shell.online", checkedAt: "2026-09-15T17:00:00.000Z", ...verdict });
    expect(report.startsWith("## Downloads are healthy at https://shell.online")).toBe(true);
    expect(report).toContain("published version 0.15.1");
    expect(report.split("\n").filter((line) => line.startsWith("| ")).length).toBe(verdict.checks.length + 1);
  });

  it("says plainly that installs fail when they will", () => {
    const bundle = healthyBundle();
    bundle.fetched.files.SHA256SUMS = { status: 404, contentType: "text/plain", bytes: text("Download not found\n") };
    const report = renderReport({ origin: "https://shell.online", checkedAt: "now", ...evaluate(bundle) });
    expect(report).toContain("Downloads are failing");
    expect(report).toContain("Installs will fail until this is fixed.");
  });
});
