// packages/muse-mixer/src/muse/bloom.ts
// In-package ScalableBloom over a Uint8Array with double hashing — the §9.16 safe
// fallback, chosen over bloom-filters@3.0.4 because it is pure, deterministic,
// testable in the replay harness, and puts no `reflect-metadata` at module scope.
// Serializes as base64 in viewer_seen_bloom.filter_json — the two serializations
// are NOT interchangeable; this is the format of record (open question 3).
//
// Serialization envelope (stable, versioned):
//   JSON.stringify({ v: 1, m: <bitLength>, k: <hashCount>, bits: <base64> })

const enc = new TextEncoder();

function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Two FNV-1a variants per §9.16; index i's probe is h1 + i·h2 (double hashing). */
function hashes(id: string, k: number, m: number): number[] {
  const bytes = enc.encode(id);
  const h1 = fnv1a(bytes, 0x811c9dc5);
  const h2 = fnv1a(bytes, 0x9e3779b9) || 1;
  const out = new Array<number>(k);
  for (let i = 0; i < k; i++) out[i] = (h1 + Math.imul(i, h2)) % m;
  return out;
}

export function bloomParams(capacity: number, errorRate: number): { m: number; k: number } {
  // m = ceil(-n·ln(p) / (ln 2)^2); k = round(m/n · ln 2)
  const m = Math.max(8, Math.ceil((-capacity * Math.log(errorRate)) / (Math.LN2 * Math.LN2)));
  const k = Math.max(1, Math.round((m / capacity) * Math.LN2));
  return { m, k };
}

export class SeenBloom {
  readonly m: number;
  readonly k: number;
  private readonly bits: Uint8Array;

  private constructor(m: number, k: number, bits: Uint8Array) {
    this.m = m;
    this.k = k;
    this.bits = bits;
  }

  static create(capacity: number, errorRate: number): SeenBloom {
    const { m, k } = bloomParams(capacity, errorRate);
    return new SeenBloom(m, k, new Uint8Array(Math.ceil(m / 8)));
  }

  static deserialize(json: unknown): SeenBloom | null {
    // Accepts the serialization string OR the already-parsed jsonb object —
    // Postgres hands us the object; the query field stores the string.
    let parsed: { v?: unknown; m?: unknown; k?: unknown; bits?: unknown };
    if (typeof json === "string") {
      try {
        parsed = JSON.parse(json) as typeof parsed;
      } catch {
        return null;
      }
    } else if (typeof json === "object" && json !== null) {
      parsed = json;
    } else {
      return null;
    }
    if (
      parsed.v !== 1 ||
      typeof parsed.m !== "number" ||
      typeof parsed.k !== "number" ||
      typeof parsed.bits !== "string"
    ) {
      return null;
    }
    const bin = atob(parsed.bits);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new SeenBloom(parsed.m, parsed.k, bytes);
  }

  serialize(): string {
    let bin = "";
    for (const byte of this.bits) bin += String.fromCharCode(byte);
    return JSON.stringify({ v: 1, m: this.m, k: this.k, bits: btoa(bin) });
  }

  has(id: string): boolean {
    for (const idx of hashes(id, this.k, this.m)) {
      if (((this.bits[idx >> 3] ?? 0) & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  add(id: string): void {
    for (const idx of hashes(id, this.k, this.m)) {
      const i8 = idx >> 3;
      this.bits[i8] = (this.bits[i8] ?? 0) | (1 << (idx & 7));
    }
  }
}
