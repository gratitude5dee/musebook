// apps/web/components/distribute/distribute-client.tsx — the §12.3.7 island.
// Every action POSTs https://musebook.dev/api/distribute (same origin): the
// outbox write + queue send live on musebook-edge because Vercel has neither
// binding. Send is one click for the whole fan-out; Regenerate/Edit/Exclude
// are per channel.
"use client";
import type { ReactElement } from "react";

import { useMemo, useState } from "react";
import { VariantCard } from "@musebook/ui/distribution/VariantCard";
import type { ChannelCard, DistributeView } from "@/lib/distribute/data";

interface ActionResult {
  status?: string;
  is_valid?: boolean;
  error?: string;
}

async function callDistribute(body: Record<string, unknown>): Promise<ActionResult> {
  const res = await fetch("/api/distribute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ error: `http_${res.status}` }))) as ActionResult;
}

export function DistributeClient(props: { view: DistributeView }): ReactElement {
  const { view } = props;
  const gated = view.priced;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const platforms = useMemo(
    () => [...new Set(view.channels.map((c) => c.platform))],
    [view.channels],
  );

  const mark = (channelId: string, patch: Partial<Record<string, boolean>>) =>
    setBusy((b) => ({ ...b, [channelId]: patch.busy === true }));
  const note = (channelId: string, text: string) => setNotes((n) => ({ ...n, [channelId]: text }));

  const send = async (): Promise<void> => {
    setSendStatus("sending…");
    const r = await callDistribute({
      action: "send",
      postId: view.postId,
      postVersionId: view.postVersionId,
      platforms,
    });
    setSendStatus(
      r.error !== undefined
        ? `failed: ${r.error}`
        : r.status === "already_queued"
          ? "already queued"
          : "queued",
    );
  };

  const regenerate = async (c: ChannelCard): Promise<void> => {
    mark(c.channelId, { busy: true });
    const r = await callDistribute({
      action: "regenerate",
      postId: view.postId,
      postVersionId: view.postVersionId,
      channelId: c.channelId,
    });
    mark(c.channelId, { busy: false });
    note(c.channelId, r.error !== undefined ? `failed: ${r.error}` : "regeneration queued");
  };

  const saveEdit = async (c: ChannelCard, body: string): Promise<void> => {
    mark(c.channelId, { busy: true });
    const r = await callDistribute({
      action: "edit",
      postId: view.postId,
      postVersionId: view.postVersionId,
      channelId: c.channelId,
      body,
      threadParts: c.candidate?.threadParts ?? [],
    });
    mark(c.channelId, { busy: false });
    note(
      c.channelId,
      r.error !== undefined
        ? `failed: ${r.error}`
        : r.is_valid === false
          ? "saved — variant is INVALID and will not publish"
          : "saved",
    );
  };

  const exclude = async (c: ChannelCard): Promise<void> => {
    mark(c.channelId, { busy: true });
    const r = await callDistribute({
      action: "exclude",
      postId: view.postId,
      postVersionId: view.postVersionId,
      channelId: c.channelId,
    });
    mark(c.channelId, { busy: false });
    if (r.error !== undefined) {
      note(c.channelId, `failed: ${r.error}`);
    } else {
      setExcluded((s) => new Set(s).add(c.channelId));
      note(c.channelId, "excluded");
    }
  };

  return (
    <div className="distribute">
      <header className="distribute-header">
        <h1>Distribute</h1>
        <p>
          {view.channels.length} channel{view.channels.length === 1 ? "" : "s"}, {platforms.length}{" "}
          platform{platforms.length === 1 ? "" : "s"} — each port is the full post, not a teaser.
        </p>
        <button
          type="button"
          className="send"
          onClick={() => void send()}
          disabled={sendStatus === "sending…"}
        >
          Send
        </button>
        {sendStatus !== null ? <span role="status">{sendStatus}</span> : null}
      </header>

      {view.channels.map((c) => {
        if (excluded.has(c.channelId)) {
          return (
            <section key={c.channelId} aria-label={`${c.platform} excluded`}>
              <p>
                <strong>{c.platform}</strong>
                {c.handle !== null ? ` @${c.handle}` : ""} — excluded from this send.
              </p>
            </section>
          );
        }
        const edited = drafts[c.channelId];
        const candidate =
          c.candidate === null || edited === undefined
            ? c.candidate
            : { ...c.candidate, body: edited };
        return (
          <div key={c.channelId}>
            <p>
              {c.handle !== null ? `@${c.handle}` : (c.displayName ?? c.platform)}
              {c.job !== null
                ? ` — ${c.job.state}${c.job.scheduledFor !== null ? ` · ${c.job.scheduledFor}` : ""}`
                : ""}
              {c.job?.platformPostUrl != null ? (
                <>
                  {" — "}
                  <a href={c.job.platformPostUrl}>live post</a>
                </>
              ) : null}
            </p>
            {candidate !== null ? (
              <VariantCard
                candidate={candidate}
                constraint={c.constraint}
                {...(gated ? { gated } : {})}
                onEdit={(body) => {
                  setDrafts((d) => ({ ...d, [c.channelId]: body }));
                  void saveEdit(c, body);
                }}
                onRegenerate={
                  busy[c.channelId] === true
                    ? undefined
                    : () => {
                        void regenerate(c);
                      }
                }
                onExclude={
                  busy[c.channelId] === true
                    ? undefined
                    : () => {
                        void exclude(c);
                      }
                }
              />
            ) : (
              <section>
                <h3>{c.constraint.displayName}</h3>
                <p>No variant yet — press Send to generate the {c.constraint.displayName} port.</p>
              </section>
            )}
            {notes[c.channelId] !== undefined ? <p role="status">{notes[c.channelId]}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
