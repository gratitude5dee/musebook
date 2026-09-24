// M16 gate fixture — must produce exactly one musebook/no-same-origin-artifact-sandbox problem.
export const Frame = ({ html }: { html: string }) => <iframe srcDoc={html} />;
