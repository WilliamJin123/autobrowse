/**
 * One developer app's Products tab (`/developers/apps/<id>/products`), read as the account that
 * owns it: each product the app holds or asked for, with the state the page shows ("Review in
 * progress", "Added", "Request access"). Read only: one page load, no click.
 * The page's markup has no stable names: the products come back as the tab's text lines, whole;
 * `states` are the lines that name a state.
 */

import { defineFlow } from "../flow.js";
import { AccessRefused } from "../session.js";
import { go } from "./linkedin-reach.js";

const RENDER_MS = 20_000;
const STATE =
  /review|in progress|approved|denied|rejected|pending|added|request access|access granted|not eligible|endorsed|tier/i;

const LINES = `(document.querySelector("main")?.innerText ?? "").split("\\n").map((l) => l.trim()).filter(Boolean)`;

export interface DeveloperApp {
  app: string;
  url: string;
  title: string;
  /** The tab's text, one entry per line. */
  lines: string[];
  /** The lines that name a product's state. */
  states: string[];
}

export const linkedinDeveloperApp = defineFlow<{ app: string }, DeveloperApp>({
  site: "linkedin",
  name: "developer-app",
  async run(fp, { app }) {
    await go(fp, `https://www.linkedin.com/developers/apps/${encodeURIComponent(app)}/products`);
    let lines: string[] = [];
    for (let t = 0; t < RENDER_MS && lines.length < 5; t += 1_000) {
      await fp.wait(1_000);
      if (/\/(login|authwall|checkpoint)\b/.test(fp.url()))
        throw new AccessRefused("need_login", `linkedin: developer app ${app} asks for a sign-in`);
      lines = await fp.page.evaluate<string[]>(LINES);
    }
    if (lines.length < 5)
      throw new AccessRefused(
        "upstream_broken",
        `linkedin: developer app ${app} showed no products tab (${fp.url()})`,
      );
    return {
      app,
      url: fp.url(),
      title: await fp.page.title(),
      lines,
      states: lines.filter((l) => STATE.test(l) && l.length < 120),
    };
  },
});
