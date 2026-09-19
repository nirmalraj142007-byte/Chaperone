import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { navigate, usePath } from "./router";
import { Shell } from "./components/Shell";
import { Queue } from "./screens/Queue";
import { QueueDetail } from "./screens/QueueDetail";
import { Ledger } from "./screens/Ledger";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      // A 404 or a 503 is an answer, not a flake: show it rather than retrying it away.
      retry: 1,
    },
  },
});

function App() {
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
  return (
    <Shell form="CH-1 · Review queue">
      <Queue />
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
