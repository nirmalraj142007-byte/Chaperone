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
