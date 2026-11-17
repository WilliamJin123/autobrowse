// Copied from wren packages/runtime/src/pg/ids.ts at dc80ecd28, unchanged: edit there, then copy (designs/2026-11-16-local-runner.md).
/** Invocation and awakeable ids, and the per-invocation seeded random source. */
import { createHash, randomBytes } from "node:crypto";

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
const b32 = (bytes: Uint8Array, n: number) => {
  let out = "";
  for (let i = 0; i < n; i++) out += B32[(bytes[i] as number) & 31];
  return out;
};

/** `inv_` + 26 chars: Restate's prefix, so `InvocationIdParser` and the admin tools accept it. */
export const newInvocationId = () => `inv_${b32(randomBytes(26), 26)}`;

/** A child's id is a function of its parent and seq: a replayed call or send makes the same row. */
export const childId = (parent: string, seq: number) =>
  `inv_${b32(createHash("sha256").update(`${parent}/${seq}`).digest(), 26)}`;

export const awakeableId = (invocation: string, seq: number) => `awk.${invocation}.${seq}`;

export function parseAwakeableId(id: string): { invocation: string; seq: number } | undefined {
  const m = /^awk\.(inv_[0-9a-z]+)\.(\d+)$/.exec(id);
  return m ? { invocation: m[1] as string, seq: Number(m[2]) } : undefined;
}

/** xoshiro256** seeded from the invocation id: same id, same sequence, on every replay. */
export class Rand {
  private s: BigUint64Array;
  constructor(seed: string) {
    const h = createHash("sha256").update(seed).digest();
    this.s = new BigUint64Array(4);
    for (let i = 0; i < 4; i++) this.s[i] = h.readBigUInt64LE(i * 8);
  }
  private next(): bigint {
    const s = this.s;
    const M = 0xffffffffffffffffn;
    const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & M;
    const r = (rotl(((s[1] as bigint) * 5n) & M, 7n) * 9n) & M;
    const t = ((s[1] as bigint) << 17n) & M;
    s[2] = (s[2] as bigint) ^ (s[0] as bigint);
    s[3] = (s[3] as bigint) ^ (s[1] as bigint);
    s[1] = (s[1] as bigint) ^ (s[2] as bigint);
    s[0] = (s[0] as bigint) ^ (s[3] as bigint);
    s[2] = (s[2] as bigint) ^ t;
    s[3] = rotl(s[3] as bigint, 45n);
    return r;
  }
  random(): number {
    return Number(this.next() >> 11n) / 2 ** 53;
  }
  uuidv4(): string {
    const a = this.next();
    const b = this.next();
    const hex = (a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0")).split("");
    hex[12] = "4";
    hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
