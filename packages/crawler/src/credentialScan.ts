/**
 * A server "requires credentials" if its own listing or README says so, in
 * its own words — this is a text scan, not a runtime capability probe.
 * Populated at assemble time (not boot time) so it's available before the
 * boot phase exists, and later explains the boot-failure distribution:
 * servers this flags true are the ones expected to fail to boot with
 * placeholder env vars.
 */
const CREDENTIAL_PATTERN = /API_KEY|TOKEN|SECRET|CLIENT_ID/i;

export function textRequiresCredentials(text: string): boolean {
  return CREDENTIAL_PATTERN.test(text);
}

export function anyRequiresCredentials(texts: Array<string | undefined>): boolean {
  return texts.some((text) => text !== undefined && textRequiresCredentials(text));
}

/**
 * The corpus only records a `requiresCredentials` boolean (see above) — it
 * never captured *which* variables a server actually declares, and the boot
 * harness needs concrete names to hand it real-shaped placeholders. Scans
 * for env-var-shaped tokens (`FOO_BAR`, at least two segments so a bare word
 * like `TOKEN` alone doesn't also match every incidental all-caps acronym in
 * a README) that contain a credential keyword — the same signal
 * `textRequiresCredentials` already uses, just captured by name instead of
 * collapsed to a boolean. This is a real extraction from the server's own
 * published text, not a guess: a name this misses just means the container
 * gets one fewer irrelevant placeholder, never a wrong one.
 */
const ENV_VAR_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

export function extractDeclaredEnvVarNames(text: string): string[] {
  const matches = text.match(ENV_VAR_TOKEN) ?? [];
  const names = new Set(matches.filter((token) => CREDENTIAL_PATTERN.test(token)));
  return [...names];
}
