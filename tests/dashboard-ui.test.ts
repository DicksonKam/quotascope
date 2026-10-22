import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { App } from "../src/App.tsx";
import { Collector } from "../server/collector.ts";
import type { DashboardState, OperationState } from "../shared/api.ts";
import { windowKey } from "../shared/allowance.ts";

function fixture(): DashboardState {
  const now = Date.now();
  const window = {
    account: "fixture",
    bucket: "codex",
    slot: "primary" as const,
    source: "account" as const,
    identity: "provider" as const,
    at: now,
    used: 89,
    duration: 300,
    reset: now / 1000 + 3600,
    plan: "test",
    resetCredits: null,
    balance: null,
  };
  return {
    version: 1,
    csrf: "fixture-token",
    now,
    status: { scanning: false, refreshing: false },
    collector: {
      ...new Collector(
        async () => true,
        true,
        () => {},
      ).state,
      managed: false,
    },
    importer: new Collector(
      async () => true,
      true,
      () => {},
    ).state,
    backup: { last: null, error: null, running: false },
    operations: { scan: null, backup: null },
    attempts: [{ at: now, ok: true, message: "Fixture" }],
    scan: null,
    windows: [window],
    latest: window,
    snapshotId: "initial",
    identity: "provider",
    query: {
      view: "overview",
      days: 30,
      window: windowKey(window),
      timezone: "UTC",
    },
    windowHistories: [
      {
        key: windowKey(window),
        history: [window],
        localHistory: [],
        historyTruncated: false,
        localHistoryTruncated: false,
        rate: {
          value: null,
          reason: "Fixture",
          samples: 1,
          hours: 0,
          exhaustionHours: null,
        },
      },
    ],
  };
}

test("mounted dashboard applies control responses before delayed reads, rejects old responses, and recovers persisted jobs on reopen", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost:4317",
    pretendToBeVisual: true,
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  const previous = new Map(
    Object.keys(globals)
      .concat("fetch")
      .map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  dom.window.localStorage.setItem("qs-timezone", "UTC");
  const { createRoot } = await import("react-dom/client");
  let root = createRoot(dom.window.document.getElementById("root")!);
  let server = fixture(),
    holdReads = false;
  const pending: (() => void)[] = [];
  const posts: string[] = [];
  globalThis.fetch = (async (input: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      posts.push(input);
      if (input === "/api/collector")
        server.collector.enabled = JSON.parse(options.body as string).enabled;
      if (input === "/api/refresh") {
        server.windows = [
          { ...server.windows[0], account: "new-account", used: 23 },
        ];
        server.snapshotId = "new-account-snapshot";
      }
      // The real route returns lightweight status, without any analysis/history.
      const { query, windowHistories, latest, ...status } = server;
      return Response.json(status);
    }
    const captured = structuredClone(server);
    if (!holdReads) return Response.json(captured);
    return new Promise<Response>((resolve) =>
      pending.push(() => resolve(Response.json(captured))),
    );
  }) as typeof fetch;
  const text = () => dom.window.document.body.textContent!;
  const checkbox = () =>
    dom.window.document.querySelector<HTMLInputElement>(
      '.freshness input[type="checkbox"]',
    )!;
  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
  }
  async function mount() {
    await act(async () => {
      root.render(React.createElement(App));
    });
  }
  async function reopen() {
    await act(async () => root.unmount());
    root = createRoot(dom.window.document.getElementById("root")!);
    await mount();
  }
  try {
    await mount();
    assert.equal(checkbox().checked, true);
    holdReads = true;
    server.windows[0].used = 87;
    await act(async () => {
      for (let i = 0; i < 3; i++)
        dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(
      pending.length,
      1,
      "repeat focus/poll requests share the pending read",
    );
    await act(async () => pending.shift()!());
    assert.match(
      text(),
      /13%/,
      "a slow response still renders despite intervening polls",
    );
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    const oldRead = pending.shift()!;
    await click(checkbox());
    assert.equal(
      checkbox().checked,
      false,
      "pause response displayed while follow-up GET is unresolved",
    );
    assert.match(text(), /Background monitoring paused/);
    await act(async () => oldRead());
    assert.equal(
      checkbox().checked,
      false,
      "old pre-pause response cannot undo pause",
    );
    const pausedRead = pending.shift()!;
    await click(checkbox());
    assert.equal(
      checkbox().checked,
      true,
      "resume response displayed immediately",
    );
    await act(async () => pausedRead());
    assert.equal(
      checkbox().checked,
      true,
      "old paused response cannot undo resume",
    );
    await click(
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.textContent?.includes("Refresh usage"))!,
    );
    assert.match(
      text(),
      /77%/,
      "new allowance is shown before analytics responds",
    );
    assert.equal(
      dom.window.document.querySelector('[role="slider"]'),
      null,
      "old account chart is invalidated",
    );
    assert.deepEqual(posts, [
      "/api/collector",
      "/api/collector",
      "/api/refresh",
    ]);
    // A newly opened page must render the persisted marker, without any local pending-job state.
    holdReads = false;
    for (const state of [
      "running",
      "succeeded",
      "failed",
      "interrupted",
    ] as const) {
      const marker: OperationState = {
        id: `requested-${state}`,
        state,
        startedAt: Date.now() - 1000,
        completedAt: state === "running" ? null : Date.now(),
      };
      server.operations = {
        scan: marker,
        backup: { ...marker, id: `backup-${state}` },
      };
      await reopen();
      assert.ok(
        dom.window.document.querySelector(
          `[data-operation-id="requested-${state}"]`,
        ),
      );
      assert.ok(
        dom.window.document.querySelector(
          `[data-operation-id="backup-${state}"]`,
        ),
      );
      assert.match(
        text(),
        state === "succeeded"
          ? /Backup completed successfully and was verified/
          : new RegExp(`Backup (?:is )?${state}`),
      );
    }
  } finally {
    await act(async () => root.unmount());
    // Resolve held fetches after unmount so their timeout signals retain no work.
    await act(async () => {
      pending.forEach((resolve) => resolve());
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("activity scope hides old totals while loading and explains unavailable cycle timing", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost:4317",
    pretendToBeVisual: true,
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  const previous = new Map(
    [...Object.keys(globals), "fetch"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  dom.window.localStorage.setItem("qs-timezone", "UTC");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const base = fixture();
  let pending: (() => void) | undefined;
  const queries: URLSearchParams[] = [];
  globalThis.fetch = (async (input: string) => {
    const q = new URL(input, "http://localhost").searchParams;
    queries.push(q);
    const scoped = q.get("activityScope") === "current";
    const response = {
      ...base,
      query: {
        ...base.query,
        view: q.get("view"),
        activityScope: q.get("activityScope"),
        historyScope: q.get("historyScope"),
      },
      activityScope: {
        mode: scoped ? "current" : "all",
        available: !scoped,
        from: null,
        reset: null,
        account: null,
        reason:
          "The provider has not supplied a usable reset time and window duration.",
      },
      usage: {
        input: 12345,
        cached: 0,
        output: 0,
        reasoning: 0,
        total: 12345,
        responses: 1,
        excluded: 0,
        fallbackTokens: 0,
        fallbackRecords: 0,
        first: null,
        last: Date.now(),
        byModel: [],
        bySettings: [],
        sessions: [],
        days: [],
        recentTokensPerMinute: 0,
      },
    };
    if (scoped)
      return new Promise<Response>((resolve) => {
        pending = () => resolve(Response.json(response));
      });
    return Response.json(response);
  }) as typeof fetch;
  const text = () => dom.window.document.body.textContent!;
  const click = async (name: string) => {
    await act(async () => {
      [...dom.window.document.querySelectorAll("button")]
        .find((b) => b.textContent === name)!
        .click();
    });
  };
  try {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await click("Details");
    await click("Activity");
    assert.ok(text().includes("Input tokens"));
    const select = dom.window.document.querySelector<HTMLSelectElement>(
      '[aria-label="Activity period"]',
    )!;
    await act(async () => {
      select.value = "current";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.ok(text().includes("Loading selected activity period"));
    assert.ok(!text().includes("Input tokens"));
    assert.equal(queries.at(-1)?.get("activityScope"), "current");
    await act(async () => {
      pending!();
    });
    assert.ok(text().includes("provider has not supplied"));
    assert.ok(!text().includes("Input tokens"));
    await act(async () => {
      select.value = "all";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.ok(text().includes("Input tokens"));
    await click("Overview");
    const range = dom.window.document.querySelector<HTMLSelectElement>(
      '[aria-label="History range"]',
    )!;
    await act(async () => {
      range.value = "current";
      range.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(queries.at(-1)?.get("historyScope"), "current");
    assert.equal(queries.at(-1)?.get("days"), "30");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
