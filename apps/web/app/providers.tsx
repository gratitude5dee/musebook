// app/providers.tsx — §14.2.4's single client provider boundary:
// ThirdwebProvider (react-query for wallet hooks) beside ThemeProvider.
"use client";
import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ThirdwebProvider } from "thirdweb/react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <ThirdwebProvider>{children}</ThirdwebProvider>
    </ThemeProvider>
  );
}
