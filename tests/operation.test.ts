import { test } from "node:test";
import assert from "node:assert/strict";
import { Operation, type OperationState } from "../server/operation.ts";

test("slow work is acknowledged once, retains its marker and finishes independently", async () => {
  const saved: OperationState[] = [];
  const operation = new Operation(undefined, (value) => saved.push(value));
  let finish!: (value: boolean) => void;
  let calls = 0;
  const work = () => {
    calls++;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  const first = operation.run(work);
  const id = operation.state!.id;
  assert.equal(operation.state!.state, "running");
  assert.equal(operation.run(work), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  // No dependency on client request lifetime: completion remains durable.
  finish(true);
  assert.equal(await first, true);
  assert.equal(operation.state!.id, id);
  assert.equal(operation.state!.state, "succeeded");
  assert.equal(saved.length, 2);
  await operation.run(async () => false);
  assert.notEqual(operation.state!.id, id);
  assert.equal(operation.state!.state, "failed");
});

test("restart marks unfinished work interrupted without replaying it", async () => {
  let saved: OperationState | undefined;
  const operation = new Operation(
    { id: "prior", state: "running", startedAt: 1, completedAt: null },
    (value) => {
      saved = value;
    },
  );
  assert.equal(saved?.state, "interrupted");
  assert.equal(saved?.id, "prior");
  await operation.run(() => {
    throw Error("worker startup failed");
  });
  assert.equal(operation.state?.state, "failed");
});

test("accepted operation ignores the previously displayed success until matching progress arrives", async () => {
  const { operationOutcome } = await import("../src/operations.ts");
  const requested: OperationState = {
    id: "new",
    state: "running",
    startedAt: 200,
    completedAt: null,
  };
  const old: OperationState = {
    id: "old",
    state: "succeeded",
    startedAt: 100,
    completedAt: 150,
  };
  assert.equal(operationOutcome("backup", requested, old), null);
  assert.equal(operationOutcome("backup", requested, requested), null);
  assert.match(
    operationOutcome("backup", requested, {
      ...requested,
      state: "succeeded",
      completedAt: 300,
    })!,
    /verified/,
  );
  assert.match(
    operationOutcome("backup", requested, {
      ...requested,
      state: "interrupted",
      completedAt: 300,
    })!,
    /interrupted/,
  );
});
