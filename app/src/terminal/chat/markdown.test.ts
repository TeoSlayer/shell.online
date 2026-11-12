import { describe, expect, it } from "vitest";
import { hasCodeFence, hasMarkdownTable, looksMarkdown } from "./markdown";

describe("explicit Markdown structures", () => {
  it.each([
    '| Name | Count |\n| --- | ---: |\n| a | 1 |',
    'Name | Count\n:--- | ---:\na | 1',
    '| Name     | Count |\n| :---: | ---: |\n| a | 1 |',
    '| `left|right` | escaped \\| pipe |\n| --- | --- |\n| a | b |',
  ])("recognises a standalone table: %s", text => {
    expect(hasMarkdownTable(text)).toBe(true);
    expect(looksMarkdown(text)).toBe(true);
  });

  it.each(['| lone row |', '| a | b |\n| --- |', 'ls | head', '|a|b|\n|letters|---|'])
    ("does not mistake pipe output for a table: %s", text => expect(hasMarkdownTable(text)).toBe(false));

  it.each(['```python\n__name__\n```', '~~~sh\necho hello\n~~~', '````\n```\n````'])
    ("recognises both fence forms: %s", text => {
      expect(hasCodeFence(text)).toBe(true);
      expect(looksMarkdown(text)).toBe(true);
    });
});
