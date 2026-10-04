import { describe, it, expect } from "vitest";
import { JevJudge, JEV_ABSTAIN, jevTrigger } from "./jev-judge.js";

const CANDIDATES = [
  { toolId: "mail/send", description: "Send an email", score: 0.62 },
  { toolId: "mail/draft", description: "Save an email draft", score: 0.58 },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("jevTrigger", () => {
  it("flags a thin top-two gap as ambiguous even at high confidence", () => {
    expect(jevTrigger("high", 0.91, 0.88, 0.05)).toBe("ambiguous");
  });

  it("flags a clear medium match as low-confidence", () => {
    expect(jevTrigger("medium", 0.7, 0.4, 0.05)).toBe("low-confidence");
  });

  it("does not ask when the winner is high and alone", () => {
    expect(jevTrigger("high", 0.96, 0.7, 0.05)).toBeNull();
    expect(jevTrigger("exact", 0.99, null, 0.05)).toBeNull();
  });
});

describe("JevJudge", () => {
  it("accepts a shortlisted id above the threshold", async () => {
    const judge = new JevJudge({
      apiKey: "test",
      acceptThreshold: 0.7,
      fetch: async () => jsonResponse({
        answers: { tool: { type: "choice", choice: "mail/send", probabilities: { "mail/send": 0.84, "mail/draft": 0.1, [JEV_ABSTAIN]: 0.06 }, confidence: 0.78 } },
      }),
    });
    const verdict = await judge.judge({ intent: "email the invoice", candidates: CANDIDATES, trigger: "ambiguous" });
    expect(verdict.toolId).toBe("mail/send");
    expect(verdict.probability).toBe(0.84);
  });

  it("declines an id that was not in the shortlist", async () => {
    const judge = new JevJudge({
      apiKey: "test",
      fetch: async () => jsonResponse({
        answers: { tool: { type: "choice", choice: "mail/delete", probabilities: { "mail/delete": 0.99 }, confidence: 0.99 } },
      }),
    });
    const verdict = await judge.judge({ intent: "email the invoice", candidates: CANDIDATES, trigger: "low-confidence" });
    expect(verdict.toolId).toBeNull();
    expect(verdict.reason).toContain("not in the shortlist");
  });

  it("declines below the accept threshold and on abstain", async () => {
    const low = new JevJudge({
      apiKey: "test",
      acceptThreshold: 0.7,
      fetch: async () => jsonResponse({
        answers: { tool: { type: "choice", choice: "mail/send", probabilities: { "mail/send": 0.42 }, confidence: 0.2 } },
      }),
    });
    expect((await low.judge({ intent: "email", candidates: CANDIDATES, trigger: "ambiguous" })).toolId).toBeNull();

    const abstain = new JevJudge({
      apiKey: "test",
      fetch: async () => jsonResponse({
        answers: { tool: { type: "choice", choice: JEV_ABSTAIN, probabilities: { [JEV_ABSTAIN]: 0.9 }, confidence: 0.8 } },
      }),
    });
    expect((await abstain.judge({ intent: "email", candidates: CANDIDATES, trigger: "ambiguous" })).toolId).toBeNull();
  });

  it("declines on a transport failure instead of approving", async () => {
    const judge = new JevJudge({
      apiKey: "test",
      fetch: async () => { throw new Error("network down"); },
    });
    const verdict = await judge.judge({ intent: "email", candidates: CANDIDATES, trigger: "low-confidence" });
    expect(verdict.toolId).toBeNull();
    expect(verdict.reason).toContain("network down");
  });
});
