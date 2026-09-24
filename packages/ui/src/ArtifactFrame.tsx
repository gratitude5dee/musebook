// packages/ui/src/ArtifactFrame.tsx — §2.8's iframe element copied into JSX.
// §2.8 is canonical for this element and for every artifact response header;
// re-copy it if §2.8 changes, never re-derive it (§11.14).
export function ArtifactFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      src={src}
      // NEVER add allow-same-origin. See §11.14. Enforced by test + ESLint rule.
      sandbox="allow-scripts allow-pointer-lock"
      referrerPolicy="no-referrer"
      allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
      // React 19 passes unknown lowercase attributes through, so the bare
      // `credentialless` attribute reaches the DOM. Section 2.8 flags its
      // cross-browser support as UNVERIFIED and additive: drop it if it causes
      // problems, never the sandbox attribute.
      {...{ credentialless: 'true' }}
      loading="lazy"
      title={title}
    />
  );
}
