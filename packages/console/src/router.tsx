/**
 * Three routes do not need a router library. `usePath` reads
 * `location.pathname` through `useSyncExternalStore`; `Link` pushes history
 * and notifies. Vite's dev server already falls back to index.html.
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    l();
  }
}

window.addEventListener("popstate", notify);

export function navigate(to: string): void {
  if (to !== window.location.pathname + window.location.search) {
    window.history.pushState(null, "", to);
    window.scrollTo(0, 0);
    notify();
  }
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => window.location.pathname,
  );
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
