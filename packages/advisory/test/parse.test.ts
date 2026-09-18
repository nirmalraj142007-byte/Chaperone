import { describe, expect, it } from "vitest";
import { parseAdvisoryResponse, stripCodeFence } from "../src/parse.js";

describe("stripCodeFence", () => {
  it("strips a ```json fence", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a bare ``` fence", () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves unfenced text untouched (trimmed)", () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("parseAdvisoryResponse", () => {
  it("parses a plain JSON response", () => {
    const result = parseAdvisoryResponse('{"score": 30, "summary": "Adds calendar read access."}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ score: 30, summary: "Adds calendar read access." });
    }
  });

  it("parses a response wrapped in a ```json fence", () => {
    const result = parseAdvisoryResponse('```json\n{"score": 5, "summary": "Cosmetic wording only."}\n```');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(5);
    }
  });

  it("fails on malformed JSON", () => {
    const result = parseAdvisoryResponse("{score: 5, summary:}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not valid JSON");
    }
  });

  it("fails when the JSON doesn't match AdvisorySchema", () => {
    const result = parseAdvisoryResponse('{"score": "high", "summary": "ok"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("schema validation failed");
    }
  });

  it("fails on valid JSON that isn't even an object", () => {
    const result = parseAdvisoryResponse("42");
    expect(result.ok).toBe(false);
  });

  it("never throws on arbitrary garbage input", () => {
    expect(() => parseAdvisoryResponse("not json at all, just prose the model added")).not.toThrow();
  });
});
