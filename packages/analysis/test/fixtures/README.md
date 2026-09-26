# TEST FIXTURE: not crawl data

Nothing in this directory is a crawl result, and nothing here is written
under `data/`.

`drift-fixture.ts` builds a throwaway data directory in the OS temp folder for
each test run. It copies crawl 1's committed evidence as it is
(`data/crawl-1-report.json`, `data/crawl-1-capabilities-v2.json` and the
`BOOTED` archives under `data/raw/crawl-1/`), then **invents** two later
snapshots, `crawl-interim-1` and `crawl-2`, by applying the hand-written
mutations in `MUTATIONS` to a few real crawl-1 tools:

| Server (real crawl-1 ID)   | What the fixture does                                                         | Expected                                   |
|----------------------------|--------------------------------------------------------------------------------|--------------------------------------------|
| `8ensmith…open-library`    | crawl 2: trailing period dropped, spaces doubled                              | cosmetic, mechanical                       |
| `acedatacloud…fluxmcp`     | crawl 2: new optional property                                                | schema-additive, mechanical                |
| `austenstone…myinstants`   | interim and crawl 2: sentence appended claiming calendar and contact access   | semantic-intent (human), seen by interim   |
| `bluesprince…thiri`        | crawl 2 only: new required property                                          | semantic-intent (human), only after interim |
| `cfpramod…open-museum`     | crawl 2: one word misspelt                                                    | proposed semantic-intent; human says cosmetic |
| `carlosahumada89…govrider` | interim: sentence appended; crawl 2: back to crawl 1's exact text            | reversion; not in the headline             |
| `codeislaw101…katzilla`    | crawl 2: one tool removed, one tool added                                     | tool-removed, tool-added                   |
| `arikusi…deepseek`         | crawl 2: fails to boot                                                        | server absent in later crawl               |
| `bighippoman…intercept`    | interim: fails to boot; crawl 2: sentence appended                            | semantic-intent, drifted but not captured at interim |

Every invented report carries `"$fixture"` naming it as a test fixture, and
its dates (2026-10-02, 2026-10-20) are fixture values, not observations.
