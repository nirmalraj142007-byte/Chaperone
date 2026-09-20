import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import evidence from "virtual:chaperone-evidence";
import "./index.css";
import { App } from "./App";
import { EvidenceContext } from "./evidence";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      // A 404 or a 503 is an answer, not a flake: show it rather than retrying it away.
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The committed crawl, drift and benchmark files, read at build time. /corpus and /bench never fetch. */}
    <EvidenceContext.Provider value={evidence}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </EvidenceContext.Provider>
  </StrictMode>,
);
