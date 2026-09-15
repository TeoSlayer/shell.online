/* Types for published-downloads.mjs, so the tests under tests/ can import it under strict TypeScript. */

export const SIGNED_EXTRAS: readonly string[];
export const MIN_BINARY_BYTES: number;
export const DEFAULT_SAMPLES: readonly string[];

export interface FetchedFile {
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  error?: string;
}

export interface FetchedHead {
  status: number;
  contentType: string | null;
  length: number | null;
  error?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BinaryVerdict {
  name: string;
  ok: boolean;
  why?: string;
}

export interface Verdict {
  ok: boolean;
  version: string | null;
  checks: Check[];
  binaries: BinaryVerdict[];
}

export function parseReleaseTargets(tsv: string): string[];
export function parseChecksumManifest(text: string): Map<string, string>;
export function looksLikeHtml(bytes: Uint8Array): boolean;
export function evaluate(input: {
  artifacts: string[];
  fetched: { files: Record<string, FetchedFile>; binaries: Record<string, FetchedHead> };
  samples?: readonly string[];
  sha256: (bytes: Uint8Array) => string;
}): Verdict;
export function tableCell(text: string): string;
export function renderReport(input: {
  origin: string;
  checkedAt: string;
  ok: boolean;
  version: string | null;
  checks: Check[];
}): string;
