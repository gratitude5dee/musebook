// Minimal structural JWK type — the DOM/workerd JsonWebKey global exists in the
// Worker libs but not in this package's tsconfig lib set.
export interface JsonWebKey {
  kty: string;
  crv?: string;
  alg?: string;
  kid?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  k?: string;
  key_ops?: string[];
  ext?: boolean;
  [k: string]: unknown;
}
