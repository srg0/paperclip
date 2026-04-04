import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

import { loginBoardCli } from "../client/board-auth.js";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

describe("loginBoardCli", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries CLI auth challenge creation without requestedCompanyId when the company-scoped request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Internal server error" }, { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "challenge-1",
          token: "pcp_cli_auth_secret",
          boardApiToken: "pcp_board_token",
          approvalPath: "/cli-auth/challenge-1?token=pcp_cli_auth_secret",
          approvalUrl: "https://org.homio.pro/cli-auth/challenge-1?token=pcp_cli_auth_secret",
          pollPath: "/cli-auth/challenges/challenge-1",
          expiresAt: "2026-04-04T08:08:49.018Z",
          suggestedPollIntervalMs: 1000,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "challenge-1",
          status: "approved",
          command: "paperclipai auth login",
          clientName: "codex",
          requestedAccess: "board",
          requestedCompanyId: null,
          requestedCompanyName: null,
          approvedAt: "2026-04-04T08:00:00.000Z",
          cancelledAt: null,
          expiresAt: "2026-04-04T08:08:49.018Z",
          approvedByUser: { id: "user-1", name: "User One", email: "user@example.com" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ userId: "user-1", user: { id: "user-1" } }));

    const result = await loginBoardCli({
      apiBase: "https://org.homio.pro",
      requestedAccess: "board",
      requestedCompanyId: "d9dc8ebf-6721-48ce-9bb0-0f1554634956",
      clientName: "codex",
      print: false,
      storePath: "/tmp/paperclip-auth-test.json",
    });

    expect(result).toEqual({
      token: "pcp_board_token",
      approvalUrl: "https://org.homio.pro/cli-auth/challenge-1?token=pcp_cli_auth_secret",
      userId: "user-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const firstCreateBody = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body ?? "{}"),
    );
    const secondCreateBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body ?? "{}"),
    );

    expect(firstCreateBody.requestedCompanyId).toBe("d9dc8ebf-6721-48ce-9bb0-0f1554634956");
    expect(secondCreateBody.requestedCompanyId).toBeNull();
  });
});
