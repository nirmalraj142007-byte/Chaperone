import { describe, expect, it } from "vitest";
import { ConfigError, LedgerWriteError } from "@chaperone/errors";
import { withDynamoErrors } from "../src/errors.js";

function namedError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe("withDynamoErrors", () => {
  it("returns the op's result on success", async () => {
    await expect(withDynamoErrors(async () => "ok")).resolves.toBe("ok");
  });

  it("wraps ResourceNotFoundException as a ConfigError pointing at ddb:migrate", async () => {
    const err = namedError("ResourceNotFoundException");
    const op = async (): Promise<never> => {
      throw err;
    };
    await expect(withDynamoErrors(op)).rejects.toBeInstanceOf(ConfigError);
    await expect(withDynamoErrors(op)).rejects.toThrow(/pnpm ddb:migrate/);
  });

  it("passes through errors that are neither ResourceNotFound nor throttling, unwrapped", async () => {
    const err = namedError("ValidationException", "bad request");
    await expect(
      withDynamoErrors(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("recovers if a throttled call succeeds before exhausting its retries", async () => {
    let attempts = 0;
    const result = await withDynamoErrors(async () => {
      attempts++;
      if (attempts < 2) {
        throw namedError("ThrottlingException");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries the original call 3 more times (4 total) then throws LedgerWriteError, never resolving on a storage error", async () => {
    let attempts = 0;
    const op = async (): Promise<never> => {
      attempts++;
      throw namedError("ProvisionedThroughputExceededException");
    };
    await expect(withDynamoErrors(op)).rejects.toBeInstanceOf(LedgerWriteError);
    expect(attempts).toBe(4);
  }, 10_000);
});
