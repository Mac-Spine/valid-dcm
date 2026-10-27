import { describe, expect, it, vi } from 'vitest';
import { createResultDecision } from '../../../src/components/result-decision';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createResultDecision', () => {
  it('disables both choices and prevents duplicate saves while saving', async () => {
    const save = deferred<void>();
    const onSave = vi.fn(() => save.promise);
    const decision = createResultDecision({
      onSave,
      onDiscard: vi.fn(),
      requestDiscardReason: vi.fn(),
    });
    const [saveButton, discardButton] = decision.querySelectorAll('button');

    saveButton.click();
    saveButton.click();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveButton.disabled).toBe(true);
    expect(discardButton.disabled).toBe(true);

    save.resolve();
    await flushPromises();

    expect(decision.textContent).toContain('Result saved.');
    expect(saveButton.disabled).toBe(true);
    expect(discardButton.disabled).toBe(true);
  });

  it('restores both choices when discard confirmation is cancelled', async () => {
    const confirmation = deferred<string | null>();
    const onDiscard = vi.fn();
    const decision = createResultDecision({
      onSave: vi.fn(),
      onDiscard,
      requestDiscardReason: vi.fn(() => confirmation.promise),
    });
    const [saveButton, discardButton] = decision.querySelectorAll('button');

    discardButton.click();
    expect(saveButton.disabled).toBe(true);
    expect(discardButton.disabled).toBe(true);

    confirmation.resolve(null);
    await flushPromises();

    expect(onDiscard).not.toHaveBeenCalled();
    expect(saveButton.disabled).toBe(false);
    expect(discardButton.disabled).toBe(false);
  });

  it('passes the confirmed reason to discard and keeps both choices disabled', async () => {
    const onDiscard = vi.fn();
    const decision = createResultDecision({
      onSave: vi.fn(),
      onDiscard,
      requestDiscardReason: vi.fn(async () => 'Technical issue'),
    });
    const [saveButton, discardButton] = decision.querySelectorAll('button');

    discardButton.click();
    await flushPromises();

    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith('Technical issue');
    expect(decision.textContent).toContain('Result discarded.');
    expect(saveButton.disabled).toBe(true);
    expect(discardButton.disabled).toBe(true);
  });
});
