import { describe, expect, it } from "vitest";
import { csvRows, mapsScrape, mergeMaps } from "../src/reach/maps.js";

describe("maps", () => {
  it("posts the job, waits it out, downloads the CSV", async () => {
    const statuses = ["pending", "working", "working", "ok"];
    const calls: Array<{ url: string; body?: unknown }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/api/v1/jobs")) return Response.json({ id: "j1" }, { status: 201 });
      if (url.endsWith("/download")) return new Response('title,emails\n"A, Inc",a@a.test\n');
      return Response.json({ Status: statuses.shift() });
    }) as typeof fetch;
    const seen: string[] = [];
    const csv = await mapsScrape(
      { keywords: ["ria in austin tx"], depth: 1, email: true, maxMinutes: 5 },
      { fetch: f, sleep: async () => undefined, onStatus: (s) => seen.push(s), base: "http://m" },
    );
    expect(csvRows(csv)).toBe(1);
    expect(seen).toEqual(["pending", "working", "ok"]);
    expect(calls[0]?.body).toMatchObject({
      keywords: ["ria in austin tx"],
      max_time: 300,
      email: true,
    });
    expect(calls.at(-1)?.url).toBe("http://m/api/v1/jobs/j1/download");
  });

  it("a failed job names its engine", async () => {
    const f = (async (url: string) =>
      url.endsWith("/jobs")
        ? Response.json({ id: "j2" })
        : Response.json({ Status: "failed" })) as typeof fetch;
    await expect(
      mapsScrape(
        { keywords: ["x"], depth: 1, email: false, maxMinutes: 1 },
        { fetch: f, base: "http://m" },
      ),
    ).rejects.toThrow(/job j2 at http:\/\/m failed/);
  });

  it("counts rows, not newlines inside a quoted cell", () => {
    expect(csvRows('a,b\n"x\ny",1\nz,2\n')).toBe(2);
  });

  it("sends socials only when asked", async () => {
    const bodies: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith("/api/v1/jobs")) return Response.json({ id: "j3" });
      if (url.endsWith("/download")) return new Response("title\n");
      return Response.json({ Status: "ok" });
    }) as typeof fetch;
    const job = { keywords: ["x"], depth: 1, email: true, maxMinutes: 1 };
    await mapsScrape({ ...job, socials: true }, { fetch: f, base: "http://m" });
    await mapsScrape(job, { fetch: f, base: "http://m" });
    expect(bodies.map((b) => (b as { socials?: boolean }).socials)).toEqual([true, undefined]);
  });

  it("merges by cid: kit cells win, empty ones fill from the owner scraper, its extra places follow", () => {
    const kit =
      "\ufefftitle,cid,owner,emails,instagram\nA,1,,a@a.test,https://instagram.com/a\nB,2,,,\n";
    const owner =
      'title,cid,owner,emails,user_reviews\nA (old),1,"Ann, Owner",,[]\nC,3,Cy,c@c.test,[]\n';
    const m = mergeMaps(kit, owner);
    expect(m).toMatchObject({ both: 1, kitOnly: 1, ownerOnly: 1, owners: 2 });
    expect(m.csv).toBe(
      [
        "title,cid,owner,emails,instagram,user_reviews",
        'A,1,"Ann, Owner",a@a.test,https://instagram.com/a,[]',
        "B,2,,,,",
        "C,3,Cy,c@c.test,,[]",
        "",
      ].join("\n"),
    );
  });
});
