// apps/web/app/(app)/settings/privacy/page.tsx — §15.10/§15.11's self-serve
// surface: a persistent analytics toggle and the four data-subject verbs.
// Every write goes to the Worker's /api/* routes — this page owns no logic.
"use client";

import { useEffect, useState } from "react";

export default function PrivacySettingsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("mb-consent");
    setEnabled(stored === null ? true : stored === "true");
  }, []);

  async function consent(next: boolean): Promise<void> {
    await fetch("/api/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "analytics", granted: next, source: "settings" }),
      keepalive: true,
    });
    window.localStorage.setItem("mb-consent", String(next));
    setEnabled(next);
  }

  async function dsar(kind: "export" | "delete" | "objection"): Promise<void> {
    const res = await fetch(`/api/me/${kind}`, {
      method: kind === "export" ? "GET" : "POST",
      headers: kind === "delete" ? { "x-mb-reauth": crypto.randomUUID() } : {},
    });
    const doc = (await res.json().catch(() => ({}))) as { request_id?: string };
    if (res.status === 401) {
      setNote(kind === "delete" ? "Re-authentication required for deletion." : "Sign in required.");
      return;
    }
    setRequestId(doc.request_id ?? null);
    setNote(`${kind} request received (30-day SLA).`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">Privacy</h1>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Personalised ranking</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Allow Musebook to use what you read to order your feed. Off = recency.
        </p>
        {enabled === null ? null : (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => void consent(e.target.checked)}
            />
            Personalised ranking
          </label>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Your data</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => void dsar("export")}
          >
            Export my data
          </button>
          <button
            className="rounded border px-3 py-1.5 text-sm"
            onClick={() => void dsar("objection")}
          >
            Object to analytics
          </button>
          <button
            className="rounded border border-red-400 px-3 py-1.5 text-sm text-red-600"
            onClick={() => {
              if (window.confirm("Delete your account and subject-level data? This is final.")) {
                void dsar("delete");
              }
            }}
          >
            Delete my account
          </button>
        </div>
        {note !== null ? <p className="mt-3 text-sm">{note}</p> : null}
        {requestId !== null ? (
          <p className="mt-1 text-sm">
            Track it: <code>/api/me/requests/{requestId}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
