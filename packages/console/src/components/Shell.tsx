import type { ReactNode } from "react";
import { useUpstreams } from "../api";
import { Link, usePath } from "../router";
import { Perforation } from "./Chain";
import { Wire } from "./Wire";

function Mark() {
  // Two links, one inked: the product in 20px.
  return (
    <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden className="shrink-0">
      <rect x="1" y="2" width="10" height="10" fill="var(--accent)" />
      <rect x="11" y="6" width="6" height="2" fill="var(--accent)" />
      <rect x="17.75" y="2.75" width="8.5" height="8.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePath();
  const active = path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`label micro border-b-[length:var(--rule-heavy)] px-1 py-2 ${
        active ? "border-accent text-accent" : "border-transparent text-n-600 hover:border-n-200 hover:text-accent"
      }`}
    >
      {children}
    </Link>
  );
}

export function Shell({ form, children }: { form: string; children: ReactNode }) {
  const upstreams = useUpstreams();
  // overflow-x-clip: the stamp lands from scale(1.5) and must not widen the page for 260ms on a phone.
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <Perforation />
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b-[length:var(--rule)] border-accent bg-n-0 px-4 sm:px-6">
        <Link href="/queue" className="flex items-center gap-2 py-3" aria-label="Chaperone console home">
          <Mark />
          <span className="text-2 font-[var(--weight-title)] tracking-[var(--track-label)] uppercase text-accent">Chaperone</span>
        </Link>
        <span className="label hidden text-n-400 sm:inline">Form {form}</span>
        <nav className="flex gap-4" aria-label="Screens">
          <NavLink href="/queue">Queue</NavLink>
          <NavLink href="/ledger">Ledger</NavLink>
        </nav>
        <div className="ml-auto hidden items-center gap-4 py-3 md:flex">
          {upstreams.data?.upstreams.map((u) => (
            <span key={u.id} className="flex items-baseline gap-2" title={`upstream id: ${u.id}`}>
              <span className="text-n-800">{u.label}</span>
              <span className="label text-n-600">
                <span className="num text-2 normal-case">{u.pinnedTools}</span> pinned
              </span>
            </span>
          ))}
          {upstreams.data && <span className="label text-n-400">{upstreams.data.householdId}</span>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <Wire />
    </div>
  );
}
