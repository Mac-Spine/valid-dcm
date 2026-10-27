import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { audio, addGuard } = vi.hoisted(() => ({
  audio: { initOnGesture: vi.fn(), setEnabled: vi.fn(), preloadAll: vi.fn().mockResolvedValue(undefined), play: vi.fn() },
  addGuard: vi.fn(),
}));
vi.mock('../../../../src/main', () => ({ router: { navigate: vi.fn(), addGuard } }));
vi.mock('../../../../src/utils/audio', () => ({ audioManager: audio }));
vi.mock('../../../../src/core/db', () => ({
  getProfile: vi.fn().mockResolvedValue({ practice_completed: true, preferences: { audio_enabled: true } }),
  saveProfile: vi.fn(), addAuditEntry: vi.fn(),
}));
vi.mock('../../../../src/utils/motion-permission', () => ({ requestMotionPermission: vi.fn().mockResolvedValue('granted') }));
import { renderTugStepCalibration } from '../../../../src/modules/tug/tug-step-calibration';
let leave: () => boolean;
let container: HTMLElement;
function motion() {
  const event = new Event('devicemotion');
  Object.defineProperty(event, 'accelerationIncludingGravity', { value: { x: 0, y: 9.81, z: 0 } });
  window.dispatchEvent(event);
}
async function click(text: string) {
  Array.from(container.querySelectorAll('button')).find(b => b.textContent === text)!.click();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks();
  addGuard.mockImplementation(fn => { leave = fn; return vi.fn(); });
  container = document.createElement('div'); document.body.append(container);
  await renderTugStepCalibration(container);
  await click('Start Calibration');
  await click('Start');
});
afterEach(() => { leave(); container.remove(); vi.useRealTimers(); });
describe('pocket calibration preparation', () => {
  it('waits three seconds for placement, then collects a separate baseline before GO', async () => {
    motion();
    await vi.advanceTimersByTimeAsync(3000);
    expect(audio.play).not.toHaveBeenCalledWith('go');
    motion(); motion();
    await vi.advanceTimersByTimeAsync(999);
    expect(audio.play).not.toHaveBeenCalledWith('go');
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledWith('go');
  });
  it('does not use insertion samples as the stationary baseline', async () => {
    motion(); motion();
    await vi.advanceTimersByTimeAsync(4000);
    expect(audio.play).not.toHaveBeenCalledWith('go');
    expect(container.textContent).toContain('No sensor data');
  });
  it('cancels the preparation on navigation', async () => {
    leave();
    await vi.advanceTimersByTimeAsync(4000);
    expect(audio.play).not.toHaveBeenCalledWith('go');
  });
});
