import { describe, expect, it } from "vitest";
import { conversationsOf } from "../src/browser/flows/linkedin-reach.js";

const ME = "urn:li:msg_messagingParticipant:ME";
const member = (urn: string, first: string, last: string, vanity: string) => ({
  hostIdentityUrn: urn,
  participantType: {
    member: {
      firstName: { text: first },
      lastName: { text: last },
      profileUrl: `https://www.linkedin.com/in/${vanity}`,
    },
  },
});

describe("linkedin inbox JSON", () => {
  it("reads the normalized shape: URN refs, owner left out, newest first", () => {
    const body = {
      included: [
        { entityUrn: "p:me", ...member(ME, "Will", "Synth", "will-synth") },
        { entityUrn: "p:sam", ...member("urn:li:x:SAM", "Sam", "Synth", "sam-synth") },
        { entityUrn: "m:1", body: { text: "  thanks,\n see you " } },
        {
          $type: "com.linkedin.messenger.Conversation",
          entityUrn: "c:1",
          backendUrn: "urn:li:messagingThread:2-AAA",
          "*conversationParticipants": ["p:me", "p:sam"],
          messages: { "*elements": ["m:1"] },
          lastActivityAt: 1_792_000_000_000,
          unreadCount: 2,
          categories: ["PRIMARY_INBOX"],
        },
        {
          $type: "com.linkedin.messenger.Conversation",
          entityUrn: "c:2",
          backendUrn: "urn:li:messagingThread:2-BBB",
          "*conversationParticipants": ["p:me"],
          title: { text: "Group chat" },
          descriptionText: "older",
          lastActivityAt: 1_791_000_000_000,
          unreadCount: 0,
          read: true,
        },
      ],
    };
    const rows = conversationsOf([body], ME);
    expect(rows.map((r) => r.threadId)).toEqual(["2-AAA", "2-BBB"]);
    expect(rows[0]).toMatchObject({
      url: "https://www.linkedin.com/messaging/thread/2-AAA/",
      name: "Sam Synth",
      vanity: "sam-synth",
      preview: "thanks, see you",
      unread: true,
      unreadCount: 2,
      categories: ["PRIMARY_INBOX"],
      at: new Date(1_792_000_000_000).toISOString(),
      participants: [
        { name: "Sam Synth", kind: "member", vanity: "sam-synth", urn: "urn:li:x:SAM" },
      ],
    });
    expect(rows[1]).toMatchObject({ name: "Group chat", preview: "older", unread: false });
  });

  it("reads the plain GraphQL shape and one row per thread across pages", () => {
    const conv = {
      _type: "com.linkedin.messenger.Conversation",
      backendUrn: "urn:li:messagingThread:2-CCC",
      conversationParticipants: [
        member(ME, "Will", "Synth", "will-synth"),
        member("urn:li:x:KIM", "Kim", "Synth", "kim-synth"),
      ],
      messages: { elements: [{ body: { text: "hi" } }] },
      lastActivityAt: 1_792_000_000_000,
      unreadCount: 0,
    };
    const page = { data: { messengerConversationsBySyncToken: { elements: [conv] } } };
    const rows = conversationsOf([page, page], ME);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Kim Synth", vanity: "kim-synth", preview: "hi" });
    expect(rows[0]?.item).toBe(conv);
  });
});
