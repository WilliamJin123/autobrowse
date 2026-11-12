/**
 * A sign-in for a site with no login spec (WA-1349; designs/2026-11-12-agent-browser-audit.md,
 * row 6): the stored name and password go into the boxes the page shows, then submit.
 * Typed through the signed-in context's guarded page, so the password lands only on the
 * credential's own hosts (its url, else the site's word in the host). The field-swap guard
 * in the hands holds for both boxes. One try: a form that comes back is a failure.
 */
import type { Credential } from "credvault";
import type { FlowPage } from "../browser/flow-api.js";
import { isNameField, isPasswordField } from "../explore/sign-in-keep.js";
import {
  LoginFailed,
  passwordOf,
  personStep,
  type SignInContext,
  type SiteLogin,
} from "./login.js";

/** One visible input on the page, as the field words read it. */
export interface PageField {
  i: number;
  name: string | null;
  placeholder: string | null;
  id: string | null;
  inputType: string;
  autocomplete: string;
  /** Index of its form on the page; -1 outside one. */
  form: number;
}

const MARK = "data-ab-signin";
const at = (i: number | string) => ({ css: `[${MARK}="${i}"]` });

/** Marks each visible, editable input of the main frame by index; returns their words. */
const FIELDS_JS = `(() => {
  const M = ${JSON.stringify(MARK)};
  for (const e of document.querySelectorAll('[' + M + ']')) e.removeAttribute(M);
  const shown = (e) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const forms = [...document.forms];
  const out = [];
  for (const e of document.querySelectorAll('input')) {
    if (e.disabled || e.readOnly || ['hidden','submit','button','checkbox','radio','file','image','reset'].includes(e.type) || !shown(e)) continue;
    const i = out.length;
    e.setAttribute(M, String(i));
    out.push({ i, name: e.name || null, placeholder: e.placeholder || null, id: e.id || null,
      inputType: e.type, autocomplete: (e.getAttribute('autocomplete') || '').toLowerCase(),
      form: e.form ? forms.indexOf(e.form) : -1 });
  }
  return out;
})()`;

/** Marks the submit control of field `i`'s form (`${MARK}="submit"`); false: none shows. */
const SUBMIT_JS = (i: number) => `(() => {
  const M = ${JSON.stringify(MARK)};
  const f = document.querySelector('[' + M + '="${i}"]')?.form;
  if (!f) return false;
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const b = [...f.querySelectorAll('button[type=submit],input[type=submit],button:not([type])')].find(shown);
  if (!b) return false;
  b.setAttribute(M, 'submit');
  return true;
})()`;

const ac = (f: PageField) => f.autocomplete.split(/\s+/);
const CODE_AC = "one-time-code";

/** The sign-in boxes among a page's fields, or why this is not a sign-in form. */
export function signInFields(
  fields: readonly PageField[],
):
  | { name: PageField | null; password: PageField | null; code: PageField | null }
  | { not: string } {
  const code = fields.find((f) => ac(f).includes(CODE_AC)) ?? null;
  const passwords = fields.filter(
    (f) =>
      ac(f).includes("current-password") ||
      ac(f).includes("new-password") ||
      (isPasswordField(f) && !ac(f).includes(CODE_AC)),
  );
  // two boxes or a new-password box: a sign-up or a password change, never a sign-in
  if (passwords.length > 1 || passwords.some((f) => ac(f).includes("new-password")))
    return { not: "the page asks for a new password (a sign-up or a password change)" };
  const password = passwords[0] ?? null;
  const names = fields.filter(
    (f) =>
      f !== password &&
      f !== code &&
      (ac(f).includes("username") || ac(f).includes("email") || isNameField(f)),
  );
  // the name in the password's own form, else the first before it
  const name =
    (password
      ? (names.find((f) => f.form === password.form && f.form >= 0) ??
        names.filter((f) => f.i < password.i).at(-1))
      : names[0]) ?? null;
  return { name, password, code };
}

/** A page whose address says it is a sign-in: a name box alone counts only here. */
const SIGN_IN_URL = /log[-_]?in|sign[-_]?in|signon|auth|session|account/i;

async function fieldsOf(fp: FlowPage): Promise<PageField[]> {
  return fp.page.evaluate<PageField[]>(FIELDS_JS).catch(() => []);
}

async function submit(fp: FlowPage, from: PageField, goal: string): Promise<void> {
  if (await fp.page.evaluate<boolean>(SUBMIT_JS(from.i)).catch(() => false))
    await fp.act({ kind: "click" }, at("submit"), { goal });
  else await fp.act({ kind: "press", key: "Enter" }, at(from.i), { goal });
}

/** No password box shows, and no name box on a sign-in address. */
export async function pageSignedIn(fp: FlowPage): Promise<boolean> {
  const got = signInFields(await fieldsOf(fp));
  if ("not" in got) return true;
  return !got.password && !(got.name && SIGN_IN_URL.test(fp.url()));
}

const PAGES = 4;
const SETTLE_MS = 10_000;

/** Waits till the page leaves the fields it showed (a new URL or the box gone). */
async function moved(fp: FlowPage, from: string, box: PageField): Promise<void> {
  const left = fp.waitForUrl((u) => u !== from, SETTLE_MS);
  const gone = (async () => {
    for (let t = 0; t < SETTLE_MS; t += 500) {
      await fp.wait(500);
      if (!(await fp.has(at(box.i)).catch(() => false))) return true;
    }
    return false;
  })();
  await Promise.race([left, gone]);
}

/** Signs in on the page as it is (a wall), else at the credential's url. */
export function pageSignIn(site: string): (ctx: SignInContext) => Promise<void> {
  return async (ctx) => {
    const { fp, cred } = ctx;
    const password = passwordOf(site, cred);
    if (!signInLooks(signInFields(await fieldsOf(fp)), fp.url()) && cred.url)
      await fp.open(cred.url, { allowWall: true });
    let typedName = false;
    let typedPassword = false;
    let typedCode = false;
    for (let n = 0; n < PAGES; n++) {
      const got = signInFields(await fieldsOf(fp));
      if ("not" in got) throw new LoginFailed(site, got.not);
      const url = fp.url();
      if (got.password) {
        if (typedPassword)
          throw new LoginFailed(site, `the form came back after the password: ${url}`);
        if (got.name && !typedName)
          await fp.act({ kind: "fill", value: cred.username }, at(got.name.i), {
            goal: "type username",
          });
        await fp.act({ kind: "fill", value: password }, at(got.password.i), {
          goal: "type password",
        });
        typedPassword = true;
        await submit(fp, got.password, "submit login form");
        await moved(fp, url, got.password);
        continue;
      }
      if (got.code && typedPassword) {
        if (typedCode) throw new LoginFailed(site, `the code was refused: ${url}`);
        if (!cred.totpSecret) {
          await personStep(ctx, `${site}: the sign-in asks for a code only a person has`);
          return;
        }
        const code = await ctx.code("totp");
        await fp.act({ kind: "fill", value: code }, at(got.code.i), { goal: "type the code" });
        typedCode = true;
        await submit(fp, got.code, "submit the code");
        await moved(fp, url, got.code);
        continue;
      }
      // the first page of a two-page form: the name box alone, on a sign-in address
      if (got.name && !typedName && !typedPassword && SIGN_IN_URL.test(url)) {
        await fp.act({ kind: "fill", value: cred.username }, at(got.name.i), {
          goal: "type username",
        });
        typedName = true;
        await submit(fp, got.name, "continue past username");
        await moved(fp, url, got.name);
        continue;
      }
      if (typedPassword) return;
      throw new LoginFailed(site, `no sign-in boxes on the page: ${url}`);
    }
    throw new LoginFailed(site, `still on a sign-in page after ${PAGES} pages: ${fp.url()}`);
  };
}

const signInLooks = (got: ReturnType<typeof signInFields>, url: string): boolean =>
  !("not" in got) && (!!got.password || (!!got.name && SIGN_IN_URL.test(url)));

/**
 * The login for a site with a stored password and no spec. `home` is the credential's url,
 * else none: the sign-in runs where the page is.
 */
export function pageLogin(site: string, cred: Pick<Credential, "url">): SiteLogin {
  return {
    site,
    home: cred.url ?? "about:blank",
    loggedIn: pageSignedIn,
    signIn: pageSignIn(site),
  };
}
