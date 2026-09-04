import { describe, expect, it } from "vitest";
import { downloadAssetIsSpaFallback } from "../shared/download-assets";

describe("download asset routing", () => {
  it("detects the SPA page returned for a missing download", () => {
    expect(downloadAssetIsSpaFallback("/downloads/release.json", "text/html; charset=utf-8")).toBe(true);
  });

  it("keeps real download responses and unrelated HTML pages", () => {
    expect(downloadAssetIsSpaFallback("/downloads/release.json", "application/json")).toBe(false);
    expect(downloadAssetIsSpaFallback("/downloads/shell-linux-amd64", "application/octet-stream")).toBe(false);
    expect(downloadAssetIsSpaFallback("/docs/", "text/html")).toBe(false);
  });
});
