// apps/web/app/(marketing)/_components/FaqAccordion.tsx — §14.3 S11.
// details/summary (no client JS) + FAQPage JSON-LD, aria-expanded wired
// through the open attribute's native behaviour.
export interface FaqItem {
  q: string;
  a: string;
}

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a },
    })),
  };
  return (
    <div className="mx-auto max-w-[720px] divide-y divide-border">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {items.map((i, n) => (
        <details key={i.q} className="group py-4" id={`faq-${n}`}>
          <summary
            aria-controls={`faq-a-${n}`}
            className="flex cursor-pointer list-none items-center justify-between text-left text-base font-medium [&::-webkit-details-marker]:hidden"
          >
            {i.q}
            <span aria-hidden className="ml-4 text-muted-foreground group-open:rotate-45">
              +
            </span>
          </summary>
          <p id={`faq-a-${n}`} className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {i.a}
          </p>
        </details>
      ))}
    </div>
  );
}
