import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/store.ts";
import { scan } from "../server/scanner.ts";
import { parseRecord, usage as parseUsage, type Context } from "../server/parser.ts";
import { accountObservations } from "../server/account.ts";
import {
  burnRate,
  reconstruct,
  comparisons,
  summarize,
} from "../server/metrics.ts";
import { csvCell } from "../server/privacy.ts";
import type { Observation, TokenEvent, Annotation } from "../shared/types.ts";
const hash = (v: unknown) =>
  createHash("sha256").update(String(v)).digest("hex").slice(0, 20);
const temp = () => mkdtempSync(`${tmpdir()}/quotascope-test-`);
const usage = {
  input_tokens: 1000,
  cached_input_tokens: 700,
  cache_write_input_tokens: 0,
  output_tokens: 100,
  reasoning_output_tokens: 30,
  total_tokens: 1100,
};
const ctx = (): Context => ({
  account: "account",
  device: "device",
  thread: "thread",
  session: "session",
  model: "gpt-test",
  effort: "high",
  speed: "standard",
  parent: false,
  offset: 0,
  inode: "1",
  modified: 0,
  parser: 1,
});
const record = (response = "r1", u = usage) => ({
  type: "token_usage_record",
  timestamp: "2026-10-15T12:00:00Z",
  payload: {
    response_id: response,
    thread_id: "thread",
    usage: u,
    prompt: "SYNTHETIC_PRIVATE_SENTINEL",
  },
});
const obs = (
  at: number,
  used: number,
  reset = 2000000000,
  source: Observation["source"] = "account",
): Observation => ({
  account: "account",
  bucket: "codex",
  slot: "primary",
  at,
  used,
  reset,
  duration: 10080,
  plan: "prolite",
  source,
  resetCredits: 3,
  balance: "0",
});
test("response duplication across resumed files is counted once; nested token categories are not added twice", () => {
  const s = new Store(join(temp(), "usage.sqlite"));
  parseRecord(record(), ctx(), s, hash, "file1", 0);
  const resumed = ctx();
  resumed.session = "resumed";
  parseRecord(record(), resumed, s, hash, "file2", 0);
  assert.equal(s.events().length, 1);
  assert.equal(summarize(s.events()).total, 1100);
  assert.equal(summarize(s.events()).reasoning, 30);
  s.close();
});
test("account identities isolate the same response ID", () => {
  const s = new Store(join(temp(), "u.sqlite"));
  const c = ctx();
  parseRecord(record(), c, s, hash, "a", 0);
  c.account = "another";
  parseRecord(record(), c, s, hash, "b", 0);
  assert.equal(s.events().length, 2);
  s.close();
});
test("inherited counters and repeated cumulative events never become additive response usage", () => {
  const s = new Store(join(temp(), "u.sqlite"));
  const c = ctx();
  const d = {
    type: "event_msg",
    timestamp: "2026-10-15T12:00:00Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage },
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: 20,
          window_minutes: 10080,
          resets_at: 2000000000,
        },
      },
    },
  };
  parseRecord(d, c, s, hash, "a", 0);
  parseRecord(d, c, s, hash, "a", 1);
  parseRecord(record(), c, s, hash, "a", 2);
  assert.equal(s.events().filter((e) => e.kind === "response").length, 1);
  assert.equal(summarize(s.events()).total, 1100);
  assert.equal(s.observations().length, 1);
  assert.ok(s.issues().some((i) => i.code === "repeated-cumulative"));
  s.close();
});
test("inconsistent, nonzero cache-write and invalid nested counters are quarantined from trusted totals", () => {
  const s = new Store(join(temp(), "u.sqlite"));
  parseRecord(
    record("bad", { ...usage, total_tokens: 1200 }),
    ctx(),
    s,
    hash,
    "a",
    0,
  );
  parseRecord(
    record("write", { ...usage, cache_write_input_tokens: 50 }),
    ctx(),
    s,
    hash,
    "a",
    1,
  );
  parseRecord(
    record("nested", { ...usage, cached_input_tokens: 2000 }),
    ctx(),
    s,
    hash,
    "a",
    2,
  );
  assert.equal(summarize(s.events()).total, 0);
  assert.equal(summarize(s.events()).excluded, 3);
  s.close();
});
test("parser does not persist private fields, arbitrary model text or source paths", () => {
  const s = new Store(join(temp(), "u.sqlite"));
  const c = ctx();
  parseRecord(
    {
      type: "session_meta",
      payload: {
        id: "private-thread",
        creator_account_id: "private-account",
        cwd: "/sensitive/path",
        base_instructions: "SYNTHETIC_PRIVATE_SENTINEL",
      },
    },
    c,
    s,
    hash,
    "file",
    0,
  );
  parseRecord(
    {
      type: "turn_context",
      payload: { model: "SYNTHETIC PRIVATE SENTINEL", effort: "high" },
    },
    c,
    s,
    hash,
    "file",
    1,
  );
  parseRecord(record(), c, s, hash, "file", 2);
  const data = JSON.stringify([s.events(), s.observations(), s.issues(), c]);
  assert.ok(!data.includes("SYNTHETIC_PRIVATE_SENTINEL"));
  assert.ok(!data.includes("/sensitive/path"));
  assert.ok(!data.includes("private-account"));
  assert.equal(s.events()[0].model, "unknown");
  s.close();
});
test("streaming import is idempotent and retries an incomplete final line without modifying source", async () => {
  const dir = temp(),
    source = join(dir, "source");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(source);
  const file = join(source, "test.jsonl");
  const line = JSON.stringify(record());
  writeFileSync(file, line.slice(0, 50));
  const s = new Store(join(dir, "u.sqlite"));
  await scan(s, hash, [source]);
  assert.equal(s.events().length, 0);
  appendFileSync(file, line.slice(50) + "\n");
  const before = readFileSync(file);
  const r = await scan(s, hash, [source]);
  assert.equal(s.events().length, 1);
  const r2 = await scan(s, hash, [source]);
  assert.equal(s.events().length, 1);
  assert.equal(r2.bytes, 0);
  assert.ok(r.bytes > 0);
  assert.deepEqual(readFileSync(file), before);
  s.close();
});
test("source truncation and malformed lines do not inflate canonical totals", async () => {
  const dir = temp(),
    source = join(dir, "source");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(source);
  const file = join(source, "t.jsonl");
  writeFileSync(file, JSON.stringify(record()) + "\n{broken}\n");
  const s = new Store(join(dir, "u.sqlite"));
  await scan(s, hash, [source]);
  writeFileSync(file, JSON.stringify(record()) + "\n");
  await scan(s, hash, [source]);
  assert.equal(s.events().length, 1);
  assert.ok(s.issues().some((i) => i.code === "source-replaced-or-truncated"));
  assert.ok(s.issues().some((i) => i.code === "malformed-record"));
  s.close();
});
test("database backup and reopening preserve canonical history and observation timestamps", () => {
  const dir = temp(),
    s = new Store(join(dir, "u.sqlite"));
  s.event({
    ...ctx(),
    key: "event",
    at: 1,
    input: 100,
    cached: 50,
    cacheWrite: 0,
    output: 10,
    reasoning: 2,
    total: 110,
    kind: "response",
    flags: [],
  } as TokenEvent);
  s.observe(obs(12345, 10));
  const backup = join(dir, "backup.sqlite");
  s.backup(backup);
  s.close();
  const b = new Store(backup);
  assert.equal(b.events().length, 1);
  assert.equal(b.observations()[0].at, 12345);
  assert.equal(statSync(backup).size > 0, true);
  b.close();
});
test("account allowlist retains multiple buckets, nulls and safe metadata without exposing IDs", () => {
  const raw = {
    accountId: "private-account",
    email: "not-for-export@example.invalid",
    rateLimitsByLimitId: {
      codex: {
        planType: "prolite",
        primary: {
          usedPercent: 2,
          windowDurationMins: 10080,
          resetsAt: 2000000000,
        },
      },
      other: {
        secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
      },
    },
    rateLimitResetCredits: {
      availableCount: 3,
      credits: [{ id: "secret-credit" }],
    },
  };
  const values = accountObservations(raw, hash, 100);
  assert.equal(values.length, 2);
  assert.equal(values[1].duration, null);
  assert.equal(values[1].reset, null);
  assert.ok(!JSON.stringify(values).includes("secret-credit"));
  assert.ok(!JSON.stringify(values).includes("private-account"));
  assert.throws(() => accountObservations({}, hash));
});
test("deadline jitter is tolerated; percentage drops, large shifts, plan and account changes split segments", () => {
  const base = 1000000;
  const os = [
    obs(base, 10),
    obs(base + 60000, 12, 2000000005),
    obs(base + 120000, 1, 2000600000),
    { ...obs(base + 180000, 2, 2000600000), plan: "other" },
  ];
  const ss = reconstruct(os);
  assert.equal(ss.length, 3);
  assert.equal(ss.find((s) => s.reason === "first-observation")!.samples, 2);
  assert.equal(
    reconstruct([...os, { ...obs(base + 190000, 4), account: "other" }]).length,
    4,
  );
});
test("rate requires sufficient independent time and percentage movement and never crosses a reset", () => {
  const t = Date.now();
  assert.equal(burnRate([obs(t, 1)], t).value, null);
  assert.equal(
    burnRate([obs(t - 120000, 1), obs(t - 60000, 1), obs(t, 1)], t).value,
    null,
  );
  assert.equal(
    burnRate([obs(t - 3600000, 10), obs(t - 1800000, 12), obs(t, 15)], t).value,
    5,
  );
  assert.equal(
    burnRate(
      [obs(t - 120000, 90), obs(t - 60000, 95), obs(t, 1, 2000600000)],
      t,
    ).value,
    null,
  );
  assert.equal(
    burnRate(
      [obs(t - 3600000, 10), obs(t - 1800000, 12), obs(t - 500000, 15)],
      t,
    ).value,
    null,
  );
});
test("CSV formula prefixes and quotation marks remain inert", () => {
  assert.equal(csvCell("=SUM(1)"), '"\'=SUM(1)"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell("@cmd"), '"\'@cmd"');
});
function interval(t: number, reset = 2000000000): Observation[] {
  return Array.from({ length: 11 }, (_, i) => obs(t + i * 60000, 5 + i, reset));
}
test("comparison refuses unconfirmed coverage and unknown settings", () => {
  const t = Date.now(),
    os = interval(t - 600000);
  assert.equal(comparisons(os, [], []).status, "Insufficient evidence");
  assert.ok(
    Object.keys(comparisons(os, [], []).rejected).some((s) =>
      s.includes("coverage"),
    ),
  );
});
function comparisonFixture() {
  const os: Observation[] = [],
    es: TokenEvent[] = [],
    notes: Annotation[] = [];
  const start = Date.now() - 20 * 86400000;
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < 3; i++) {
      const t = start + (p * 4 + i) * 86400000;
      os.push(...interval(t, Math.round(t / 1000 + 60000)));
      es.push({
        ...ctx(),
        key: `${p}:${i}`,
        account: "account",
        at: t + 300000,
        turnStart: t + 60000,
        input: 10000 * (p + 1),
        cached: 7000 * (p + 1),
        cacheWrite: 0,
        output: 1000 * (p + 1),
        reasoning: 300,
        total: 11000 * (p + 1),
        kind: "response",
        flags: [],
      } as TokenEvent);
      notes.push(
        {
          kind: "plan",
          account: "account",
          at: t,
          end: t + 600000,
          label: `plan-${p}`,
          verified: true,
        },
        {
          kind: "coverage",
          account: "account",
          at: t,
          end: t + 600000,
          label: "This device only",
          verified: true,
        },
      );
    }
  return { os, es, notes };
}
test("matched cohorts need three independent windows per plan; mixed models cannot establish factors", () => {
  const { os, es, notes } = comparisonFixture();
  const r = comparisons(os, es, notes);
  assert.equal(r.pairs.length, 1);
  assert.equal(
    comparisons(
      [...os, ...os.map((o) => ({ ...o, bucket: "another-meter" }))],
      es,
      notes,
    ).pairs.length,
    0,
  );
  assert.equal(
    comparisons(
      os,
      es.map((e) => ({ ...e, turnStart: null })),
      notes,
    ).pairs.length,
    0,
  );
  assert.equal(
    comparisons(
      os,
      es.map((e) => ({ ...e, turnStart: 0 })),
      notes,
    ).pairs.length,
    0,
  );
  assert.equal(r.pairs[0].ratio, 2);
  assert.equal(
    comparisons(
      os,
      es.map((e) => ({ ...e, speed: "unknown" })),
      notes,
    ).pairs.length,
    0,
  );
  assert.equal(comparisons(os, es.slice(1), notes).pairs.length, 0);
});

test("forked histories deduplicate one response across changed thread IDs and quarantine conflicting counters", () => {
  const s = new Store(join(temp(), "u.sqlite"));
  parseRecord(record(), ctx(), s, hash, "a", 0);
  const d = record();
  d.payload.thread_id = "fork";
  parseRecord(d, ctx(), s, hash, "b", 0);
  assert.equal(s.events().length, 1);
  parseRecord(
    record("r1", { ...usage, input_tokens: 2000, total_tokens: 2100 }),
    ctx(),
    s,
    hash,
    "b",
    1,
  );
  assert.equal(summarize(s.events()).total, 0);
  assert.ok(s.issues().some((i) => i.code === "response-id-conflict"));
  s.close();
});
test("legacy cumulative estimates are visible separately and never added to response totals", () => {
  const s = new Store(join(temp(), "u.sqlite")),
    c = ctx();
  c.thread = hash("thread");
  const d = {
    type: "event_msg",
    timestamp: "2026-10-15T12:00:00Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage, last_token_usage: usage },
    },
  };
  parseRecord(d, c, s, hash, "a", 0);
  assert.equal(summarize(s.events()).total, 0);
  assert.equal(summarize(s.events()).fallbackTokens, 1100);
  parseRecord(record(), c, s, hash, "a", 1);
  assert.equal(summarize(s.events()).total, 1100);
  assert.equal(summarize(s.events()).fallbackTokens, 0);
  s.close();
});
test("migration archives derived metadata while preserving every account observation and note", () => {
  const dir = temp(),
    file = join(dir, "u.sqlite"),
    s = new Store(file);
  s.observe(obs(100, 12));
  s.annotate({
    account: "account",
    kind: "plan",
    at: 1,
    end: 200,
    label: "Confirmed",
    verified: true,
  });
  parseRecord(record(), ctx(), s, hash, "migration", 0);
  s.db.prepare("UPDATE meta SET value=? WHERE key=?").run("1", "schema");
  s.close();
  const migrated = new Store(file);
  assert.equal(migrated.observations().length, 1);
  assert.equal(migrated.annotations().length, 1);
  assert.equal(
    migrated.db.prepare("SELECT count(*) as n FROM event_archive_v1").get()!.n,
    1,
  );
  assert.equal(migrated.events().length, 0);
  assert.equal(
    migrated.db
      .prepare(
        "SELECT count(*) as n FROM sqlite_master WHERE name='event_archive_v1'",
      )
      .get()!.n,
    1,
  );
  migrated.close();
});

test("separated intervals with the same jittered reset remain one independent window", () => {
  const start = Date.now() - 86400000,
    os: Observation[] = [],
    es: TokenEvent[] = [],
    notes: Annotation[] = [
      {
        kind: "plan",
        account: "account",
        at: start,
        end: start + 86400000,
        label: "Plan A",
        verified: true,
      },
      {
        kind: "coverage",
        account: "account",
        at: start,
        end: start + 86400000,
        label: "Known device coverage",
        verified: true,
      },
    ];
  for (let i = 0; i < 3; i++) {
    const t = start + i * 7 * 3600000;
    os.push(...interval(t, 2000000000 + i));
    es.push({
      ...ctx(),
      key: String(i),
      at: t + 300000,
      turnStart: t + 60000,
      input: 1000,
      cached: 700,
      cacheWrite: 0,
      output: 100,
      reasoning: 30,
      total: 1100,
      kind: "response",
      flags: [],
    } as TokenEvent);
  }
  const result = comparisons(os, es, notes);
  assert.equal(result.cohorts[0].windows, 1);
  assert.equal(result.cohorts[0].qualified, false);
  assert.equal(result.pairs.length, 0);
});
test("missing identifier salt refuses to create a second identity for existing data", async () => {
  const { identityFactory } = await import("../server/privacy.ts");
  const dir = temp();
  writeFileSync(join(dir, "quotascope.sqlite"), "existing");
  assert.throws(() => identityFactory(dir), /salt is missing/);
  assert.equal(
    readFileSync(join(dir, "quotascope.sqlite"), "utf8"),
    "existing",
  );
});


test("comparisons never pool accounts, allowance slots, durations or provider plan periods", () => {
  const { os, es, notes } = comparisonFixture();
  const boundary = notes[6].at;
  for (const change of [{ account: "another-account" }, { slot: "secondary" as const }, { duration: 300 }, { bucket: "other" }]) {
    const modified = os.map(o => o.at >= boundary ? { ...o, ...change } : o);
    const events = es.map(e => e.at >= boundary && change.account ? { ...e, account: change.account } : e);
    const annotations = notes.map(a => a.at >= boundary && change.account ? { ...a, account: change.account } : a);
    assert.equal(comparisons(modified, events, annotations).pairs.length, 0);
  }
  // A provider plan change splits a user-labelled period instead of pooling its windows.
  const changedPlan = os.map(o => o.at >= notes[4].at && o.at < boundary ? { ...o, plan: "different-plan" } : o);
  assert.equal(comparisons(changedPlan, es, notes).pairs.length, 0);
});

test("comparisons reject gaps, expired/unknown windows, noted resets and zero movement", () => {
  const { os, es, notes } = comparisonFixture();
  const start = os[0].at;
  const cases = [
    os.filter(o => (o.at - start) % 86400000 === 0 || (o.at - start) % 86400000 === 600000),
    os.map(o => ({ ...o, reset: null })),
    os.map(o => ({ ...o, duration: null })),
    os.map(o => ({ ...o, reset: Math.floor(o.at / 1000) - 1 })),
    os.map(o => ({ ...o, used: 5 })),
    os.map(o => ({ ...o, used: 5 + (o.used - 5) / 10 })),
  ];
  for (const observations of cases) assert.equal(comparisons(observations, es, notes).pairs.length, 0);
  assert.equal(comparisons(os, es.map(e => ({ ...e, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 })), notes).pairs.length, 0);
  const resets: Annotation[] = notes.filter(a => a.kind === "plan").map(a => ({ ...a, kind: "reset", at: a.at + 300000, end: null, verified: false, label: "Possible manual redemption" }));
  assert.equal(comparisons(os, es, [...notes, ...resets]).pairs.length, 0);
  assert.equal(comparisons(os, es, notes).pairs[0].ratio, 2);
  assert.match(comparisons(os, es, notes).caveat, /rollout timing are not verified/);
});

test("cache changes remain recorded without implying quota savings or adding nested tokens", () => {
  const s = new Store(join(temp(), "cache.sqlite"));
  const missingWrite = { ...usage } as Partial<typeof usage>;
  delete missingWrite.cache_write_input_tokens;
  assert.equal(parseUsage(missingWrite)?.cacheWrite, null);
  for (const field of ["cached_input_tokens", "reasoning_output_tokens"] as const) {
    const missing = { ...usage } as Partial<typeof usage>;
    delete missing[field];
    assert.equal(parseUsage(missing), null); // Incomplete records are excluded, not assumed zero.
  }
  parseRecord(record("shared", missingWrite as typeof usage), ctx(), s, hash, "parent", 0);
  parseRecord(record("shared", { ...usage, cache_write_input_tokens: 50 }), ctx(), s, hash, "child", 0);
  assert.equal(s.events().length, 1);
  assert.equal(s.events()[0].cacheWrite, 50);
  assert.ok(s.events()[0].flags.includes("cache-write-semantics-unverified"));
  assert.equal(summarize(s.events()).total, 0); // Enrichment cannot bypass quarantine.
  parseRecord(record("new", { ...usage, cached_input_tokens: 900 }), ctx(), s, hash, "child", 1);
  assert.equal(summarize(s.events()).total, 1100);
  assert.equal(summarize(s.events()).cached, 900);
  s.close();
});

test("unknown reset transitions and future observations do not support a pace", () => {
  const now = Date.now();
  const os = interval(now - 600000);
  assert.equal(reconstruct(os.map((o, i) => i < 5 ? { ...o, reset: null } : o)).length, 2);
  assert.equal(burnRate(interval(now + 120000), now).value, null);
});


test("comparison ordering is chronological and interleaved plan cohorts are not before/after", () => {
  const { os, es, notes } = comparisonFixture();
  const backwards = comparisons([...os].reverse(), [...es].reverse(), [...notes].reverse());
  assert.equal(backwards.pairs[0].before, "plan-0");
  assert.equal(backwards.pairs[0].after, "plan-1");
  const interleaved = notes.map((a, i) => ({ ...a, label: a.kind === "plan" ? `plan-${Math.floor(i / 2) % 2}` : a.label }));
  assert.equal(comparisons(os, es, interleaved).pairs.length, 0);
});

test("legacy deltas preserve missing cache-write metadata and survive replay without conflicts", () => {
  const s = new Store(join(temp(), "unknown-cache.sqlite"));
  const missing = { ...usage } as Partial<typeof usage>;
  delete missing.cache_write_input_tokens;
  const record = { type: "event_msg", timestamp: "2026-10-15T12:00:00Z", payload: { type: "token_count", info: { total_token_usage: missing, last_token_usage: missing } } };
  parseRecord(record, ctx(), s, hash, "legacy", 0);
  parseRecord(record, ctx(), s, hash, "legacy", 0);
  assert.equal(s.events().length, 1);
  assert.equal(s.events()[0].cacheWrite, null);
  assert.equal(summarize(s.events()).fallbackTokens, 1100);
  assert.equal(summarize(s.events()).total, 0);
  assert.ok(!s.events()[0].flags.includes("response-id-conflict"));
  // Pre-update imports stored unreported cache writes as zero in their identity key.
  const oldRecord = { ...record, payload: { ...record.payload, info: { total_token_usage: usage, last_token_usage: usage } } };
  parseRecord(oldRecord, ctx(), s, hash, "legacy", 0);
  assert.equal(s.events().length, 1);
  assert.equal(s.events()[0].cacheWrite, 0);
  assert.equal(summarize(s.events()).fallbackTokens, 1100);
  const older = new Store(join(temp(), "older-cache.sqlite"));
  parseRecord(oldRecord, ctx(), older, hash, "legacy", 0);
  parseRecord(record, ctx(), older, hash, "legacy", 0);
  assert.equal(older.events().length, 1);
  assert.equal(summarize(older.events()).fallbackTokens, 1100);
  older.close();
  s.close();
});
