import { describe, expect, it } from 'vitest';
import { createSerializedCheck } from './loginFlow';
import type { VerifyResult } from './usageService';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(results: VerifyResult[]) {
  const outcomes: string[] = [];
  let finished = false;
  let calls = 0;
  const pending: Array<ReturnType<typeof deferred<VerifyResult>>> = [];
  const check = createSerializedCheck(
    () => {
      calls++;
      const next = deferred<VerifyResult>();
      pending.push(next);
      return next.promise;
    },
    (outcome) => {
      outcomes.push(outcome);
      finished = true;
    },
    () => finished,
  );
  const answerNext = async () => {
    const result = results.shift() ?? 'retry';
    pending.shift()?.resolve(result);
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    check,
    answerNext,
    outcomes,
    calls: () => calls,
    finish: () => {
      finished = true;
    },
  };
}

describe('createSerializedCheck', () => {
  it('finishes with ok after a successful check', async () => {
    const flow = setup(['ok']);
    const done = flow.check();
    await flow.answerNext();
    await done;
    expect(flow.outcomes).toEqual(['ok']);
  });

  it('finishes with failed when the check fails for good', async () => {
    const flow = setup(['fail']);
    const done = flow.check();
    await flow.answerNext();
    await done;
    expect(flow.outcomes).toEqual(['failed']);
  });

  it('keeps waiting after a check that should be retried', async () => {
    const flow = setup(['retry']);
    const done = flow.check();
    await flow.answerNext();
    await done;
    expect(flow.outcomes).toEqual([]);
  });

  it('runs one more check for any number of requests during a running check', async () => {
    const flow = setup(['retry', 'ok']);
    const first = flow.check();
    void flow.check();
    void flow.check();
    void flow.check();
    expect(flow.calls()).toBe(1);
    await flow.answerNext();
    expect(flow.calls()).toBe(2);
    await flow.answerNext();
    await first;
    expect(flow.calls()).toBe(2);
    expect(flow.outcomes).toEqual(['ok']);
  });

  it('does not report a result when the window was closed during the check', async () => {
    const flow = setup(['ok']);
    const done = flow.check();
    flow.finish();
    await flow.answerNext();
    await done;
    expect(flow.outcomes).toEqual([]);
  });

  it('does not start checks after the flow has finished', async () => {
    const flow = setup([]);
    flow.finish();
    await flow.check();
    expect(flow.calls()).toBe(0);
  });

  it('survives a check that throws', async () => {
    let calls = 0;
    const outcomes: string[] = [];
    const check = createSerializedCheck(
      async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
      (outcome) => outcomes.push(outcome),
      () => outcomes.length > 0,
    );
    await check();
    await check();
    expect(outcomes).toEqual(['ok']);
  });
});
