// as at boot (`loadDataLogins`): the repo's sign-in walks are the built-in logins
import { addSiteLogins } from "../src/auth/sites.js";
import { repoWalkLogins } from "../src/walks/login.js";

addSiteLogins(repoWalkLogins(), { builtIn: true });
