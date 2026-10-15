import { Collector } from "../server/collector.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AllowanceWindows, resetCountdown } from "../src/AllowanceWindows.tsx";
import { accountSnapshot } from "../server/account.ts";
import { MonitoringHealth } from "../src/MonitoringHealth.tsx";

test("both limiting and comfortable windows render with remaining percentages and freshness", () => {
  const now = Date.now();
  const { windows } = accountSnapshot(
    {
      accountId: "synthetic",
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null },
        secondary: {
          usedPercent: 10,
          windowDurationMins: 10080,
          resetsAt: Math.floor(now / 1000) + 600,
        },
      },
    },
    () => "pseudonym",
    undefined,
    now,
  );
  const html = renderToStaticMarkup(
    React.createElement(AllowanceWindows, { windows, now, unavailable: false }),
  );
  assert.match(html, /aria-label="Codex · 5 hours"/);
  assert.match(html, /aria-label="Codex · 7 days"/);
  assert.match(html, /<strong>1<span>%<\/span><\/strong>/);
  assert.match(html, /<strong>90<span>%<\/span><\/strong>/);
  assert.equal((html.match(/<span>remaining<\/span>/g) ?? []).length, 2);
  assert.match(html, /Reset unavailable/);
  const stale = renderToStaticMarkup(
    React.createElement(AllowanceWindows, {
      windows,
      now: now + 121000,
      unavailable: false,
    }),
  );
  assert.equal((stale.match(/Stale reading/g) ?? []).length, 2);
  const failed = renderToStaticMarkup(
    React.createElement(AllowanceWindows, { windows, now, unavailable: true }),
  );
  assert.equal((failed.match(/Stale reading/g) ?? []).length, 2);
  assert.equal(resetCountdown(1, now), "Awaiting reset confirmation");
});

test("a partial local import is visible even when account allowance checks are healthy", () => {
  const html = renderToStaticMarkup(
    React.createElement(MonitoringHealth, {
      coverage: {
        firstSuccessAt: 1000,
        lastSuccessAt: 2000,
        thresholdMs: 120000,
        gapCount: 0,
        gaps: [],
      },
      collector: {
        ...new Collector(
          async () => true,
          true,
          () => {},
        ).state,
        nextRunAt: 62000,
      },
      attempt: { ok: true, at: 2000, message: "Fixture" },
      now: 3000,
      unreachable: false,
      importer: {
        ...new Collector(
          async () => true,
          true,
          () => {},
        ).state,
        lastError: "Retrying",
      },
      busy: false,
      onRetry: () => {},
      onReconnect: () => {},
    }),
  );
  assert.match(html, /Local activity import incomplete/);
  assert.match(html, /allowance checks run separately/);
  assert.doesNotMatch(html, /Monitoring healthy/);
});

test("first-run failures distinguish missing CLI from sign-in and preserve one recovery action", () => {
  const collector = new Collector(
    async () => false,
    true,
    () => {},
  ).state;
  const props = {
    coverage: {
      firstSuccessAt: null,
      lastSuccessAt: null,
      thresholdMs: 120000,
      gapCount: 0,
      gaps: [],
    },
    collector,
    now: 0,
    unreachable: false,
    importer: collector,
    busy: false,
    onRetry: () => {},
    onReconnect: () => {},
  };
  const missing = renderToStaticMarkup(
    React.createElement(MonitoringHealth, {
      ...props,
      attempt: {
        at: 0,
        ok: false,
        message:
          "Codex CLI is unavailable. Set QUOTASCOPE_CODEX to its executable path.",
      },
    }),
  );
  assert.match(missing, /Set QUOTASCOPE_CODEX/);
  assert.equal((missing.match(/<button/g) ?? []).length, 1);
  const login = renderToStaticMarkup(
    React.createElement(MonitoringHealth, {
      ...props,
      attempt: {
        at: 0,
        ok: false,
        message: "Account usage is unavailable. Sign in through Codex.",
      },
    }),
  );
  assert.match(login, /Open Codex and check sign-in/);
  const noHistory = renderToStaticMarkup(
    React.createElement(AllowanceWindows, {
      windows: [],
      now: 0,
      unavailable: false,
    }),
  );
  assert.match(noHistory, /Refresh usage/);
});
