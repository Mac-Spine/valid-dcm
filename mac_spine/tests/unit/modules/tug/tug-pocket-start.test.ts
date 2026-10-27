import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, addGuard, audio } = vi.hoisted(() => ({
  navigate: vi.fn(),
  addGuard: vi.fn(),
  audio: { initOnGesture: vi.fn(), setEnabled: vi.fn(), preloadAll: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../../src/main', () => ({ router: { navigate, addGuard } }));
vi.mock('../../../../src/utils/audio', () => ({ audioManager: audio }));
import { renderTugCountdown } from '../../../../src/modules/tug/tug-countdown';

let leave: () => boolean;
let container: HTMLElement;
function motion() {
  const event = new Event('devicemotion');
  Object.defineProperty(event, 'accelerationIncludingGravity', { value: { x: 0, y: 9.81, z: 0 } });
  window.dispatchEvent(event);
}
async function start() {
  (Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Start')!).click();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  addGuard.mockImplementation(fn => { leave = fn; return vi.fn(); });
  container = document.createElement('div');
  document.body.append(container);
  await renderTugCountdown(container);
});
afterEach(() => {
  leave();
  container.remove();
  delete window.__tugCalibrationGravity;
  vi.useRealTimers();
});
describe('manual pocket start', () => {
  it('does not auto-start, then waits the full buffer and uses pocket gravity', async () => {
    motion();
    await vi.advanceTimersByTimeAsync(10000);
    expect(navigate).not.toHaveBeenCalled();
    await start();
    motion();
    await vi.advanceTimersByTimeAsync(2999);
    expect(navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('#/assessment/tug_v1/active', true);
    expect(window.__tugCalibrationGravity).toEqual({ x: 0, y: 9.81, z: 0 });
  });
  it('cancels pending starts on navigation', async () => {
    await start();
    motion();
    leave();
    await vi.advanceTimersByTimeAsync(4000);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('does not begin without motion data and permits retry', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('No sensor data');
    await start();
    motion();
    await vi.advanceTimersByTimeAsync(3000);
    expect(navigate).toHaveBeenCalledOnce();
  });
});
