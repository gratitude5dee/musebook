// apps/web/app/legal/[slug]/page.tsx — §15.9's legal surface. The MDX files
// under content/legal/ are the canonical text; this page reads the file the
// legal_documents seed hashes (CI asserts sha256 equality, so an edit without
// a version bump fails the build). subprocessors is generated from
// subprocessors.json instead — same route, different source.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LegalReviewRequired } from "@/components/legal/LegalReviewRequired";

const CONTENT_DIR = path.join(process.cwd(), "content", "legal");

interface DocMeta {
  slug: string;
  title: string;
  file: string;
}

// The route table §15.9 owns: 7 MDX documents plus generated subprocessors.
export const LEGAL_DOCS: DocMeta[] = [
  { slug: "terms", title: "Terms of Service", file: "terms.v1.mdx" },
  { slug: "privacy", title: "Privacy Policy", file: "privacy.v1.mdx" },
  { slug: "agent-data", title: "Agent Data Disclosure", file: "agent-data.v1.mdx" },
  { slug: "cookies", title: "Cookie and Storage Inventory", file: "cookies.v1.mdx" },
  { slug: "acceptable-use", title: "Acceptable Use", file: "acceptable-use.v1.mdx" },
  { slug: "dmca", title: "DMCA Notice and Takedown", file: "dmca.v1.mdx" },
  { slug: "security", title: "Vulnerability Disclosure", file: "security.v1.mdx" },
];

interface Subprocessor {
  name: string;
  purpose: string;
  location: string;
  data_classes: string[];
}

async function loadDoc(slug: string): Promise<{ title: string; body: string } | null> {
  const meta = LEGAL_DOCS.find((d) => d.slug === slug);
  if (meta === undefined) return null;
  try {
    const raw = await readFile(path.join(CONTENT_DIR, meta.file), "utf8");
    // Strip the front-matter block; title comes from the registry above.
    const body = raw.replace(/^---[\s\S]*?---\s*/, "");
    return { title: meta.title, body };
  } catch {
    return null;
  }
}

async function loadSubprocessors(): Promise<Subprocessor[]> {
  try {
    const raw = await readFile(path.join(CONTENT_DIR, "subprocessors.json"), "utf8");
    return (JSON.parse(raw) as { subprocessors: Subprocessor[] }).subprocessors;
  } catch {
    return [];
  }
}

export function generateStaticParams() {
  return [...LEGAL_DOCS.map((d) => ({ slug: d.slug })), { slug: "subprocessors" }];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta =
    LEGAL_DOCS.find((d) => d.slug === slug)?.title ??
    (slug === "subprocessors" ? "Sub-processors" : null);
  return { title: meta ?? "Legal" };
}

export default async function LegalDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (slug === "subprocessors") {
    const rows = await loadSubprocessors();
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <LegalReviewRequired />
        <h1 className="mb-6 text-2xl font-semibold">Sub-processors (§15.14)</h1>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-4">Processor</th>
              <th className="py-2 pr-4">Purpose</th>
              <th className="py-2 pr-4">Location</th>
              <th className="py-2">Data classes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.name} className="border-b align-top">
                <td className="py-2 pr-4 font-medium">{p.name}</td>
                <td className="py-2 pr-4">{p.purpose}</td>
                <td className="py-2 pr-4">{p.location}</td>
                <td className="py-2">{p.data_classes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    );
  }

  const doc = await loadDoc(slug);
  if (doc === null) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <LegalReviewRequired />
      <article className="prose dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
      </article>
    </main>
  );
}
