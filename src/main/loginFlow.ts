import type { VerifyResult } from './usageService';

/**
 * Serializes sign-in checks: claude.ai sets cookies and navigates several
 * times during a sign-in, and each of these events asks for a check. At most
 * one check runs at a time; requests that arrive meanwhile lead to exactly one
 * more check afterwards. `onFinished` is called when a check ends the flow.
 */
export function createSerializedCheck(
  verify: () => Promise<VerifyResult>,
  onFinished: (outcome: 'ok' | 'failed') => void,
  isFinished: () => boolean,
): () => Promise<void> {
  let running = false;
  let requestedAgain = false;

  const check = async (): Promise<void> => {
    if (isFinished()) return;
    if (running) {
      requestedAgain = true;
      return;
    }
    running = true;
    try {
      const result = await verify();
      if (!isFinished()) {
        if (result === 'ok') onFinished('ok');
        else if (result === 'fail') onFinished('failed');
      }
    } catch {
      // verify() reports its own errors; an unexpected failure counts as "try again later".
    } finally {
      running = false;
    }
    if (requestedAgain && !isFinished()) {
      requestedAgain = false;
      await check();
    }
  };
  return check;
}
