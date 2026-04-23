import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const ISSUE_PATH = process.env.PAPERCLIP_LIVE_ISSUE_PATH ?? "/HOM/issues/HOM-957?from=issues";
const OUTPUT_DIR = path.resolve(process.cwd(), "output/playwright-live");
const LIVE_EVENTS_PATH_FRAGMENT = "/events/ws";

type RealtimeProbe = {
  socketCount: number;
  socketUrls: Set<string>;
  socketErrors: string[];
  frameCount: number;
};

type SessionSnapshot = {
  status: number;
  sessionId: string | null;
  userId: string | null;
  body: unknown;
};

type DomGateSnapshot = {
  url: string;
  title: string;
  testIds: {
    issuePrimaryFlow: boolean;
    issueConversationSurface: boolean;
    issueConversationComposer: boolean;
    issueConversationEditor: boolean;
    issueDebugPanelsButton: boolean;
    issueDebugPanelsSheet: boolean;
    issueFollowupStatus: boolean;
    issueChatThread: boolean;
  };
  primaryFlowShellLeaks: {
    taskDashboard: boolean;
    hiddenOperationalSurfaces: boolean;
    overviewTab: boolean;
    subIssuesTab: boolean;
    issueExecutionPanel: boolean;
  };
  legacyFlowLeaks: {
    noLiveRunYet: boolean;
    earlierMessagesFolded: boolean;
  };
  counts: {
    primaryFlow: number;
    conversationSurface: number;
    conversationComposer: number;
    chatThread: number;
    contenteditable: number;
    tabs: number;
  };
};

async function saveScreenshot(page: Page, filename: string) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(OUTPUT_DIR, filename),
    fullPage: true,
  });
}

function createRealtimeProbe(page: Page): RealtimeProbe {
  const probe: RealtimeProbe = {
    socketCount: 0,
    socketUrls: new Set<string>(),
    socketErrors: [],
    frameCount: 0,
  };

  page.on("console", (message) => {
    const text = message.text();
    if (text.includes(LIVE_EVENTS_PATH_FRAGMENT) && /403|forbidden|unauthorized/i.test(text)) {
      probe.socketErrors.push(text);
    }
  });
  page.on("websocket", (socket) => {
    if (!socket.url().includes(LIVE_EVENTS_PATH_FRAGMENT)) return;
    probe.socketCount += 1;
    probe.socketUrls.add(socket.url());
    socket.on("framereceived", () => {
      probe.frameCount += 1;
    });
    socket.on("socketerror", (error) => {
      probe.socketErrors.push(String(error));
    });
  });

  return probe;
}

function formatRealtimeProbe(probe: RealtimeProbe) {
  return JSON.stringify(
    {
      socketCount: probe.socketCount,
      frameCount: probe.frameCount,
      socketUrls: Array.from(probe.socketUrls),
      socketErrors: probe.socketErrors,
    },
    null,
    2,
  );
}

async function readSessionSnapshot(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(async () => {
    const res = await fetch("/api/auth/get-session", { credentials: "include" });
    const body = await res.json().catch(() => null);
    return {
      status: res.status,
      sessionId: typeof body?.session?.id === "string" ? body.session.id : null,
      userId: typeof body?.user?.id === "string" ? body.user.id : null,
      body,
    };
  });
}

function isTransientIngress503(value: unknown): boolean {
  if (!value) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /503 Service Unavailable|No server is available to handle this request/i.test(text);
}

async function gotoWithTransient503Retry(page: Page, url: string, attempts = 6) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const status = response?.status() ?? 0;
      if (status === 503 || isTransientIngress503(bodyText)) {
        throw new Error(`Transient ingress 503 while opening ${url}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await page.waitForTimeout(2_500 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readSessionSnapshotWithRetry(page: Page, attempts = 6): Promise<SessionSnapshot> {
  let lastSnapshot: SessionSnapshot | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const snapshot = await readSessionSnapshot(page);
    lastSnapshot = snapshot;
    if (snapshot.status !== 503 && !isTransientIngress503(snapshot.body)) {
      return snapshot;
    }
    if (attempt < attempts) {
      await page.waitForTimeout(2_000 * attempt);
    }
  }

  return lastSnapshot ?? { status: 0, sessionId: null, userId: null, body: null };
}

async function collectDomGateSnapshot(page: Page): Promise<DomGateSnapshot> {
  return page.evaluate(() => {
    const has = (selector: string) => !!document.querySelector(selector);
    const count = (selector: string) => document.querySelectorAll(selector).length;
    const bodyText = document.body.innerText;
    const primaryFlow = document.querySelector('[data-testid="issue-primary-flow"]');
    const primaryFlowText = primaryFlow?.textContent ?? "";
    return {
      url: window.location.href,
      title: document.title,
      testIds: {
        issuePrimaryFlow: has('[data-testid="issue-primary-flow"]'),
        issueConversationSurface: has('[data-testid="issue-conversation-surface"]'),
        issueConversationComposer: has('[data-testid="issue-conversation-composer"]'),
        issueConversationEditor: has('[data-testid="issue-conversation-editor"]'),
        issueDebugPanelsButton: has('[data-testid="issue-debug-panels-button"]'),
        issueDebugPanelsSheet: has('[data-testid="issue-debug-panels-sheet"]'),
        issueFollowupStatus:
          has('[data-testid="issue-pending-indicator"]') || has('[data-testid="issue-pending-message"]'),
        issueChatThread: has('[data-testid="issue-chat-thread"]'),
      },
      primaryFlowShellLeaks: {
        taskDashboard: primaryFlowText.includes("Task Dashboard"),
        hiddenOperationalSurfaces: primaryFlowText.includes("Hidden operational surfaces for debugging and verification."),
        overviewTab: !!primaryFlow?.querySelector('[role="tab"]'),
        subIssuesTab: primaryFlowText.includes("Sub-issues"),
        issueExecutionPanel: primaryFlowText.includes("Issue Execution Panel"),
      },
      legacyFlowLeaks: {
        noLiveRunYet: bodyText.includes("No live run yet"),
        earlierMessagesFolded: /earlier messages folded/i.test(bodyText),
      },
      counts: {
        primaryFlow: count('[data-testid="issue-primary-flow"]'),
        conversationSurface: count('[data-testid="issue-conversation-surface"]'),
        conversationComposer: count('[data-testid="issue-conversation-composer"]'),
        chatThread: count('[data-testid="issue-chat-thread"]'),
        contenteditable: count('[contenteditable="true"]'),
        tabs: count('[role="tab"]'),
      },
    };
  });
}

async function withGateDiagnostics<T>(
  page: Page,
  probe: RealtimeProbe,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const domSnapshot = await collectDomGateSnapshot(page);
    const details = [
      `${label} failed`,
      error instanceof Error ? error.message : String(error),
      `DOM gate snapshot:\n${JSON.stringify(domSnapshot, null, 2)}`,
      `Realtime gate snapshot:\n${formatRealtimeProbe(probe)}`,
    ];
    throw new Error(details.join("\n\n"));
  }
}

async function expectLoggedIn(page: Page) {
  const session = await readSessionSnapshotWithRetry(page);
  expect(session.status, `Unexpected auth status: ${JSON.stringify(session.body)}`).toBe(200);
  expect(session.sessionId, `Missing session id: ${JSON.stringify(session.body)}`).toBeTruthy();
  expect(
    session.sessionId?.startsWith("paperclip:session:"),
    `Expected browser session auth, got ${session.sessionId ?? "null"}`,
  ).toBeTruthy();
  return session;
}

async function expectRealtimeSocketReady(probe: RealtimeProbe) {
  await expect.poll(() => probe.socketCount, { timeout: 15_000 }).toBeGreaterThan(0);
  try {
    await expect.poll(() => probe.socketErrors.length, { timeout: 2_000 }).toBe(0);
  } catch {
    throw new Error(`Realtime socket auth failed.\n${formatRealtimeProbe(probe)}`);
  }
}

function expectNoRealtimeSocketErrors(probe: RealtimeProbe, stage: string) {
  expect(
    probe.socketErrors,
    `${stage}: unexpected realtime socket auth failures.\n${formatRealtimeProbe(probe)}`,
  ).toEqual([]);
}

async function expectSingleChatPrimaryFlow(page: Page, options?: { debugSheetVisible?: boolean }) {
  const primaryFlow = page.getByTestId("issue-primary-flow");
  const conversationSurface = page.getByTestId("issue-conversation-surface");
  const composer = page.getByTestId("issue-conversation-composer");
  const debugSheet = page.getByTestId("issue-debug-panels-sheet");

  await expect(primaryFlow).toBeVisible();
  await expect(conversationSurface).toHaveCount(1);
  await expect(composer).toHaveCount(1);
  await expect(page.getByTestId("issue-chat-thread")).toHaveCount(1);
  await expect(primaryFlow.getByTestId("issue-conversation-surface")).toBeVisible();
  await expect(primaryFlow.getByTestId("issue-conversation-composer")).toBeVisible();
  await expect(page.getByTestId("issue-debug-panels-button")).toHaveCount(0);
  if (options?.debugSheetVisible) {
    await expect(debugSheet).toBeVisible();
  } else {
    await expect(debugSheet).toBeHidden();
  }

  await expect(primaryFlow.getByText("Task Dashboard")).toHaveCount(0);
  await expect(
    primaryFlow.getByText("Hidden operational surfaces for debugging and verification."),
  ).toHaveCount(0);
  await expect(primaryFlow.getByRole("tab", { name: "Overview" })).toHaveCount(0);
  await expect(primaryFlow.getByRole("tab", { name: "Sub-issues" })).toHaveCount(0);
  await expect(primaryFlow.getByText("Issue Execution Panel")).toHaveCount(0);
}

async function waitForVisibleFollowupSignal(thread: Locator) {
  await expect.poll(async () => {
    const indicatorState = await thread
      .getByTestId("issue-pending-indicator")
      .getAttribute("data-state")
      .catch(() => null);
    if (indicatorState && /accepted|queued|running/.test(indicatorState)) return indicatorState;
    const messageState = await thread
      .getByTestId("issue-pending-message")
      .getAttribute("data-state")
      .catch(() => null);
    if (messageState && /blocked|completed|failed/.test(messageState)) return messageState;
    return "none";
  }, { timeout: 15_000 }).toMatch(/accepted|queued|running|blocked|completed|failed/);
}

async function expectSinglePendingTruth(thread: Locator) {
  await expect(thread.getByTestId("issue-pending-indicator")).toBeVisible({ timeout: 15_000 });
  await expect(thread.getByTestId("issue-pending-indicator")).toHaveAttribute(
    "data-state",
    /accepted|queued|running/,
  );
  await expect(thread.getByTestId("issue-pending-dots")).toHaveCount(1);
  await expect(thread.getByTestId("issue-pending-message")).toHaveCount(0);
  await expect(thread.getByTestId("issue-system-ack")).toHaveCount(0);
}

async function expectNoDuplicateOperationalArtifacts(thread: Locator) {
  await expect(thread.getByTestId("issue-system-ack")).toHaveCount(0);
  const indicatorCount = await thread.getByTestId("issue-pending-indicator").count();
  const messageCount = await thread.getByTestId("issue-pending-message").count();
  expect(indicatorCount + messageCount).toBeLessThanOrEqual(1);
  await expect(thread.getByText("Код и workspace уже обрабатываются на Atlas сервере.")).toHaveCount(0);
  await expect(thread.getByText("Executor взял задачу в работу")).toHaveCount(0);
  await expect(thread.getByText("Принял follow-up. Это Atlas Executor.")).toHaveCount(0);
}

async function waitForSemanticReply(thread: Locator, beforeCount: number) {
  const semanticBodies = thread.locator('[data-testid="issue-semantic-reply"] [data-testid="issue-chat-message-body"]');

  await expect
    .poll(async () => await semanticBodies.count(), {
      timeout: 30_000,
      intervals: [1_000, 2_000, 2_500],
    })
    .toBeGreaterThan(beforeCount);

  const deadline = Date.now() + 30_000;
  let latestBody = "";

  while (Date.now() < deadline) {
    const texts = await semanticBodies.evaluateAll((nodes) => nodes
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean));
    const latest = texts.at(-1)?.trim() ?? "";
    if (
      latest
      && latest.length > 10
      && !latest.includes("Принял follow-up")
      && !latest.includes("Executor взял задачу в работу")
      && !latest.includes("Код и workspace уже обрабатываются на Atlas сервере")
    ) {
      latestBody = latest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  expect(latestBody, "Expected a semantic reply body in the primary chat").toBeTruthy();
  return latestBody;
}

function withOpsParam(issuePath: string) {
  const separator = issuePath.includes("?") ? "&" : "?";
  return `${issuePath}${separator}ops=1`;
}

test.describe("Issue single chat live", () => {
  test("keeps only one primary chat surface and preserves hidden debug access", async ({ page }) => {
    const realtimeProbe = createRealtimeProbe(page);

    await test.step("login and open HOM-957", async () => {
      await gotoWithTransient503Retry(page, ISSUE_PATH);
      await expectLoggedIn(page);
      await expectRealtimeSocketReady(realtimeProbe);
    });

    await withGateDiagnostics(page, realtimeProbe, "single-chat primary flow", async () => {
      await expectSingleChatPrimaryFlow(page);
    });

    await saveScreenshot(page, "issue-single-chat-main.png");

    await withGateDiagnostics(page, realtimeProbe, "hidden debug panels reachability", async () => {
      await gotoWithTransient503Retry(page, withOpsParam(ISSUE_PATH));
      await expectLoggedIn(page);
      await expectSingleChatPrimaryFlow(page, { debugSheetVisible: true });
      const debugSheet = page.getByTestId("issue-debug-panels-sheet");
      await expect(debugSheet).toBeVisible();
      await expect(debugSheet.getByTestId("issue-hidden-debug-summary")).toBeVisible();
      await expect(debugSheet.getByTestId("issue-hidden-history")).toBeVisible();
      await expect(debugSheet.getByText("Task Dashboard")).toHaveCount(0);
      await expect(debugSheet.getByRole("tab", { name: "Overview" })).toHaveCount(0);
      await expect(debugSheet.getByRole("tab", { name: "Sub-issues" })).toHaveCount(0);
    });
    expectNoRealtimeSocketErrors(realtimeProbe, "main issue detail");

    await saveScreenshot(page, "issue-single-chat-debug-panels.png");
  });

  test("submits a directed follow-up and keeps visible truth after reload", async ({ page }) => {
    const marker = `чек ${Date.now().toString(36)}`;
    const realtimeProbe = createRealtimeProbe(page);

    await test.step("login and open HOM-957", async () => {
      await gotoWithTransient503Retry(page, ISSUE_PATH);
      await expectLoggedIn(page);
      await expectRealtimeSocketReady(realtimeProbe);
    });

    await withGateDiagnostics(page, realtimeProbe, "pre-submit single-chat shell", async () => {
      await expectSingleChatPrimaryFlow(page);
    });

    const thread = page.getByTestId("issue-chat-thread");
    const semanticReplyCountBeforeSubmit = await thread.getByTestId("issue-semantic-reply").count();
    const userMarkerCountBeforeSubmit = await thread.getByTestId("issue-user-message").filter({ hasText: marker }).count();
    const editor = page.getByTestId("issue-conversation-editor").locator('[contenteditable="true"]').first();
    await editor.click();
    await editor.pressSequentially(marker);

    await expect(page.getByTestId("issue-send-turn")).toBeEnabled();
    const submitResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && /\/api\/issues\/[^/]+\/comments$/.test(response.url());
    });
    await page.getByTestId("issue-send-turn").click();
    const submitResponse = await submitResponsePromise;
    expect(submitResponse.ok()).toBe(true);

    await expect
      .poll(async () => await thread.getByTestId("issue-user-message").filter({ hasText: marker }).count(), {
        timeout: 10_000,
      })
      .toBe(userMarkerCountBeforeSubmit + 1);
    await waitForVisibleFollowupSignal(thread);
    await expectSinglePendingTruth(thread);
    const semanticReplyText = await waitForSemanticReply(thread, semanticReplyCountBeforeSubmit);
    expectNoRealtimeSocketErrors(realtimeProbe, "follow-up submit");

    await saveScreenshot(page, "issue-single-chat-followup-submitted.png");

    const socketCountBeforeReload = realtimeProbe.socketCount;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => realtimeProbe.socketCount, { timeout: 15_000 }).toBeGreaterThan(socketCountBeforeReload);
    expectNoRealtimeSocketErrors(realtimeProbe, "reload reconnect");

    await withGateDiagnostics(page, realtimeProbe, "post-reload single-chat shell", async () => {
      await expectSingleChatPrimaryFlow(page);
    });

    const reloadedThread = page.getByTestId("issue-chat-thread");
    await expect
      .poll(async () => await reloadedThread.getByTestId("issue-user-message").filter({ hasText: marker }).count(), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(userMarkerCountBeforeSubmit + 1);
    await expectNoDuplicateOperationalArtifacts(reloadedThread);
    await expect(
      reloadedThread.getByTestId("issue-chat-message-body").getByText(semanticReplyText, { exact: true }).last(),
    ).toBeVisible({ timeout: 15_000 });
    expectNoRealtimeSocketErrors(realtimeProbe, "after reload");

    await saveScreenshot(page, "issue-single-chat-followup-reloaded.png");
  });
});
