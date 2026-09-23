// packages/distributor/src/validate.ts — §12.3.5 verbatim.
// Pure function. No network, no clock, no database, no environment access.
// A model's output is never trusted; it is only ever a proposal this admits.
import { countEffective, countLength, type CountMethod } from "./count";
import type { PlatformConstraint } from "./constraints";

export type Severity = "error" | "warning";

export interface Check {
  readonly id: string;
  readonly ok: boolean;
  readonly severity: Severity;
  readonly detail: string;
}

export interface ValidatorReport {
  readonly platform: string;
  readonly ok: boolean; // no `error`-severity check failed
  readonly checks: readonly Check[];
  readonly failures: readonly string[]; // detail strings of failed errors
}

export interface CandidateMedia {
  readonly url: string;
  readonly contentType: string;
  readonly alt: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
}

export interface VariantCandidate {
  readonly body: string;
  readonly threadParts: readonly string[];
  readonly media: readonly CandidateMedia[];
  readonly title: string | null;
  readonly canonicalUrl: string;
}

const POSTIZ_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4"];
const HTML_ALLOWED = /^(?:[^<>]|<\/?(?:p|br|b|i|u|a|ul|ol|li|strong|em|h[1-3])(?:\s[^<>]*)?\/?>)*$/;

function ok(id: string, detail: string): Check {
  return { id, ok: true, severity: "error", detail };
}
function err(id: string, detail: string): Check {
  return { id, ok: false, severity: "error", detail };
}
function warn(id: string, okFlag: boolean, detail: string): Check {
  return { id, ok: okFlag, severity: "warning", detail };
}

export function validateVariant(c: VariantCandidate, p: PlatformConstraint): ValidatorReport {
  const checks: Check[] = [];
  const method: CountMethod = p.countMethod;
  const images = c.media.filter((m) => m.contentType.startsWith("image/"));
  const videos = c.media.filter((m) => m.contentType.startsWith("video/"));

  // --- 1. length, per part, using the platform's own counting rule
  const parts = [c.body, ...c.threadParts];
  parts.forEach((part, i) => {
    const n = countEffective(method, part, p.urlCountsAsChars);
    checks.push(
      n <= p.maxChars
        ? ok(`length.part.${i}`, `part ${i}: ${n}/${p.maxChars}`)
        : err(`length.part.${i}`, `part ${i} is ${n} of a maximum ${p.maxChars}`),
    );
  });

  // --- 2. the SECOND ceiling: what the Postiz sidecar itself will accept
  if (p.postizMaxChars !== null) {
    parts.forEach((part, i) => {
      const n = p.slug === "x" || p.slug === "threads" ? countLength(method, part) : part.length; // Postiz counts everything else in UTF-16
      checks.push(
        n <= p.postizMaxChars!
          ? ok(`postiz.length.part.${i}`, `postiz: ${n}/${p.postizMaxChars}`)
          : err(
              `postiz.length.part.${i}`,
              `part ${i} is ${n} by the sidecar's counting rule, over its ${p.postizMaxChars} limit`,
            ),
      );
    });
  }

  // --- 3. threading
  if (c.threadParts.length > 0 && !p.supportsThreads) {
    checks.push(err("thread.unsupported", `${p.slug} does not support threads`));
  } else if (p.maxThreadParts !== null && parts.length > p.maxThreadParts) {
    checks.push(err("thread.too_many", `${parts.length} parts, maximum ${p.maxThreadParts}`));
  } else {
    checks.push(ok("thread", `${parts.length} part(s)`));
  }

  // --- 4. media counts
  checks.push(
    c.media.length >= p.minMedia
      ? ok("media.min", `${c.media.length} >= ${p.minMedia}`)
      : err("media.min", `${p.slug} requires at least ${p.minMedia} attachment(s)`),
  );
  checks.push(
    images.length <= p.maxImages
      ? ok("media.images", `${images.length}/${p.maxImages} images`)
      : err("media.images", `${images.length} images, maximum ${p.maxImages}`),
  );
  checks.push(
    videos.length <= p.maxVideos
      ? ok("media.videos", `${videos.length}/${p.maxVideos} videos`)
      : err("media.videos", `${videos.length} videos, maximum ${p.maxVideos}`),
  );
  if (videos.length > 0 && images.length > 0 && p.mediaRules.images_or_one_video === true) {
    checks.push(err("media.mixed", `${p.slug} accepts images OR one video, never both`));
  }
  if (p.mediaRules.images_only === true && videos.length > 0) {
    checks.push(err("media.images_only", `${p.slug} rejects video`));
  }
  if (p.mediaRules.must_be_mp4 === true && !videos.every((v) => v.contentType === "video/mp4")) {
    checks.push(err("media.mp4", `${p.slug} requires an mp4`));
  }
  if (p.mediaRules.video_requires_thumbnail === true) {
    const missing = videos.filter((v) => v.thumbnailUrl === null).length;
    checks.push(
      missing === 0
        ? ok("media.thumbnail", "every video has a thumbnail")
        : err("media.thumbnail", `${missing} video(s) without a thumbnail`),
    );
  }
  if (
    typeof p.mediaRules.video_requires_exactly_two_items === "boolean" &&
    p.mediaRules.video_requires_exactly_two_items &&
    videos.length > 0
  ) {
    checks.push(
      c.media.length === 2
        ? ok("media.video_pair", "video + cover")
        : err(
            "media.video_pair",
            `${p.slug} needs exactly 2 items with a video (video + cover image)`,
          ),
    );
  }
  if (p.mediaRules.multi_image_identical_dimensions === true && images.length > 1) {
    const first = images[0]!;
    const same = images.every((m) => m.widthPx === first.widthPx && m.heightPx === first.heightPx);
    checks.push(
      same
        ? ok("media.identical_dims", "all images share dimensions")
        : err(
            "media.identical_dims",
            `${p.slug} requires identical width AND height across images`,
          ),
    );
  }
  if (typeof p.mediaRules.image_short_side_max_px === "number") {
    const cap = p.mediaRules.image_short_side_max_px;
    const bad = images.filter(
      (m) => m.widthPx !== null && m.heightPx !== null && Math.min(m.widthPx, m.heightPx) > cap,
    ).length;
    checks.push(
      bad === 0
        ? ok("media.short_side", `short side <= ${cap}px`)
        : err("media.short_side", `${bad} image(s) exceed ${cap}px on the shorter side`),
    );
  }

  // --- 4b. THE BUCKET RULE (12.2.5). Every syndicated asset must live in
  // musebook-public and be addressed on the CDN host. musebook-paid has no
  // public URL at all, so a paid key here is either a bug or a leak; either
  // way it fails before any outbound request is made.
  const offCdn = c.media.filter((m) => {
    try {
      return new URL(m.url).host !== p.cdnHost;
    } catch {
      return true;
    }
  });
  checks.push(
    offCdn.length === 0
      ? ok("media.public_origin", `all media on ${p.cdnHost}`)
      : err(
          "media.public_origin",
          `${offCdn.length} asset(s) are not on ${p.cdnHost}; only musebook-public media may be syndicated`,
        ),
  );

  // --- 5. alt text
  if (p.requiresAltText) {
    const missing = images.filter((m) => m.alt === null || m.alt.trim() === "").length;
    checks.push(
      missing === 0
        ? ok("alt.present", "all images have alt text")
        : err("alt.present", `${missing} image(s) missing required alt text`),
    );
  }
  if (p.maxAltChars !== null) {
    const over = c.media.filter((m) => (m.alt?.length ?? 0) > p.maxAltChars!).length;
    checks.push(
      over === 0
        ? ok("alt.length", `alt <= ${p.maxAltChars}`)
        : err("alt.length", `${over} alt text(s) over ${p.maxAltChars} characters`),
    );
  }

  // --- 6. title
  if (p.maxTitleChars === null) {
    checks.push(
      c.title === null
        ? ok("title.absent", "no title expected")
        : err("title.absent", `${p.slug} takes no title`),
    );
  } else {
    const t = c.title ?? "";
    checks.push(
      t.length >= 2 && t.length <= p.maxTitleChars
        ? ok("title.length", `${t.length}/${p.maxTitleChars}`)
        : err("title.length", `title must be 2..${p.maxTitleChars} characters, got ${t.length}`),
    );
  }

  // --- 7. editor dialect
  if (p.editor === "html") {
    checks.push(
      HTML_ALLOWED.test(c.body)
        ? ok("editor.html", "allowed tags only")
        : err("editor.html", "body contains HTML outside the allowed tag set"),
    );
  } else if (p.editor === "normal") {
    checks.push(
      /<[a-z][^>]*>/i.test(c.body)
        ? err("editor.plain", `${p.slug} takes plain text; body contains markup`)
        : ok("editor.plain", "plain text"),
    );
  } else {
    checks.push(ok("editor", p.editor));
  }

  // --- 8. media the sidecar will refuse outright
  const badExt = c.media.filter(
    (m) => !POSTIZ_EXTENSIONS.some((e) => m.url.split("?")[0]!.toLowerCase().endsWith(e)),
  );
  checks.push(
    badExt.length === 0
      ? ok("media.extension", "all media end in an accepted extension")
      : err(
          "media.extension",
          `${badExt.length} asset(s) are not .png/.jpg/.jpeg/.gif/.webp/.mp4 — render an mp4 or link out`,
        ),
  );

  // --- 9. the canonical URL must survive
  checks.push(
    parts.some((part) => part.includes(c.canonicalUrl))
      ? ok("link.canonical", "canonical URL present")
      : err("link.canonical", "the canonical URL was dropped"),
  );

  // --- 10. ADVISORY ONLY: unverified numbers never block a send
  if (p.maxVideoSeconds !== null) {
    const over = videos.filter(
      (v) => v.durationSeconds !== null && v.durationSeconds > p.maxVideoSeconds!,
    ).length;
    checks.push(
      warn(
        "media.duration",
        over === 0,
        `video duration limit ${p.maxVideoSeconds}s is UNVERIFIED; ${over} clip(s) exceed it`,
      ),
    );
  }

  const failures = checks.filter((k) => !k.ok && k.severity === "error").map((k) => k.detail);
  return { platform: p.slug, ok: failures.length === 0, checks, failures };
}
