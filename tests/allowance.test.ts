import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountObservations, accountSnapshot } from "../server/account.ts";
import { allowanceView } from "../server/allowance.ts";
import { windowKey, windowLabel } from "../shared/allowance.ts";
import { historyBoundary } from "../shared/history.ts";
import { Store } from "../server/store.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { AccountSnapshot, Observation } from "../shared/types.ts";

const raw = (accountId?: unknown) => ({
  accountId,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000000000 },
  },
});
const hash = (value: unknown) => `hashed-${value}`;

test("unidentified reads never share an account identity or borrow one from an earlier read", () => {
  const first = accountObservations(raw(), hash, 100);
  const second = accountObservations(raw(), hash, 200);
  assert.notEqual(first[0].account, second[0].account);
  for (const invalid of [null, "", "   ", 7, {}, ["account"]]) {
    assert.notEqual(
      accountObservations(raw(invalid), hash, 300)[0].account,
      "hashed-" + String(invalid),
    );
  }
});

const multi = (reverse = false) => {
  const entries = [
    [
      "codex",
      {
        primary: {
          usedPercent: 99,
          windowDurationMins: 300,
          resetsAt: 2000000000,
        },
        secondary: {
          usedPercent: 10,
          windowDurationMins: 10080,
          resetsAt: 2000500000,
        },
      },
    ],
    [
      "other",
      { primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: null } },
    ],
  ];
  return {
    accountId: "account-a",
    rateLimitsByLimitId: Object.fromEntries(
      reverse ? entries.reverse() : entries,
    ),
  };
};

test("all current windows remain visible in stable named order regardless of response order", () => {
  const first = accountSnapshot(multi(), hash, undefined, 100);
  const second = accountSnapshot(multi(true), hash, first, 200);
  const view = allowanceView([...first.windows, ...second.windows], second);
  assert.equal(view.windows.length, 3);
  assert.deepEqual(view.windows.map(windowKey), first.windows.map(windowKey));
  assert.deepEqual(
    view.windows.map((w) => 100 - w.used),
    [1, 90, 80],
  );
  assert.equal(view.latest?.slot, "primary");
  assert.equal(second.continuity, first.continuity);
  assert.equal(windowLabel(view.windows[0]), "Codex · 5 hours");
  assert.equal(windowLabel(view.windows[1]), "Codex · 7 days");
  assert.equal(
    view.windowHistories.every((h) => h.history.length === 2),
    true,
  );
});

test("disappeared buckets and windows are removed from current state but retained in history", () => {
  const before = accountSnapshot(multi(), hash, undefined, 100);
  const after = accountSnapshot(raw("account-a"), hash, before, 200);
  const observations = [...before.windows, ...after.windows];
  const view = allowanceView(observations, after);
  assert.equal(view.windows.length, 1);
  assert.equal(view.windowHistories.length, 1);
  assert.equal(observations.length, 4);
  assert.notEqual(before.continuity, after.continuity);
  assert.match(
    historyBoundary(before.windows[0], after.windows[0])!,
    /continuity/,
  );
  const back = accountSnapshot(multi(true), hash, after, 300);
  assert.notEqual(back.continuity, before.continuity);
  assert.equal(
    allowanceView([...observations, ...back.windows], back).windows.length,
    3,
  );
});

test("a reset keeps the window selected while chart boundaries and pace restart", () => {
  const before = accountSnapshot(
    raw("account-a"),
    hash,
    undefined,
    Date.now() - 60000,
  );
  const next = raw("account-a");
  next.rateLimits.primary.usedPercent = 0;
  next.rateLimits.primary.resetsAt += 100000;
  const after = accountSnapshot(next, hash, before);
  assert.equal(windowKey(before.windows[0]), windowKey(after.windows[0]));
  assert.match(
    historyBoundary(before.windows[0], after.windows[0])!,
    /window changed/,
  );
  assert.equal(
    allowanceView([...before.windows, ...after.windows], after).rate.value,
    null,
  );
});

test("account switches and unknown identity never join pace or mismatched local history", () => {
  let previous: AccountSnapshot | undefined;
  const observations: Observation[] = [];
  const now = Date.now();
  for (let i = 0; i <= 16; i++) {
    const value = raw("account-a");
    value.rateLimits.primary.usedPercent = i;
    previous = accountSnapshot(value, hash, previous, now - (16 - i) * 60000);
    observations.push(...previous.windows);
  }
  assert.notEqual(allowanceView(observations, previous).rate.value, null);
  const b = accountSnapshot(raw("account-b"), hash, previous, now + 1);
  assert.notEqual(b.account, previous!.account);
  assert.equal(
    allowanceView([...observations, ...b.windows], b).history.length,
    1,
  );
  const returned = accountSnapshot(raw("account-a"), hash, b, now + 2);
  const local = {
    ...returned.windows[0],
    source: "local" as const,
    continuity: undefined,
    identity: undefined,
  };
  const all = [
    ...observations,
    ...b.windows,
    ...returned.windows,
    local,
    { ...local, account: "unattributed-local" },
    { ...local, account: b.account },
  ];
  const view = allowanceView(all, returned);
  assert.equal(view.history.length, 18);
  assert.equal(view.rate.value, null);
  assert.equal(view.localHistory.length, 1);
  assert.match(
    historyBoundary(previous!.windows[0], returned.windows[0])!,
    /continuity/,
  );
  const unknown = accountSnapshot(raw(), hash, returned, now + 3);
  assert.equal(unknown.identity, "unknown");
  assert.equal(
    allowanceView([...all, ...unknown.windows], unknown).localHistory.length,
    0,
  );
  const unknownAgain = accountSnapshot(raw(), hash, unknown, now + 4);
  assert.notEqual(unknown.account, unknownAgain.account);
  assert.equal(
    allowanceView(
      [...all, ...unknown.windows, ...unknownAgain.windows],
      unknownAgain,
    ).history.length,
    1,
  );
  const knownAgain = accountSnapshot(
    raw("account-a"),
    hash,
    unknownAgain,
    now + 5,
  );
  assert.notEqual(knownAgain.continuity, returned.continuity);
  assert.equal(
    allowanceView([...all, ...knownAgain.windows], knownAgain).rate.value,
    null,
  );
});

test("snapshot, windows and successful attempt commit atomically and survive reopening", () => {
  const file = join(
    mkdtempSync(`${tmpdir()}/quotascope-snapshot-`),
    "usage.sqlite",
  );
  let store = new Store(file);
  const original = accountSnapshot(raw("account-a"), hash, undefined, 100);
  store.saveAccountSnapshot(original);
  const next = accountSnapshot(multi(), hash, original, 200);
  const attempt = store.attempt.bind(store);
  store.attempt = (a) => {
    attempt(a);
    throw Error("Injected final write failure");
  };
  assert.throws(() => store.saveAccountSnapshot(next), /Injected/);
  assert.deepEqual(store.get("accountSnapshot"), original);
  assert.equal(store.observations().length, 1);
  assert.equal(store.attempts().length, 1);
  assert.equal(store.coverage().lastSuccessAt, 100);
  store.attempt = attempt;
  store.saveAccountSnapshot(next);
  store.close();
  store = new Store(file);
  try {
    assert.deepEqual(store.get("accountSnapshot"), next);
    assert.equal(store.observations().length, 4);
    assert.equal(store.coverage().lastSuccessAt, 200);
    store.accountReadFailed("Signed out", 300);
    assert.deepEqual(store.get("accountSnapshot"), next);
    assert.equal(store.get("accountContinuityBroken"), true);
    assert.equal(store.attempts()[0].ok, false);
    assert.equal(store.coverage().lastSuccessAt, 200);
  } finally {
    store.close();
  }
});

test("legacy unattributed and manual readings cannot become current provider windows", () => {
  const legacy = {
    ...accountObservations(raw(), hash, 100)[0],
    account: "unattributed-account",
    identity: undefined,
  };
  const current = accountSnapshot(raw("account-a"), hash, undefined, 200);
  const view = allowanceView(
    [legacy, { ...legacy, source: "manual" }, ...current.windows],
    current,
  );
  assert.equal(view.history.length, 1);
  assert.equal(view.windows.length, 1);
  assert.equal(allowanceView([legacy]).windows.length, 0);
});
