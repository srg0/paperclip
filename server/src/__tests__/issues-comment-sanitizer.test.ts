import { describe, expect, it } from "vitest";
import { sanitizeIssueCommentBody } from "../services/issues.ts";

describe("sanitizeIssueCommentBody", () => {
  it("strips ansi escapes and control-character noise", () => {
    const input = "\u001b[31mStatus:\u001b[0m ok\u0007\nNext:\u0008 reporter";

    expect(sanitizeIssueCommentBody(input)).toBe("Status: ok\nNext: reporter");
  });

  it("drops zero-width and replacement characters", () => {
    const input = "See\u200B this\u2060 link\uFFFD";

    expect(sanitizeIssueCommentBody(input)).toBe("See this link");
  });

  it("normalizes spacing and collapses oversized blank blocks", () => {
    const input = "Result: pass  \r\n\r\n\r\nEvidence: png   \r\n";

    expect(sanitizeIssueCommentBody(input)).toBe("Result: pass\n\nEvidence: png");
  });
});
