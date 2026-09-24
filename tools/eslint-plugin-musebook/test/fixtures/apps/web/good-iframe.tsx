// M16 gate control — the §2.8 iframe shape; this file must stay clean.
export const Frame = ({ src }: { src: string }) => (
  <iframe src={src} sandbox="allow-scripts allow-pointer-lock" referrerPolicy="no-referrer" />
);
