// apps/edge/src/telemetry/privacy.ts — §13.9.1 + §13.9.2, verbatim.
/** A request that asserts either signal gets no behavioural record in EITHER
 *  store. Both are honoured identically; GPC is a legal assertion in some US
 *  states and DNT is not, but the engineering response is the same and a
 *  two-tier response is a bug factory. */
export function behaviouralOptOut(headers: Headers): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

import { createHash, createHmac } from "node:crypto"; // supported on workerd, no flag
import { getDailySalt } from "./salt.js";

export type Plane = "human" | "agent";

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const V6_CHARS = /^[0-9a-fA-F:.%]+$/;

/** IPv4 -> /24, IPv6 -> /48. Returns null for anything unparseable. */
export function truncateIp(ip: string): string | null {
  const m = V4.exec(ip);
  if (m !== null) {
    const o = [m[1], m[2], m[3], m[4]].map(Number);
    if (o.some((n) => n < 0 || n > 255)) return null;
    return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  }
  if (ip.includes(":") && V6_CHARS.test(ip)) {
    const groups = expandIPv6(ip);
    if (groups === null) return null;
    return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
  }
  return null;
}

function expandIPv6(input: string): string[] | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  // ::ffff:203.0.113.9 -> ::ffff:cb00:7109
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (v4 !== null && v4.index !== undefined) {
    const o = (v4[1] as string).split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = o as [number, number, number, number];
    ip =
      ip.slice(0, v4.index) +
      (((a << 8) | b) >>> 0).toString(16) +
      ":" +
      (((c << 8) | d) >>> 0).toString(16);
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const pad = (g: string): string => g.padStart(4, "0").toLowerCase();

  if (halves.length === 1) {
    const parts = (halves[0] as string).split(":");
    return parts.length === 8 ? parts.map(pad) : null;
  }
  const left = halves[0] as string;
  const right = halves[1] as string;
  const head = left === "" ? [] : left.split(":");
  const tail = right === "" ? [] : right.split(":");
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<string>(fill).fill("0"), ...tail].map(pad);
}

/** sha256( HMAC(dailySalt, plane) || '|' || subnet ), first 128 bits as hex.
 *  The per-plane HMAC is what makes a human row and an agent row from the same
 *  subnet unjoinable on the same day (§13.6.1). */
export async function hashClientIp(
  request: Request,
  env: Env,
  plane: Plane,
): Promise<string | null> {
  const subnet = truncateIp(request.headers.get("CF-Connecting-IP") ?? "");
  if (subnet === null) return null;

  const salt = await getDailySalt(env); // Buffer, 32 bytes
  const planeKey = createHmac("sha256", salt).update(plane).digest();
  return createHash("sha256")
    .update(planeKey)
    .update("|")
    .update(subnet)
    .digest("hex")
    .slice(0, 32);
}
