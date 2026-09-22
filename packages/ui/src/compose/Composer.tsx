// packages/ui/src/compose/Composer.tsx — §14.4.3/§14.4.4. Markdown source is
// the single source of truth (a correctness constraint: content_hash is
// sha256(canonical markdown) and grants/classification bind to it). Autosave
// every 3s as status='draft'; publish rides the edge; uploads ride signed PUTs
// PUTs into musebook-uploads.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalMarkdown, markdownToHtml } from "@musebook/content";
import type { AccessBadgeView, PostKind } from "@musebook/schema";
import { AccessBadge } from "../AccessBadge";
import { GrantWarningDialog } from "./GrantWarningDialog";
import { ModePicker } from "./ModePicker";
import { Preview } from "./Preview";
import type { AccessChoice, ComposerActions, ComposerInitial, DraftInput } from "./types";

const KINDS: PostKind[] = [
  "note",
  "article",
  "image",
  "video",
  "audio",
  "app",
  "model3d",
  "thread",
];

function badgeFor(access: AccessChoice, priceUsd: string | null): AccessBadgeView {
  switch (access) {
    case "open":
      return { kind: "open", rule: "Free for everyone, human and machine." };
    case "toll":
      return {
        kind: "toll",
        priceUsd: priceUsd ?? "0.00",
        rule: "Free for people. Agents pay once to crawl it.",
      };
    case "gated":
      return {
        kind: "gated",
        priceUsd: priceUsd ?? "0.00",
        rule: "Every read is paid, human or agent.",
      };
  }
}

type SaveState = "idle" | "saving" | "saved" | "error";

export interface ComposerProps {
  initial: ComposerInitial;
  actions: ComposerActions;
}

export function Composer({ initial, actions }: ComposerProps) {
  const [postId, setPostId] = useState<string | null>(initial.postId);
  const [slug, setSlug] = useState<string | null>(initial.slug);
  const [contentHash, setContentHash] = useState<string | null>(initial.contentHash);
  const [markdown, setMarkdown] = useState(initial.markdown);
  const [title, setTitle] = useState(initial.title ?? "");
  const [kind, setKind] = useState<PostKind>(initial.kind);
  const [access, setAccess] = useState<AccessChoice>(initial.access);
  const [priceUsd, setPriceUsd] = useState(initial.priceUsd ?? "0.25");
  const [licenseSpdx, setLicenseSpdx] = useState(initial.licenseSpdx);
  const [trainAi, setTrainAi] = useState(initial.trainAi);
  const [aiUse, setAiUse] = useState(initial.aiUse);
  const [searchIndexable, setSearchIndexable] = useState(initial.searchIndexable);
  const [tags, setTags] = useState(initial.tags.join(", "));

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [published, setPublished] = useState(initial.status === "published");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [warned, setWarned] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"write" | "preview">("write");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const dirtyRef = useRef(false);
  const grantCount = initial.liveGrantCount;
  const grantedHash = initial.contentHash;

  const input = useCallback((): DraftInput => {
    return {
      postId,
      kind,
      markdown,
      title: title === "" ? null : title,
      summary: null,
      access,
      priceUsd: access === "open" ? null : priceUsd,
      licenseSpdx,
      trainAi,
      aiUse,
      searchIndexable,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    };
  }, [
    postId,
    kind,
    markdown,
    title,
    access,
    priceUsd,
    licenseSpdx,
    trainAi,
    aiUse,
    searchIndexable,
    tags,
  ]);

  const doSave = useCallback(async () => {
    setSaveState("saving");
    try {
      const saved = await actions.saveDraft(input());
      setPostId(saved.postId);
      setSlug(saved.slug);
      setContentHash(saved.contentHash);
      setSaveState("saved");
      setSavedAt(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      dirtyRef.current = false;
    } catch {
      setSaveState("error");
    }
  }, [actions, input]);

  // Autosave every 3s while dirty — and §1.4's interruption: live grants plus
  // a changed fingerprint interrupt the save instead of silently minting a
  // new content_hash.
  useEffect(() => {
    const t = setInterval(() => {
      if (!dirtyRef.current || publishing || warned) return;
      if (grantCount > 0 && grantedHash !== null) {
        setWarnOpen(true);
        return;
      }
      void doSave();
    }, 3000);
    return () => clearInterval(t);
  }, [grantCount, grantedHash, publishing, warned, doSave]);

  // Flush on unmount-adjacent events the interval would miss.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (dirtyRef.current) void doSave();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [doSave]);

  const markDirty = () => {
    dirtyRef.current = true;
    setSaveState((s) => (s === "error" ? s : "idle"));
  };

  const html = useMemo(() => markdownToHtml(canonicalMarkdown(markdown)), [markdown]);

  const onPublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      if (dirtyRef.current || postId === null) {
        await doSave();
      }
      const id = postIdRef.current;
      if (id === null) throw new Error("draft_not_saved");
      await actions.publish(id, []);
      setPublished(true);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : "publish_failed");
    } finally {
      setPublishing(false);
    }
  };
  const postIdRef = useRef(postId);
  postIdRef.current = postId;

  const onFile = async (file: File) => {
    setUploadError(null);
    try {
      const { markdown: md } = await actions.uploadMedia(file, postId, {
        storage: access === "open" ? "r2_public" : "r2_paid",
      });
      setMarkdown((m) => `${m}${m.endsWith("\n") || m === "" ? "" : "\n"}${md}\n`);
      markDirty();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "upload_failed");
    }
  };

  const footer =
    saveState === "error"
      ? { text: "Not saved — retrying", cls: "text-destructive" }
      : savedAt !== null
        ? { text: `Saved · ${savedAt}`, cls: "text-muted-foreground" }
        : { text: "Not saved yet", cls: "text-muted-foreground" };

  const editorPane = (
    <div className="flex min-h-[60vh] flex-col">
      {kind === "article" && (
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
          placeholder="Title"
          className="mb-4 w-full border-0 bg-transparent font-serif text-3xl outline-none placeholder:text-muted-foreground"
        />
      )}
      <textarea
        aria-label="Post body"
        value={markdown}
        onChange={(e) => {
          setMarkdown(e.target.value);
          markDirty();
        }}
        placeholder="Write, or ask your agent to."
        className="min-h-[50vh] w-full flex-1 resize-none border-0 bg-transparent text-[1.125rem] leading-[1.6] outline-none placeholder:text-muted-foreground"
      />
    </div>
  );

  const previewPane = (
    <aside className="rounded-xl border border-border bg-card p-5 shadow-e2">
      <Preview html={html} />
    </aside>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-24 md:px-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Kind</span>
          <select
            aria-label="Post kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as PostKind);
              markDirty();
            }}
            className="rounded-md border border-border-strong bg-background px-2 py-1 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <div className="lg:hidden" role="tablist" aria-label="Editor panes">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={mobileTab === t}
              onClick={() => setMobileTab(t)}
              className={`rounded-md px-3 py-1 text-sm ${
                mobileTab === t ? "bg-accent" : "text-muted-foreground"
              }`}
            >
              {t === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_480px]">
        <div className={mobileTab === "write" ? "" : "hidden lg:block"}>{editorPane}</div>
        <div className={mobileTab === "preview" ? "" : "hidden lg:block"}>{previewPane}</div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 md:px-6">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*,audio/*"
            className="hidden"
            aria-label="Upload media"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f !== undefined) void onFile(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm"
          >
            Media
          </button>
          <div className="relative">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((o) => !o)}
              className="rounded-full"
            >
              <AccessBadge view={badgeFor(access, access === "open" ? null : priceUsd)} />
            </button>
            {pickerOpen && (
              <div className="absolute bottom-12 left-0 w-80 rounded-xl border border-border bg-popover p-3 shadow-e3">
                <ModePicker
                  value={access}
                  priceUsd={priceUsd}
                  licenseSpdx={licenseSpdx}
                  trainAi={trainAi}
                  aiUse={aiUse}
                  searchIndexable={searchIndexable}
                  published={published}
                  onClose={() => setPickerOpen(false)}
                  onChange={(n) => {
                    setAccess(n.access);
                    setPriceUsd(n.priceUsd);
                    setLicenseSpdx(n.licenseSpdx);
                    setTrainAi(n.trainAi);
                    setAiUse(n.aiUse);
                    setSearchIndexable(n.searchIndexable);
                    markDirty();
                  }}
                />
              </div>
            )}
          </div>
          <input
            aria-label="Tags"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              markDirty();
            }}
            placeholder="tags, comma-separated"
            className="hidden w-40 rounded-md border border-border-strong bg-background px-2 py-1 text-sm md:block"
          />
          <span className={`ml-auto text-xs ${footer.cls}`}>{footer.text}</span>
          {slug !== null && (
            <span className="hidden font-mono text-xs text-muted-foreground md:inline">
              /p/{slug}
              {contentHash !== null ? ` · ${contentHash.slice(0, 12)}` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => void onPublish()}
            disabled={publishing || published}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {published ? "Published" : publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>

      {(publishError !== null || uploadError !== null) && (
        <p role="alert" className="fixed bottom-16 left-4 text-sm text-destructive">
          {publishError ?? uploadError}
        </p>
      )}

      <GrantWarningDialog
        open={warnOpen}
        grantCount={grantCount}
        onCancel={() => {
          setWarnOpen(false);
          dirtyRef.current = false;
        }}
        onConfirm={() => {
          setWarnOpen(false);
          setWarned(true);
          void doSave();
        }}
      />
    </div>
  );
}
