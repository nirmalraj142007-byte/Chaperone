/**
 * Lint-level guard against the exact bug class that shipped twice past a
 * green mocked suite: `ttl` (friction-log Entry 021) and `status`
 * (Entry 024) each went into a `KeyConditionExpression`/`UpdateExpression`
 * as a bare attribute name that happens to be a DynamoDB reserved word.
 * `aws-sdk-client-mock` fakes the SDK's response and never parses the
 * expression string, so a query real DynamoDB rejects outright still
 * "passes" every repo test built on it — only a real DynamoDB Local run
 * (or, as with Entry 024, a live docker-compose VERIFY step) ever catches
 * it. This test catches it statically instead, at `pnpm test` speed,
 * before either of those.
 *
 * Scans every `.ts` file under packages/ledger/src for the five
 * DynamoDB expression-string properties (AWS's own grouping, at
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.html:
 * key condition, condition, update, filter, projection), extracts every
 * bare (non-`#`, non-`:`) identifier token in each one, and fails if any
 * of them is a reserved word per the vendored list in
 * fixtures/dynamodb-reserved-words.json. A `#alias` or `:value`
 * placeholder is exempt by construction — the whole point of an alias is
 * that the reserved word never appears un-aliased in the expression
 * string itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(TEST_DIR, "..", "src");

interface ReservedWordsFixture {
  _source: string;
  words: string[];
}

const fixture = JSON.parse(
  readFileSync(join(TEST_DIR, "fixtures", "dynamodb-reserved-words.json"), "utf8"),
) as ReservedWordsFixture;
const RESERVED_WORDS = new Set(fixture.words.map((w) => w.toUpperCase()));

/**
 * DynamoDB's own expression-language keywords and built-in function
 * names. Several of these coincide with entries in the reserved
 * *attribute-name* list purely because that list is drawn broadly from
 * ANSI SQL vocabulary (573 words) — used here in keyword/function
 * position, never as an attribute reference, so flagging them would be a
 * false positive, not the bug class this guard exists to catch.
 */
const EXPRESSION_SYNTAX_ALLOWLIST = new Set([
  "SET",
  "ADD",
  "REMOVE",
  "DELETE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "BEGINS_WITH",
  "ATTRIBUTE_EXISTS",
  "ATTRIBUTE_NOT_EXISTS",
  "ATTRIBUTE_TYPE",
  "CONTAINS",
  "SIZE",
  "IF_NOT_EXISTS",
  "LIST_APPEND",
]);

const EXPRESSION_LABELS = [
  "KeyConditionExpression",
  "ConditionExpression",
  "UpdateExpression",
  "FilterExpression",
  "ProjectionExpression",
];

/** Matches an expression-property label immediately followed by its `:` — excludes the same word appearing in prose (a comment, a doc string) rather than as an object property. */
const LABEL_PATTERN = new RegExp(`\\b(?:${EXPRESSION_LABELS.join("|")})\\s*:`, "g");

/**
 * From just after a label's `:`, scans character-by-character, collecting
 * the contents of every string literal encountered, until a comma or `}`
 * at bracket depth 0 ends the property. Handles both the common single-
 * string-literal case and this codebase's ternary-between-two-string-
 * literals case (driftRecord.ts, toolSnapshot.ts) without needing a full
 * JS/TS parser — deliberately not a general-purpose expression parser,
 * only as much as this repo's own small set of call sites needs.
 */
function collectExpressionStrings(source: string, fromIndex: number): string[] {
  const strings: string[] = [];
  let depth = 0;
  let i = fromIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let content = "";
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") {
          content += source[j] + (source[j + 1] ?? "");
          j += 2;
          continue;
        }
        content += source[j];
        j += 1;
      }
      strings.push(content);
      i = j + 1;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if ((ch === "," || ch === "}") && depth <= 0) break;
    i += 1;
  }
  return strings;
}

/** Every bare (unaliased, non-value-placeholder) reserved-word token found in one expression string, in the order they appear. */
function findBareReservedWords(expression: string): string[] {
  const found: string[] = [];
  const tokenPattern = /([:#]?)([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(expression)) !== null) {
    const [, prefix, word] = match;
    if (prefix === ":" || prefix === "#") {
      continue; // a value placeholder or an already-aliased name — exempt by definition
    }
    const upper = word!.toUpperCase();
    if (EXPRESSION_SYNTAX_ALLOWLIST.has(upper)) {
      continue;
    }
    if (RESERVED_WORDS.has(upper)) {
      found.push(word!);
    }
  }
  return found;
}

interface Violation {
  file: string;
  expression: string;
  word: string;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => join(dir, entry));
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of listSourceFiles(SRC_DIR)) {
    const source = readFileSync(filePath, "utf8");
    const relPath = relative(join(TEST_DIR, ".."), filePath).split("\\").join("/");
    let labelMatch: RegExpExecArray | null;
    LABEL_PATTERN.lastIndex = 0;
    while ((labelMatch = LABEL_PATTERN.exec(source)) !== null) {
      const expressions = collectExpressionStrings(source, labelMatch.index + labelMatch[0].length);
      for (const expression of expressions) {
        for (const word of findBareReservedWords(expression)) {
          violations.push({ file: relPath, expression, word });
        }
      }
    }
  }
  return violations;
}

describe("packages/ledger DynamoDB expressions never use a bare reserved word", () => {
  it("the vendored word list itself looks sane (non-trivial, from the documented source)", () => {
    expect(fixture._source).toContain("docs.aws.amazon.com");
    expect(fixture.words.length).toBeGreaterThan(500);
    expect(RESERVED_WORDS.has("STATUS")).toBe(true);
    expect(RESERVED_WORDS.has("TTL")).toBe(true);
  });

  it("finds no unaliased reserved-word attribute references in any KeyConditionExpression/ConditionExpression/UpdateExpression/FilterExpression/ProjectionExpression", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}: "${v.expression}" uses bare reserved word "${v.word}" — alias it as "#${v.word.toLowerCase()}" via ExpressionAttributeNames`)
        .join("\n");
      expect.fail(`Found ${violations.length} unaliased reserved-word attribute reference(s):\n${detail}`);
    }
  });

  // Regression proof that the scanner itself actually catches the two bugs
  // that shipped — run against literal reproductions of the broken
  // expressions, not against live source (which is already fixed).
  it("would have caught Entry 021's bare `ttl` in an UpdateExpression", () => {
    expect(findBareReservedWords("SET lastSeenAt = :lastSeenAt, ttl = :ttl")).toEqual(["ttl"]);
  });

  it("would have caught Entry 024's bare `status` in a KeyConditionExpression", () => {
    expect(findBareReservedWords("status = :status")).toEqual(["status"]);
  });

  it("does not flag the same words once properly aliased", () => {
    expect(findBareReservedWords("SET lastSeenAt = :lastSeenAt, #ttl = :ttl")).toEqual([]);
    expect(findBareReservedWords("#status = :status")).toEqual([]);
  });

  it("does not flag DynamoDB's own expression-language keywords and functions used as such", () => {
    expect(findBareReservedWords("ADD nextSeq :incr SET #ttl = if_not_exists(#ttl, :ttl)")).toEqual([]);
    expect(findBareReservedWords("pk = :pk AND begins_with(sk, :skPrefix)")).toEqual([]);
    expect(findBareReservedWords("attribute_not_exists(sk)")).toEqual([]);
  });

  it("does not flag non-reserved compound attribute names that merely contain a reserved word as a substring", () => {
    // "bootStatus" and "capabilityClass" must never match "STATUS"/"CLASS" —
    // DynamoDB's reserved-word check is a whole-token match, not a substring one.
    expect(findBareReservedWords("bootStatus = :bootStatus")).toEqual([]);
    expect(findBareReservedWords("changeClass = :changeClass AND capabilityClass = :capabilityClass")).toEqual([]);
  });
});
