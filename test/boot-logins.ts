// as at boot (`loadDataLogins`): the repo's sign-in walks are the built-in logins
import { beforeAll } from "vitest";

// in a hook, imported late: a static import here loads the browser modules before a test's
// vi.mock (fingerprint-launch mocks fingerprint.js), and its mock never applies
beforeAll(async () => {
  const { addSiteLogins } = await import("../src/auth/sites.js");
  const { repoWalkLogins } = await import("../src/walks/login.js");
  addSiteLogins(repoWalkLogins(), { builtIn: true });
});
