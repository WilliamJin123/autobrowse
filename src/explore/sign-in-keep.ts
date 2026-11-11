/**
 * A sign-in a person types by hand, kept sealed (WA-1307, designs/2026-10-05-teach-mode.md,
 * "Keep a sign-in a person types"). The observer's typed values are held here in memory only:
 * never the journal, the trace, an answer or a log. Explore asks once; a yes stores it.
 */
import type { CredentialStore } from "credvault";
import { registrable } from "../auth/guard.js";
import type { LocatorHints } from "../recorder/types.js";

type Field = Pick<LocatorHints, "name" | "placeholder" | "id" | "inputType">;

const PASSWORD_WORD = /pass(?:word|wd)|\bpwd\b/i;
// one-time codes look like secrets too; not a password
const CODE_WORD = /\b(?:otp|2fa|mfa|totp|code|pin)\b|one.?time|verification/i;
const NAME_WORD = /user|e-?mail|login|log.?in|phone|mobile|account|handle|identifier|sign.?in/i;

const words = (t: Field) => [t.name, t.placeholder, t.id].filter((h): h is string => !!h);

export const isPasswordField = (t: Field): boolean =>
  (t.inputType === "password" || words(t).some((w) => PASSWORD_WORD.test(w))) &&
  !words(t).some((w) => CODE_WORD.test(w));

export const isNameField = (t: Field): boolean => {
  if (isPasswordField(t)) return false;
  if (t.inputType === "email") return true;
  if (t.inputType && !["text", "tel", "search"].includes(t.inputType)) return false;
  return words(t).some((w) => NAME_WORD.test(w)) && !words(t).some((w) => CODE_WORD.test(w));
};

/** The sign-in name the page shows, read in code when the site filled it (no typing). */
export const USERNAME_READ = `(() => {
  const sel = 'input[autocomplete~="username"],input[type="email"],input[name*="user" i],input[name*="email" i],input[name*="login" i],input[id*="user" i],input[id*="email" i]';
  for (const e of document.querySelectorAll(sel)) if (e.type !== 'password' && e.value) return e.value;
  return null;
})()`;

export interface HeldSignIn {
  /** The registrable host it was typed on. */
  host: string;
  username: string | null;
  password: string;
}

/** One session's held sign-ins. Nothing here is written anywhere. */
export function signInHolder() {
  /** Per host: the last name typed, so a two-page sign-in (name, then password) pairs. */
  const names = new Map<string, string>();
  let held: HeldSignIn | null = null;
  let armed = false;
  /** Hosts a person said "not now" to: not asked again this session. */
  const declined = new Set<string>();
  /** No one to ask yet (overlay off): kept for the session's end. One per host. */
  const parked = new Map<string, HeldSignIn>();
  const hostOf = (url: string) => (URL.canParse(url) ? registrable(new URL(url).hostname) : "");
  return {
    /** A typed value; true when a password came with no name to pair (read the page for one). */
    typed(t: Field, value: string, url: string): boolean {
      const host = hostOf(url);
      if (!host || !value) return false;
      if (isPasswordField(t)) {
        if (declined.has(host)) return false;
        // A new try (a wrong password retyped) replaces the held one.
        held = { host, username: names.get(host) ?? null, password: value };
        armed = false;
        return held.username === null;
      }
      if (isNameField(t)) {
        names.set(host, value.trim());
        if (held?.host === host) held.username = value.trim();
      }
      return false;
    },
    /** The page's own name field, read once in code. */
    named(url: string, username: string | null): void {
      if (held && held.host === hostOf(url) && !held.username && username?.trim())
        held.username = username.trim();
    },
    /** A submit, Enter, a click or a load after the password: check once the page settles. */
    acted(): boolean {
      if (!held || armed) return false;
      armed = true;
      return true;
    },
    /** The armed sign-in, taken out; null when there is none or it has no name. */
    take(): HeldSignIn | null {
      if (!held || !armed || !held.username) return null;
      const h = held;
      held = null;
      armed = false;
      return h;
    },
    /** The form is still there (a wrong password): wait for the next try. */
    disarm(): void {
      armed = false;
    },
    decline(host: string): void {
      declined.add(host);
      parked.delete(host);
    },
    park(h: HeldSignIn): void {
      parked.set(h.host, h);
    },
    parked(): HeldSignIn[] {
      return [...parked.values()];
    },
    unpark(host: string): void {
      parked.delete(host);
    },
  };
}

export type SignInHolder = ReturnType<typeof signInHolder>;

/** The credential's site: the registrable host's name (`accounts.google.com` → `google`). */
export const siteFor = (host: string): string => host.split(".")[0]?.toLowerCase() || host;

const labelOf = (username: string): string => {
  const u = username.trim().toLowerCase();
  const local = u.includes("@") ? u.slice(0, u.indexOf("@")) : u;
  return local.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type KeepStore = Pick<CredentialStore, "get" | "put"> &
  Partial<Pick<CredentialStore, "list">>;

export interface KeepPlan {
  /** The stored name it goes (or already is) under. */
  name: string;
  /**
   * `same`: stored already, nothing to write. `new`: a new name. `added`: the account had no
   * password (a provider's button), it joins. `dated`: the stored password differs; never overwritten.
   */
  outcome: "same" | "new" | "added" | "dated";
}

/** Where a held sign-in would go; writes nothing. */
export async function planKeep(
  store: KeepStore,
  site: string,
  h: HeldSignIn & { username: string },
  today: string,
): Promise<KeepPlan> {
  const all = (await store.list?.().catch(() => [] as string[])) ?? [];
  const mine = all.filter((n) => n === site || n.startsWith(`${site}@`));
  const label = `${site}@${labelOf(h.username)}`;
  if (!mine.includes(label)) mine.push(label);
  for (const name of mine) {
    const c = await store.get(name).catch(() => null);
    if (!c || !sameName(c.username, h.username)) continue;
    if (!c.password) return { name, outcome: "added" };
    if (c.password === h.password) return { name, outcome: "same" };
    let dated = `${name}-${today}`;
    for (let i = 2; all.includes(dated) || (await store.get(dated).catch(() => null)); i++)
      dated = `${name}-${today}-${i}`;
    return { name: dated, outcome: "dated" };
  }
  // The label is another account's (same local part, other domain): the whole name, made safe.
  const taken = await store.get(label).catch(() => null);
  const name = taken
    ? `${site}@${h.username
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")}`
    : label;
  return { name, outcome: "new" };
}

/** Writes what `planKeep` said; an `added` keeps the account's other ways in. */
export async function applyKeep(
  store: KeepStore,
  plan: KeepPlan,
  h: HeldSignIn & { username: string },
): Promise<void> {
  if (plan.outcome === "same") return;
  const had = plan.outcome === "added" ? await store.get(plan.name) : null;
  await store.put(plan.name, {
    ...(had ?? {}),
    username: h.username,
    password: h.password,
  } as Parameters<CredentialStore["put"]>[1]);
}

/** The overlay's question, one line. */
export const askLine = (plan: KeepPlan): string =>
  plan.outcome === "dated"
    ? `Keep this sign-in as ${plan.name}? ${plan.name.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, "")} has another password; it stays.`
    : `Keep this sign-in for ${plan.name}?`;
