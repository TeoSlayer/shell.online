import { describe, expect, it } from "vitest";
import { filterSearchOptions, type SearchSelectOption } from "../lib/search-options";

const options: SearchSelectOption[] = [
  { value: "s1", label: "Training", detail: "python train.py · gpu-box", keywords: "running" },
  { value: "s2", label: "Agent", detail: "claude · macbook", keywords: "finished" },
];

describe("search select", () => {
  it("searches labels and the contextual detail shown beneath them", () => {
    expect(filterSearchOptions(options, "gpu-box").map((option) => option.value)).toEqual(["s1"]);
    expect(filterSearchOptions(options, "claude").map((option) => option.value)).toEqual(["s2"]);
  });

  it("also searches non-visible keywords such as state", () => {
    expect(filterSearchOptions(options, "running").map((option) => option.value)).toEqual(["s1"]);
  });
});
