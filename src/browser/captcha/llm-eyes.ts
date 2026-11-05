/** Eyes from any model that sees: the captcha picture and the question, one JSON answer back. */
import type { Llm } from "../../llm/index.js";
import type { Eyes } from "./index.js";

export function eyesOf(llm: Llm): Eyes {
  return {
    name: llm.id,
    async look(png, question) {
      const reply = await llm.complete({
        purpose: "captcha",
        system:
          "You solve captchas on the account owner's own browser, with their permission. Answer with the JSON object asked for, nothing else.",
        prompt: question,
        images: [{ mediaType: "image/png", data: png.toString("base64") }],
        json: true,
        // A ceiling, not a spend: Sonnet thinks first, and 300 ran out before the answer (12% of October's calls).
        maxTokens: 3_000,
      });
      return reply.text;
    },
  };
}
