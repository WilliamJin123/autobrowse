import { describe, expect, it } from "vitest";
import { savedOf } from "./linkedin-saved.js";

const now = new Date("2026-11-12T12:00:00Z");
const raw = {
  urn: "urn:li:activity:7000000000000000001",
  text: "",
  actor:
    "A Person\nView A Person’s profile\n• 1st\nBuilds small tools\n2w •\n2w Visible to everyone",
  summary: "Line one\nLine two",
  links: [
    "https://www.linkedin.com/in/ACoAAA?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAA",
    "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001?x=1",
  ],
  images: [
    { alt: "A Person", src: "https://media.example/face.jpg" },
    { alt: "Image preview", src: "https://media.example/post.jpg" },
  ],
};

describe("linkedin saved", () => {
  it("reads the author, headline, age, text and the post's picture", () => {
    expect(savedOf(raw, now)).toMatchObject({
      urn: raw.urn,
      url: `https://www.linkedin.com/feed/update/${raw.urn}/`,
      author: {
        name: "A Person",
        url: "https://www.linkedin.com/in/ACoAAA",
        headline: "Builds small tools",
      },
      text: "Line one\nLine two",
      age: "2w",
      approx: true,
      images: ["https://media.example/post.jpg"],
    });
  });

  it("drops a block with no urn or no text", () => {
    expect(savedOf({ ...raw, urn: "" }, now)).toBeNull();
    expect(savedOf({ ...raw, summary: "  " }, now)).toBeNull();
  });
});
