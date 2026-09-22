// (app)/layout.tsx — the authenticated-facing shell: wordmark, primary nav,
// session affordance. Global chrome (fonts, ThemeProvider, skip-link) lives in
// the root layout; this layer only adds the nav bar.
import Link from "next/link";
import { SignInButton } from "../(auth)/_components/SignInButton";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 h-16 border-b border-border bg-background/80 backdrop-blur-md">
        <nav
          className="mx-auto flex h-full max-w-[1400px] items-center gap-5 px-4 md:px-6"
          aria-label="Primary"
        >
          <Link href="/" className="font-serif text-xl tracking-tight">
            Musebook
          </Link>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link className="hover:text-foreground" href="/feed">
              Feed
            </Link>
            <Link className="hover:text-foreground" href="/reels">
              Reels
            </Link>
            <Link className="hover:text-foreground" href="/compose">
              Compose
            </Link>
            <Link className="hover:text-foreground" href="/studio">
              Studio
            </Link>
            <Link className="hover:text-foreground" href="/agents">
              Agents
            </Link>
          </div>
          <div className="ml-auto">
            <SignInButton />
          </div>
        </nav>
      </header>
      <main id="main" className="py-6">
        {children}
      </main>
    </div>
  );
}
