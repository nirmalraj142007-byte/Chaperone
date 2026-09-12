import { describe, expect, it } from "vitest";
import { allow } from "../src/allow.js";
import { hashTool } from "../src/canonical.js";
import type { ToolDefinition } from "../src/types.js";

describe("allow", () => {
  const tool: ToolDefinition = {
    name: "add_item",
    description: "Adds an item to your shopping list.",
    inputSchema: { type: "object", properties: { item: { type: "string" } } },
  };

  it("allows when the current hash matches the pinned hash", () => {
    const pinned = hashTool(tool);
    const result = allow(tool, pinned);
    expect(result).toEqual({ allowed: true, hash: pinned });
  });

  it("refuses with UNPINNED when there is no pin on record", () => {
    const result = allow(tool, null);
    expect(result).toEqual({
      allowed: false,
      reason: "UNPINNED",
      currentHash: hashTool(tool),
      pinnedHash: null,
    });
  });

  it("refuses with HASH_MISMATCH when the tool changed since it was pinned", () => {
    const pinned = hashTool(tool);
    const changed: ToolDefinition = { ...tool, description: `${tool.description} Also reads your calendar.` };
    const result = allow(changed, pinned);
    expect(result).toEqual({
      allowed: false,
      reason: "HASH_MISMATCH",
      currentHash: hashTool(changed),
      pinnedHash: pinned,
    });
  });

  it("is synchronous", () => {
    // A synchronous function's return value is never a thenable.
    const result = allow(tool, hashTool(tool));
    expect(result).not.toHaveProperty("then");
  });
});

// --- property test: 200 randomly mutated tool definitions ---
//
// A small seeded PRNG (mulberry32) instead of a fuzzing library, so the
// 200-case run is deterministic and reproducible without adding a
// dependency to a package whose only permitted runtime dependency is
// `canonicalize`.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, minLength: number, maxLength: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.,!";
  const length = minLength + Math.floor(rand() * (maxLength - minLength + 1));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}

function randomJsonValue(rand: () => number, depth: number): unknown {
  const kind = Math.floor(rand() * (depth > 0 ? 5 : 3));
  switch (kind) {
    case 0:
      return randomString(rand, 1, 12);
    case 1:
      return Math.floor(rand() * 1000);
    case 2:
      return rand() > 0.5;
    case 3:
      return Array.from({ length: Math.floor(rand() * 3) + 1 }, () => randomJsonValue(rand, depth - 1));
    default: {
      const obj: Record<string, unknown> = {};
      const fieldCount = Math.floor(rand() * 3) + 1;
      for (let i = 0; i < fieldCount; i++) {
        obj[`field_${i}`] = randomJsonValue(rand, depth - 1);
      }
      return obj;
    }
  }
}

function randomTool(rand: () => number, index: number): ToolDefinition {
  return {
    name: `tool_${index}_${randomString(rand, 3, 10)}`,
    // Always a non-empty description so a single-character mutation is well-defined.
    description: randomString(rand, 5, 40),
    inputSchema: randomJsonValue(rand, 2),
  };
}

function mutateOneCharacter(text: string, rand: () => number): string {
  const index = Math.floor(rand() * text.length);
  const originalCode = text.charCodeAt(index);
  // Shift by 1 within printable ASCII, wrapping, so the result is always
  // guaranteed to differ from the original character.
  const shifted = ((originalCode - 32 + 1) % 95) + 32;
  return text.slice(0, index) + String.fromCharCode(shifted) + text.slice(index + 1);
}

describe("allow: property test over 200 randomly generated tool definitions", () => {
  const rand = mulberry32(0xc0ffee);
  const tools = Array.from({ length: 200 }, (_, i) => randomTool(rand, i));

  it("allow(t, hashTool(t)).allowed === true for every generated tool", () => {
    for (const t of tools) {
      const result = allow(t, hashTool(t));
      expect(result.allowed).toBe(true);
    }
  });

  it("a single-character mutation of description always flips allowed to false", () => {
    for (const t of tools) {
      const pinned = hashTool(t);
      const mutatedDescription = mutateOneCharacter(t.description as string, rand);
      expect(mutatedDescription).not.toBe(t.description);
      const mutated: ToolDefinition = { ...t, description: mutatedDescription };
      const result = allow(mutated, pinned);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("HASH_MISMATCH");
      }
    }
  });
});
