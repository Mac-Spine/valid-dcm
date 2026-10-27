import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { TUG_POCKET_PLACEMENT_BUFFER_MS } from '../../constants';
import { audioManager } from '../../utils/audio';
import { router } from '../../main';

/** Manual start followed by a fixed pocket-placement buffer. */
export async function renderTugCountdown(container: HTMLElement): Promise<void> {
  clearContainer(container);
  let cancelled = false;
  let starting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let gravity: { x: number; y: number; z: number } | null = null;
  const wrapper = createElement('main', { className: 'assessment-countdown' });
  wrapper.setAttribute('role', 'main');
  const prompt = createElement('div', { className: 'tug-countdown__prompt' });
  prompt.innerHTML = `
    <h2>Ready to start?</h2>
    <p>Sit with your back against the chair. Press Start, then put your phone fully inside the same front trouser pocket used during calibration.</p>
    <p>You have 3 seconds to put the phone away. Stay seated until you hear the start tone.</p>
  `;
  const status = createElement('p', { 'aria-live': 'polite', textContent: 'Press Start when ready.' });
  const motionHandler = (event: DeviceMotionEvent) => {
    const a = event.accelerationIncludingGravity;
    if (a?.x == null || a.y == null || a.z == null) return;
    if (![a.x, a.y, a.z].every(Number.isFinite)) return;
    gravity = { x: a.x, y: a.y, z: a.z };
  };
  function cleanup(): void {
    cancelled = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('devicemotion', motionHandler);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    removeGuard();
  }
  const removeGuard = router.addGuard(() => { cleanup(); return true; });
  const startBtn = createButton({
    text: 'Start', variant: 'primary', fullWidth: true,
    onClick: async () => {
      if (starting || cancelled) return;
      starting = true;
      startBtn.disabled = true;
      audioManager.initOnGesture();
      // A hidden-screen assessment requires audible cues in this phase.
      audioManager.setEnabled(true);
      await audioManager.preloadAll();
      if (cancelled) return;
      window.addEventListener('devicemotion', motionHandler);
      status.textContent = 'Put the phone in your pocket. The test starts in 3 seconds.';
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(lock => {
          if (cancelled) lock.release().catch(() => {});
          else wakeLock = lock;
        }).catch(() => {});
      }
      timer = setTimeout(() => {
        if (cancelled) return;
        if (!gravity) {
          window.removeEventListener('devicemotion', motionHandler);
          status.textContent = 'No sensor data. Enable motion sensors, then press Start to try again.';
          starting = false;
          startBtn.disabled = false;
          return;
        }
        // Use pocket orientation, not the earlier flat-surface sensor check.
        window.__tugCalibrationGravity = gravity;
        if (wakeLock) {
          (window as unknown as Record<string, unknown>).__tugWakeLock = wakeLock;
          wakeLock = null;
        }
        cleanup();
        router.navigate('#/assessment/tug_v1/active', true);
      }, TUG_POCKET_PLACEMENT_BUFFER_MS);
    },
  });
  const cancelBtn = createButton({
    text: 'Cancel', variant: 'text',
    onClick: () => { cleanup(); router.navigate('#/assessment/tug_v1/instructions'); },
  });
  wrapper.append(prompt, status, startBtn, cancelBtn);
  container.appendChild(wrapper);
}

const style = document.createElement('style');
style.textContent = `
  .tug-countdown__prompt {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  .tug-countdown__prompt h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    color: var(--color-text);
  }
  .tug-countdown__prompt p {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--color-text-secondary);
    line-height: var(--line-height-relaxed);
  }
  .tug-countdown__sub {
    font-size: var(--font-size-sm) !important;
    opacity: 0.7;
  }
  .tug-countdown__icon {
    font-size: 3rem;
    margin-bottom: var(--space-2);
  }
  .tug-countdown__status {
    margin-top: var(--space-6);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
    text-align: center;
    transition: color 0.2s;
  }
  .tug-countdown__status--active {
    color: var(--color-primary);
  }
`;
document.head.appendChild(style);
