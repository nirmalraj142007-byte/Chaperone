import * as ledger from "@chaperone/ledger";

/**
 * The advisory row for a quarantine: a real, model-written row if one
 * exists, otherwise the hand-written fixture for that exact definition (see
 * the FIXTURE_MODEL_ID_PREFIX note in packages/ledger/src/repos/advisory.ts
 * — only the offline demo ever writes one). A real row always wins, and
 * a caller that shows the result tells the two apart with
 * `ledger.isFixtureAdvisory`. Throws on a storage failure, like the two
 * reads it wraps; both callers already degrade that to "no advisory".
 */
export async function advisoryFor(quarantine: {
  quarantineId: string;
  toHash: string;
}): Promise<ledger.Advisory | undefined> {
  const real = await ledger.getAdvisory(quarantine.quarantineId);
  if (real !== undefined) {
    return real;
  }
  return ledger.getFixtureAdvisory(quarantine.toHash);
}
