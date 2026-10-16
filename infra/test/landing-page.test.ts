import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The public landing page at "/" (deploy/site/index.html) and the Caddy route
 * that serves it. What must stay true: the page makes no request to anything
 * but this origin's /healthz, has no control that writes, the Caddyfile's CSP
 * pins its exact inline style and script, and only "/" is served from disk.
 */

const DEPLOY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy");
const html = fs.readFileSync(path.join(DEPLOY, "site", "index.html"), "utf8").replace(/\r\n/g, "\n");
const caddyfile = fs.readFileSync(path.join(DEPLOY, "Caddyfile"), "utf8").replace(/\r\n/g, "\n");

function inlineBlocks(tag: "style" | "script"): string[] {
  return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
}

function sha256(source: string): string {
  return `'sha256-${crypto.createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

describe("landing page", () => {
  it("pins its one inline style and one inline script by hash in the Caddyfile's CSP", () => {
    const styles = inlineBlocks("style");
    const scripts = inlineBlocks("script");
    expect(styles).toHaveLength(1);
    expect(scripts).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/\sstyle="/i); // a style attribute would be blocked by a hash-only style-src
    const csp = caddyfile.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain(`style-src ${sha256(styles[0] ?? "")}`);
    expect(csp).toContain(`script-src ${sha256(scripts[0] ?? "")}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
  });

  it("loads nothing from elsewhere and fetches only same-origin /healthz", () => {
    // Every src/href that would make the browser load something on page load.
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/<link(?![^>]*href="data:,")[^>]*>/i);
    expect(html).not.toMatch(/@import|url\(/i);
    const fetches = [...html.matchAll(/fetch\(\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(fetches).toEqual(["/healthz"]);
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  });

  it("has no form, no button and no write of any kind", () => {
    expect(html).not.toMatch(/<form|<button|<input|<textarea|<select/i);
    expect(html).not.toMatch(/method\s*:\s*"(POST|PUT|PATCH|DELETE)"/i);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("never names the demo upstream's control routes", () => {
    expect(html).not.toMatch(/\/control|demo-upstream|:4000/);
  });

  it("labels the consent card as an example, not live data", () => {
    expect(html).toMatch(/Example · a static picture, not live data/);
    expect(html).toMatch(/not a live quarantine/);
  });

  it("serves only the exact path / from disk and proxies everything else to the gateway", () => {
    const handles = [...caddyfile.matchAll(/^\thandle\b([^{]*)\{/gm)].map((m) => (m[1] ?? "").trim());
    expect(handles).toEqual(["/", ""]);
    expect(caddyfile.match(/file_server/g)).toHaveLength(1);
    expect(caddyfile).toMatch(/rewrite \* \/index\.html/);
    // The streaming guarantees are unchanged on the proxied branch.
    expect(caddyfile).toMatch(/reverse_proxy gateway:3000 \{\n\t\t\tflush_interval -1/);
  });
});
