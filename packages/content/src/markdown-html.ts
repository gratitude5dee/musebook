// packages/content/src/markdown-html.ts — the canonical-subset markdown → HTML
// renderer.
//
// No markdown dependency is catalogued in §3.2, and the composer's live
// preview must render through the EXACT function the Worker uses (§14.4.3) —
// so this is a small, deterministic renderer over the block set the
// canonical producer emits: ATX headings, fenced code, blockquotes,
// `-`/`*`/`+` and `N.`/`N)` lists nested by indentation, `---`/`***`/`___`
// rules, and paragraphs; inline: code spans, `**`/`__` strong, `*`/`_`
// emphasis, `~~` delete, `[text](href)` and `![alt](src)`.
//
// Output must be byte-deterministic (the ETag and the golden fixtures pin
// rendered bytes), so every rule here is a local, order-stable transform —
// no heuristics that could wobble between runs.

const indentOf = (line: string): number => {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
};

const FENCE_OPEN = /^ {0,3}(```|~~~)\s*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

const isUnordered = (marker: string): boolean => /^[-*+]$/.test(marker);
const markerOf = (line: string): { indent: number; marker: string; text: string } | null => {
  const m = ITEM.exec(line);
  if (m === null) return null;
  return { indent: m[1]!.length, marker: m[2]!, text: m[3]! };
};
const isItemLine = (line: string): boolean => markerOf(line) !== null;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#|\.)/i;
const safeHref = (raw: string): string | null => {
  const unescaped = raw.replace(/&quot;/g, '"');
  return SAFE_HREF.test(unescaped) ? raw : null;
};

/** Inline rendering: the text is split on backticks first — odd segments
 * are code spans emitted escaped, even segments are prose — so no later
 * transform can ever reinterpret code contents or the entities they become.
 * A trailing unpaired backtick is literal, as in CommonMark. */
function inlineProse(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const href = safeHref(src);
    return href === null ? `![${alt}](${src})` : `<img src="${href}" alt="${alt}">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = safeHref(href);
    return safe === null ? `[${label}](${href})` : `<a href="${safe}">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^\w])_([^_]+)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

function inline(text: string): string {
  const segments = text.split("`");
  // An even segment count means the last backtick never closed.
  const limit = segments.length % 2 === 0 ? segments.length - 1 : segments.length;
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (i >= limit) {
      out.push(inlineProse(`\`${seg}`));
    } else if (i % 2 === 1) {
      out.push(`<code>${escapeHtml(seg)}</code>`);
    } else {
      out.push(inlineProse(seg));
    }
  }
  return out.join("");
}

interface BlockLines {
  lines: string[];
  next: number;
}

/** Renders one list starting at `lines[start]` and returns its HTML plus the
 * index of the first line after it. Items at the first marker's indent open
 * items; deeper indents are item continuations (a nested list inside them
 * is re-rendered by recursion); anything shallower or a blank line ends it. */
function renderList(lines: string[], start: number): BlockLines {
  const first = markerOf(lines[start]!)!;
  const ordered = !isUnordered(first.marker);
  const tag = ordered ? "ol" : "ul";
  const items: string[][] = [];
  let cur: string[] = [];
  let i = start;

  const startItem = (): void => {
    if (cur.length > 0) items.push(cur);
    cur = [];
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    const m = markerOf(line);
    if (m !== null && m.indent === first.indent) {
      startItem();
      // Strip the marker itself: the item's first line is its text. The
      // rest of the item's lines are collected below with their indent
      // rebased so nested structure re-renders by recursion.
      cur.push(m.text);
      continue;
    }
    if (indentOf(line) > first.indent) {
      cur.push(line.slice(Math.min(first.indent + 2, indentOf(line))));
      continue;
    }
    break;
  }
  startItem();

  const body = items
    .map((itemLines) =>
      itemLines.length === 1 && itemLines[0]!.trim() !== "" && !isItemLine(itemLines[0]!)
        ? `<li>${inline(itemLines[0]!.trim())}</li>`
        : `<li>${renderBlocks(itemLines)}</li>`,
    )
    .join("\n");
  return { lines: [`<${tag}>\n${body}\n</${tag}>`], next: i };
}

/**
 * Renders a flat line list to an HTML string. Each item produced by a
 * renderer is already complete markup; joins are stable.
 */
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      const lang = fence[2]!.trim().split(/\s+/)[0] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}`).test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      i += 1; // consume the closing fence
      const cls = lang === "" ? "" : ` class="language-${escapeHtml(lang)}"`;
      out.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (q === null) break;
        inner.push(q[1]!);
        i += 1;
      }
      out.push(`<blockquote>\n${renderBlocks(inner)}\n</blockquote>`);
      continue;
    }

    if (isItemLine(line) && indentOf(line) < 4) {
      const list = renderList(lines, i);
      out.push(list.lines.join("\n"));
      i = list.next;
      continue;
    }

    // Paragraph: gather until a blank line or a new block opener.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "") break;
      if (
        para.length > 0 &&
        (FENCE_OPEN.test(l) ||
          HEADING.test(l) ||
          HR.test(l) ||
          QUOTE.test(l) ||
          (isItemLine(l) && indentOf(l) < 4))
      ) {
        break;
      }
      para.push(l);
      i += 1;
    }
    out.push(`<p>${para.map((l) => inline(l.trim())).join("\n")}</p>`);
  }
  return out.join("\n");
}

export function markdownToHtml(markdown: string): string {
  const body = markdownToBlocks(markdown);
  return renderBlocks(body);
}

/** Splits input into lines and drops a leading front-matter block if present —
 * the `.md` twin prepends it; the HTML view renders only the body. */
function markdownToBlocks(markdown: string): string[] {
  let src = markdown;
  if (src.startsWith("---\n")) {
    const end = src.indexOf("\n---\n", 4);
    if (end !== -1) src = src.slice(end + 5);
  }
  return src.split("\n");
}
