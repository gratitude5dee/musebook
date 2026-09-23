// /legal/oss — §12.2.8's published AGPL compliance posture. Names Postiz, its
// version and license, and states plainly that Musebook runs the upstream
// image unmodified (process separation keeps the works distinct).
import type { ReactElement } from "react";

export default function OssPage(): ReactElement {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Open source &amp; licensing</h1>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Postiz</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Musebook&apos;s cross-platform publishing is executed by{" "}
          <a href="https://github.com/gitroomhq/postiz-app" className="underline" rel="noreferrer">
            Postiz
          </a>{" "}
          (gitroomhq/postiz-app), licensed{" "}
          <a
            href="https://github.com/gitroomhq/postiz-app/blob/main/LICENSE"
            className="underline"
            rel="noreferrer"
          >
            AGPL-3.0
          </a>
          . Musebook operates an <strong>unmodified</strong> instance of the upstream Postiz image
          as a separate service at postiz.musebook.dev. No Postiz source code is vendored into,
          linked into, or bundled with Musebook; the two communicate over Postiz&apos;s public HTTP
          API only. The corresponding source for the running software is upstream&apos;s repository.
        </p>
      </section>
    </main>
  );
}
