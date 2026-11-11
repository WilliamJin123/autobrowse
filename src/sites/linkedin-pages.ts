/**
 * LinkedIn's Community Management API, on its own app ("Wren Pages"): LinkedIn lets that product be
 * the only one on an app, so its token is apart from `linkedin`'s member token. Company lookups
 * (WA-1113): name, site, logo, places and followers before any page read.
 */
import { z } from "zod";
import { mustOk } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { LINKEDIN_VERSION } from "./linkedin.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

const ORIGIN = "https://api.linkedin.com";

export const linkedinPagesOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.linkedin.authorize,
  tokenUrl: OAUTH_PROVIDERS.linkedin.token,
  scopes: ["rw_organization_admin", "r_organization_social", "w_organization_social"],
  clientId: "SOCIAL_LINKEDIN_PAGES_CLIENT_ID",
  clientSecret: "SOCIAL_LINKEDIN_PAGES_CLIENT_SECRET",
  // CM tokens refresh for a year; the access token is minted from it
  refreshToken: "LINKEDIN_PAGES_REFRESH_TOKEN",
  accessToken: "LINKEDIN_PAGES_ACCESS_TOKEN",
  // the app's one registered redirect: wren's portal callback; the code is read off the landed URL
  redirect: "https://app.wrenautomation.com/oauth/social/linkedin_page",
  consent: { flow: "linkedin/oauth-consent" },
};

const headers = (leg: ApiLeg) => ({
  authorization: `Bearer ${leg.token}`,
  "LinkedIn-Version": LINKEDIN_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
});

const company = z.object({
  vanity: z
    .string()
    .regex(/^[A-Za-z0-9_%-]{2,100}$/, "a company handle (the part after /company/)"),
});
const orgUrn = z.object({
  urn: z.string().regex(/^urn:li:organization:\d+$/, "urn:li:organization:<id>"),
});

export const linkedinPages: SiteApi = {
  site: "linkedin-pages",
  purpose: "Company lookups and Page reads through LinkedIn's Community Management app",
  origin: ORIGIN,
  probe: { path: "/rest/organizations", input: { vanity: "linkedin" } },
  auth: { oauth: linkedinPagesOAuth },
  // Development tier: LinkedIn meters the app per day; stay well under
  caps: { lookup: 400 },
  routes: [
    route({
      method: "GET",
      path: "/rest/organizations",
      summary:
        "A company by its handle (`vanity`): id, name, site, logo, places, type; the fields LinkedIn shows a non-admin",
      request: company,
      meter: () => ({ lookup: 1 }),
      api: async ({ vanity }, leg) =>
        mustOk(
          await leg.http.json<unknown>(
            `${ORIGIN}/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanity)}`,
            { headers: headers(leg) },
          ),
          `${ORIGIN}/rest/organizations?q=vanityName`,
        ),
    }),
    route({
      method: "GET",
      path: "/rest/networkSizes/{urn}",
      summary: "A company's follower count (`firstDegreeSize`)",
      request: orgUrn,
      meter: () => ({ lookup: 1 }),
      api: async ({ urn }, leg) =>
        mustOk(
          await leg.http.json<unknown>(
            `${ORIGIN}/rest/networkSizes/${encodeURIComponent(urn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            { headers: headers(leg) },
          ),
          `${ORIGIN}/rest/networkSizes/{urn}`,
        ),
    }),
  ],
  setup: [
    {
      name: "consent",
      makes: ["LINKEDIN_PAGES_REFRESH_TOKEN", "LINKEDIN_PAGES_ACCESS_TOKEN"],
      needs: ["SOCIAL_LINKEDIN_PAGES_CLIENT_ID", "SOCIAL_LINKEDIN_PAGES_CLIENT_SECRET"],
      how: { oauth: linkedinPagesOAuth },
      summary:
        "Consent once as a Page admin on the Wren Pages app (Community Management, Development tier); the refresh token lasts a year",
    },
  ],
};
