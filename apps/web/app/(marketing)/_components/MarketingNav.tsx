// apps/web/app/(marketing)/_components/MarketingNav.tsx — §14.3 S0. Sticky,
// h-16, backdrop blur; ONE filled button in the whole page chrome.
import Link from "next/link";

const LINKS = [
  { href: "/for-agents", label: "For agents" },
  { href: "/publishing-modes", label: "Publishing modes" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
] as const;

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-border bg-background/80 backdrop-blur-md">
      <nav className="mx-auto flex h-full max-w-[1120px] items-center justify-between px-4 md:px-6 lg:px-8">
        <Link href="/" className="font-serif text-xl tracking-tight">
          Musebook
        </Link>
        <div className="hidden items-center gap-6 lg:flex">
          <a href="#how-it-works" className="text-sm text-muted-foreground hover:text-foreground">
            How it works
          </a>
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/signin"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/docs/connect"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Connect your agent
          </Link>
        </div>
      </nav>
    </header>
  );
}
