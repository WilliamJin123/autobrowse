/**
 * GitHub as an identity provider: the sign-in behind "Continue with GitHub"
 * is the repo's GitHub walk (src/walks/logins/github.ts), run in place on
 * whatever GitHub page the button opened, so the OAuth `return_to` survives.
 * Imported lazily: the walk runner imports the site logins, which import this.
 */
import type { SignInContext } from "./login.js";
import { registerProvider } from "./providers.js";

export async function signInToGithub(ctx: SignInContext): Promise<void> {
  const [{ walkLogin }, { walkSpecSchema }, { default: file }] = await Promise.all([
    import("../walks/login.js"),
    import("../walks/spec.js"),
    import("../walks/logins/github.js"),
  ]);
  const here = walkLogin(walkSpecSchema.parse(file)).signInHere;
  if (!here) throw new Error("the github walk has no signInHere");
  const page = ctx.fp.page;
  try {
    await here.run(ctx);
  } catch (err) {
    // a popup closes once GitHub hands back: that is the end, not a failure
    if (page.isClosed()) return;
    throw err;
  }
}

registerProvider({
  site: "github",
  host: /github\.com\/(login|sessions?|session)/,
  buttons: [
    { role: "button", name: "/github/i" },
    { role: "link", name: "/github/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with github/i" },
  ],
  signIn: signInToGithub,
});
