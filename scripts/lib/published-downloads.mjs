/*
 * What a published download bundle has to look like, and how to judge one.
 *
 * Pure: nothing here fetches. check-published-downloads.mjs fetches from a
 * deployment and hands the bytes and statuses to evaluate(), so the judgement
 * can be tested without a network and read without a browser.
 */

/** Files that ship beside the binaries and are listed in SHA256SUMS. */
export const SIGNED_EXTRAS = ["install", "install.ps1", "SKILL.md", "release.json"];

/** A release binary smaller than this is a stub or an error page, never shell. */
export const MIN_BINARY_BYTES = 1_000_000;

/** The binaries fetched in full and hashed, one per desktop platform. */
export const DEFAULT_SAMPLES = ["shell-darwin-arm64", "shell-linux-amd64", "shell-windows-amd64.exe"];

export function parseReleaseTargets(tsv) {
  const rows = tsv
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
  if (rows.some((row) => row.length !== 4)) throw new Error("release target manifest is invalid");
  const artifacts = rows.map(([artifact]) => artifact);
  if (new Set(artifacts).size !== artifacts.length) throw new Error("release target manifest repeats an artifact");
  return artifacts;
}

/** `<sha256>  <name>` per line, as sha256sum writes it. Returns a Map or throws on a malformed line. */
export function parseChecksumManifest(text) {
  const manifest = new Map();
  for (const line of text.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) {2}(\S+)$/);
    if (!match || manifest.has(match[2])) throw new Error(`SHA256SUMS contains an invalid entry: ${line}`);
    manifest.set(match[2], match[1]);
  }
  return manifest;
}

export function looksLikeHtml(bytes) {
  const head = Buffer.from(bytes).subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * Judges a fetched bundle.
 *
 * `fetched` carries, per file, what the deployment answered: status, content
 * type, length, and for the scripts, manifests and samples, the bytes. Every
 * check is one row of the report: a name, a verdict, and a sentence that says
 * what was found, so a failing run reads as a diagnosis and not as a red X.
 */
export function evaluate({ artifacts, fetched, samples = DEFAULT_SAMPLES, sha256 }) {
  const checks = [];
  const note = (name, ok, detail) => checks.push({ name, ok, detail });

  const script = (name, marker) => {
    const file = fetched.files[name];
    if (!file || file.status !== 200) return note(name, false, `answered ${file?.status ?? "nothing"}`);
    if (looksLikeHtml(file.bytes)) return note(name, false, "answered an HTML page instead of the script");
    const head = Buffer.from(file.bytes).toString("utf8").split("\n")[0].trim();
    if (!head.startsWith(marker)) return note(name, false, `first line is ${JSON.stringify(head.slice(0, 40))}, expected ${marker}`);
    note(name, true, `${file.bytes.length} bytes, sha256 ${sha256(file.bytes).slice(0, 12)}…`);
  };
  script("install", "#!/bin/sh");
  script("install.ps1", "[CmdletBinding()]");

  let manifest = null;
  const manifestFile = fetched.files["SHA256SUMS"];
  if (!manifestFile || manifestFile.status !== 200) {
    note("SHA256SUMS", false, `answered ${manifestFile?.status ?? "nothing"}`);
  } else if (looksLikeHtml(manifestFile.bytes)) {
    note("SHA256SUMS", false, "answered an HTML page instead of the manifest");
  } else {
    try {
      manifest = parseChecksumManifest(Buffer.from(manifestFile.bytes).toString("utf8"));
      const expected = [...artifacts, ...SIGNED_EXTRAS];
      const missing = expected.filter((name) => !manifest.has(name));
      if (missing.length > 0) {
        note("SHA256SUMS", false, `lists ${manifest.size} files but is missing ${missing.length}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      } else {
        note("SHA256SUMS", true, `lists all ${expected.length} files`);
      }
    } catch (error) {
      note("SHA256SUMS", false, error.message);
    }
  }

  for (const name of ["install", "install.ps1"]) {
    const file = fetched.files[name];
    if (!manifest || !file || file.status !== 200) continue;
    const expected = manifest.get(name);
    const actual = sha256(file.bytes);
    note(`${name} matches SHA256SUMS`, expected === actual, expected === actual ? "the served script is the one in the manifest" : "the served script is not the one the manifest was built with");
  }

  let version = null;
  const releaseFile = fetched.files["release.json"];
  if (!releaseFile || releaseFile.status !== 200) {
    note("release.json", false, `answered ${releaseFile?.status ?? "nothing"}`);
  } else if (looksLikeHtml(releaseFile.bytes)) {
    note("release.json", false, "answered an HTML page instead of the manifest");
  } else {
    try {
      const release = JSON.parse(Buffer.from(releaseFile.bytes).toString("utf8"));
      version = typeof release.version === "string" && /^\d+\.\d+\.\d+$/.test(release.version) ? release.version : null;
      const listed = Object.keys(release.artifacts ?? {});
      const missing = artifacts.filter((name) => !listed.includes(name));
      const disagreeing = manifest
        ? artifacts.filter((name) => manifest.has(name) && release.artifacts?.[name] !== manifest.get(name))
        : [];
      if (!version) note("release.json", false, `version is ${JSON.stringify(release.version)}`);
      else if (missing.length > 0) note("release.json", false, `${version}, missing ${missing.length} artifact(s): ${missing.slice(0, 5).join(", ")}`);
      else if (disagreeing.length > 0) note("release.json", false, `${version}, but ${disagreeing.length} checksum(s) disagree with SHA256SUMS: ${disagreeing.slice(0, 5).join(", ")}`);
      else note("release.json", true, `${version}, ${listed.length} artifacts, agrees with SHA256SUMS`);
    } catch (error) {
      note("release.json", false, `is not JSON: ${error.message}`);
    }
  }

  const binaries = artifacts.map((name) => {
    const head = fetched.binaries[name];
    if (!head || (head.status !== 200 && head.status !== 206)) return { name, ok: false, why: `answered ${head?.status ?? "nothing"}` };
    if ((head.contentType ?? "").toLowerCase().startsWith("text/html")) return { name, ok: false, why: "answered an HTML page" };
    if (head.length !== null && head.length < MIN_BINARY_BYTES) return { name, ok: false, why: `only ${head.length} bytes` };
    return { name, ok: true };
  });
  const broken = binaries.filter((entry) => !entry.ok);
  note(
    `release binaries (${artifacts.length})`,
    broken.length === 0,
    broken.length === 0
      ? `all ${artifacts.length} answer 200 with a plausible size`
      : `${broken.length} of ${artifacts.length} unavailable: ${broken.slice(0, 6).map((entry) => `${entry.name} (${entry.why})`).join(", ")}${broken.length > 6 ? "…" : ""}`,
  );

  for (const name of samples) {
    const file = fetched.files[name];
    if (!file || file.status !== 200) {
      note(`${name} bytes`, false, `answered ${file?.status ?? "nothing"}`);
      continue;
    }
    if (!manifest || !manifest.has(name)) {
      note(`${name} bytes`, false, "downloaded, but no manifest entry to check it against");
      continue;
    }
    const actual = sha256(file.bytes);
    const ok = actual === manifest.get(name) && file.bytes.length >= MIN_BINARY_BYTES;
    note(`${name} bytes`, ok, ok ? `${file.bytes.length} bytes, checksum matches the manifest` : `checksum ${actual.slice(0, 12)}… does not match the manifest`);
  }

  return { ok: checks.every((check) => check.ok), version, checks, binaries };
}

/*
 * A Markdown table cell. Backslashes are escaped first, so a backslash already
 * in the text cannot turn the escape on a following pipe back into a table
 * delimiter; then pipes, then line breaks, which a cell cannot hold.
 */
export function tableCell(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/** A Markdown report: the verdict, then one row per check. */
export function renderReport({ origin, checkedAt, ok, version, checks }) {
  const lines = [
    `## ${ok ? "Downloads are healthy" : "Downloads are failing"} at ${origin}`,
    "",
    `${ok ? "Every install path answers." : "Installs will fail until this is fixed."} Checked ${checkedAt}${version ? `, published version ${version}` : ""}.`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...checks.map((check) => `| ${tableCell(check.name)} | ${check.ok ? "pass" : "**fail**"} | ${tableCell(check.detail)} |`),
  ];
  return `${lines.join("\n")}\n`;
}
