import { describe, expect, it } from "vitest";
import { httpRequestLogLevel, isExpectedMissingIssueDocument } from "../middleware/logger.js";

function issueDocumentRequest(key: string) {
  return {
    method: "GET",
    route: { path: "/issues/:id/documents/:key" },
    params: { id: "issue-1", key },
  };
}

describe("http request log levels", () => {
  it("keeps expected missing issue documents out of warn logs", () => {
    const req = issueDocumentRequest("source-reference");

    expect(isExpectedMissingIssueDocument(req, 404)).toBe(true);
    expect(httpRequestLogLevel(req, 404)).toBe("debug");
  });

  it("keeps unexpected 404s visible as warnings", () => {
    const req = {
      method: "GET",
      route: { path: "/issues/:id" },
      params: { id: "missing" },
    };

    expect(isExpectedMissingIssueDocument(req, 404)).toBe(false);
    expect(httpRequestLogLevel(req, 404)).toBe("warn");
  });

  it("keeps server failures at error level", () => {
    expect(httpRequestLogLevel(issueDocumentRequest("source-reference"), 500)).toBe("error");
    expect(httpRequestLogLevel(issueDocumentRequest("source-reference"), 404, new Error("boom"))).toBe("error");
  });
});
