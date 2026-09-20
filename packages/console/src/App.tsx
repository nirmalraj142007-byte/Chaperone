/**
 * Route table. Six screens, matched on `location.pathname` — see
 * router.tsx for why there is no router library.
 *
 * Separate from main.tsx so the snapshot suite can mount it directly with
 * its own providers. main.tsx keeps the two things a test must not do:
 * `createRoot` on the real document, and the `virtual:chaperone-evidence`
 * import, which only exists inside a Vite build.
 */
import { useEffect } from "react";
import { navigate, usePath } from "./router";
import { Shell } from "./components/Shell";
import { Queue } from "./screens/Queue";
import { QueueDetail } from "./screens/QueueDetail";
import { Ledger } from "./screens/Ledger";
import { Corpus } from "./screens/Corpus";
import { Bench } from "./screens/Bench";
import { Upstreams } from "./screens/Upstreams";

export function App() {
  const path = usePath();
  const detail = /^\/queue\/([^/]+)$/.exec(path);

  useEffect(() => {
    if (path === "/" || path === "") {
      navigate("/queue");
    }
  }, [path]);

  if (detail?.[1] !== undefined) {
    return (
      <Shell form="CH-2 · Change detail">
        <QueueDetail id={decodeURIComponent(detail[1])} />
      </Shell>
    );
  }
  if (path.startsWith("/ledger")) {
    return (
      <Shell form="CH-3 · Ledger">
        <Ledger />
      </Shell>
    );
  }
  if (path.startsWith("/corpus")) {
    return (
      <Shell form="CH-4 · Corpus">
        <Corpus />
      </Shell>
    );
  }
  if (path.startsWith("/bench")) {
    return (
      <Shell form="CH-5 · Bench">
        <Bench />
      </Shell>
    );
  }
  if (path.startsWith("/upstreams")) {
    return (
      <Shell form="CH-6 · Upstreams">
        <Upstreams />
      </Shell>
    );
  }
  return (
    <Shell form="CH-1 · Review queue">
      <Queue />
    </Shell>
  );
}
