import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { vibrate, supportsVibration } from '../../utils/device';
import { GRIP_PRACTICE_DURATION_MS, GRIP_MIN_FINGERS } from '../../constants';
import { router } from '../../main';

export function renderGripPractice(container: HTMLElement): void {
  clearContainer(container);

  const wrapper = createElement('main', { className: 'assessment-practice' });
  wrapper.setAttribute('role', 'main');

  const intro = createElement('div', { className: 'assessment-practice__intro' });
  intro.innerHTML = `
    <h1>Practice Round</h1>
    <p>Let's do a quick 5-second practice first. This won't be saved.</p>
    <p style="font-size: var(--font-size-sm); color: var(--color-text-secondary);">
      Hold the phone flat in your palm and grip with ${GRIP_MIN_FINGERS}+ fingers, then release completely.
    </p>
  `;

  const startBtn = createButton({
    text: 'Start Practice',
    variant: 'primary',
    fullWidth: true,
    onClick: () => runPractice(wrapper),
  });

  intro.appendChild(startBtn);
  wrapper.appendChild(intro);
  container.appendChild(wrapper);
}

function runPractice(wrapper: HTMLElement): void {
  clearContainer(wrapper);

  const practiceArea = createElement('div', { className: 'grip-practice__area' });

  // Counter
  const counter = createElement('div', {
    className: 'assessment-practice__counter',
    textContent: '0',
  });

  // Feedback text
  const feedback = createElement('div', {
    className: 'grip-practice__feedback',
    'aria-live': 'polite',
  });

  // Progress bar
  const progressBar = createElement('div', { className: 'assessment-practice__progress' });
  const progressFill = createElement('div', { className: 'assessment-practice__progress-fill' });
  progressBar.appendChild(progressFill);

  // Finger indicators container
  const indicatorContainer = createElement('div', { className: 'grip-practice__indicators' });

  // Finger count display
  const fingerCount = createElement('div', {
    className: 'grip-practice__finger-count',
    textContent: `Touch with ${GRIP_MIN_FINGERS}+ fingers`,
  });

  let gripCount = 0;
  let gripAchieved = false;
  let running = true;
  const activeTouches = new Map<number, HTMLElement>();
  const cancelledIds = new Set<number>();

  // Gesture prevention — set up before timer so cleanup can be referenced
  practiceArea.style.touchAction = 'none';
  practiceArea.style.userSelect = 'none';
  (practiceArea.style as unknown as Record<string, string>)['-webkit-touch-callout'] = 'none';

  // Prevent Safari multi-touch gesture interference (pinch/zoom cancels touches)
  const preventGesture = (e: Event) => e.preventDefault();
  practiceArea.addEventListener('gesturestart', preventGesture);
  practiceArea.addEventListener('gesturechange', preventGesture);
  document.addEventListener('gesturestart', preventGesture);
  document.addEventListener('gesturechange', preventGesture);

  // Lock touch-action on document during practice
  const savedDocTouchAction = document.documentElement.style.touchAction;
  const savedBodyTouchAction = document.body.style.touchAction;
  document.documentElement.style.touchAction = 'none';
  document.body.style.touchAction = 'none';

  function cleanupPractice(): void {
    document.removeEventListener('gesturestart', preventGesture);
    document.removeEventListener('gesturechange', preventGesture);
    document.documentElement.style.touchAction = savedDocTouchAction;
    document.body.style.touchAction = savedBodyTouchAction;
  }

  // Timer
  const startTime = performance.now();
  const timerInterval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / GRIP_PRACTICE_DURATION_MS, 1);
    progressFill.style.width = `${progress * 100}%`;

    if (elapsed >= GRIP_PRACTICE_DURATION_MS) {
      running = false;
      clearInterval(timerInterval);
      cleanupPractice();
      showPracticeResults(wrapper, gripCount);
    }
  }, 50);

  function clearAllCircles(): void {
    for (const [, circle] of activeTouches) {
      circle.remove();
    }
    activeTouches.clear();
    cancelledIds.clear();
    fingerCount.textContent = `Touch with ${GRIP_MIN_FINGERS} fingers`;
  }

  // Reconcile circle UI from e.touches — the authoritative list of
  // active touches on screen. Creates circles for new touches, updates
  // positions for existing ones. Cancelled circles persist until a
  // full release or new grip attempt.
  function reconcileCircles(touches: TouchList): void {
    const currentIds = new Set<number>();

    for (let i = 0; i < touches.length; i++) {
      const touch = touches[i];
      currentIds.add(touch.identifier);

      let circle = activeTouches.get(touch.identifier);
      if (!circle) {
        circle = createElement('div', { className: 'grip-practice__circle' });
        if (gripAchieved) circle.classList.add('grip-practice__circle--grip');
        indicatorContainer.appendChild(circle);
        activeTouches.set(touch.identifier, circle);
      }
      circle.style.left = `${touch.clientX}px`;
      circle.style.top = `${touch.clientY}px`;

      cancelledIds.delete(touch.identifier);
    }

    // Remove circles for touches that are gone AND not cancelled
    for (const [id, circle] of activeTouches) {
      if (!currentIds.has(id) && !cancelledIds.has(id)) {
        circle.remove();
        activeTouches.delete(id);
      }
    }

    // Update finger count
    fingerCount.textContent = activeTouches.size > 0
      ? `${activeTouches.size} finger${activeTouches.size !== 1 ? 's' : ''}`
      : `Touch with ${GRIP_MIN_FINGERS} fingers`;

    // Grip detection
    if (activeTouches.size >= GRIP_MIN_FINGERS && !gripAchieved) {
      gripAchieved = true;
      activeTouches.forEach((el) => el.classList.add('grip-practice__circle--grip'));
      feedback.textContent = 'Grip!';
      feedback.className = 'grip-practice__feedback grip-practice__feedback--grip';
      if (supportsVibration()) vibrate(10);
    }
  }

  // Touch event handlers
  const onTouchStart = (e: TouchEvent) => {
    if (!running) return;
    e.preventDefault();

    // If all existing circles are orphans from a previous cancel,
    // this is a new grip attempt — clean up before starting fresh
    if (activeTouches.size > 0 && cancelledIds.size === activeTouches.size) {
      if (gripAchieved) {
        gripCount++;
        counter.textContent = String(gripCount);
        feedback.textContent = 'Release! Good!';
        feedback.className = 'grip-practice__feedback grip-practice__feedback--release';
      }
      gripAchieved = false;
      clearAllCircles();
    }

    reconcileCircles(e.touches);
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!running) return;

    // Remove circles for lifted fingers
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const circle = activeTouches.get(touch.identifier);
      if (circle) {
        circle.remove();
        activeTouches.delete(touch.identifier);
      }
      cancelledIds.delete(touch.identifier);
    }

    // Full release — no more active touches on screen
    if (e.touches.length === 0) {
      const wasGrip = gripAchieved;
      clearAllCircles();
      if (wasGrip) {
        gripCount++;
        counter.textContent = String(gripCount);
        feedback.textContent = 'Release! Good!';
        feedback.className = 'grip-practice__feedback grip-practice__feedback--release';
      }
      gripAchieved = false;
    } else {
      fingerCount.textContent = `${activeTouches.size} finger${activeTouches.size !== 1 ? 's' : ''}`;
    }
  };

  const onTouchCancel = (e: TouchEvent) => {
    if (!running) return;
    // Mark as cancelled but keep circles — fingers are still on screen
    for (let i = 0; i < e.changedTouches.length; i++) {
      cancelledIds.add(e.changedTouches[i].identifier);
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!running) return;
    e.preventDefault();
    reconcileCircles(e.touches);
  };

  practiceArea.addEventListener('touchstart', onTouchStart, { passive: false });
  practiceArea.addEventListener('touchend', onTouchEnd, { passive: false });
  practiceArea.addEventListener('touchcancel', onTouchCancel, { passive: false });
  practiceArea.addEventListener('touchmove', onTouchMove, { passive: false });

  practiceArea.appendChild(progressBar);
  practiceArea.appendChild(counter);
  practiceArea.appendChild(fingerCount);
  practiceArea.appendChild(feedback);
  practiceArea.appendChild(indicatorContainer);
  wrapper.appendChild(practiceArea);
}

function showPracticeResults(wrapper: HTMLElement, gripCount: number): void {
  clearContainer(wrapper);

  const results = createElement('div', { className: 'assessment-practice__results' });
  results.innerHTML = `
    <h2>Great!</h2>
    <p>You completed <strong>${gripCount}</strong> grip/release cycle${gripCount !== 1 ? 's' : ''}.</p>
    <p>Ready for the real test?</p>
  `;

  const practiceAgainBtn = createButton({
    text: 'Practice Again',
    variant: 'secondary',
    fullWidth: true,
    onClick: () => renderGripPractice(wrapper.parentElement ?? wrapper),
  });

  const backBtn = createButton({
    text: 'Back to Instructions',
    variant: 'primary',
    fullWidth: true,
    onClick: () => router.navigate('#/assessment/grip_v1/instructions'),
  });

  results.appendChild(practiceAgainBtn);
  results.appendChild(backBtn);
  wrapper.appendChild(results);
}

const style = document.createElement('style');
style.textContent = `
  .grip-practice__area {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--color-bg);
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .grip-practice__indicators {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
  }
  .grip-practice__circle {
    position: fixed;
    width: 20mm;
    height: 20mm;
    border-radius: 50%;
    border: 3mm solid #7A003C;
    background: transparent;
    box-sizing: content-box;
    transform: translate(-50%, -50%);
    transition: border-color 100ms ease;
  }
  .grip-practice__circle--grip {
    border-color: var(--color-success);
  }
  .grip-practice__feedback {
    position: absolute;
    top: 45%;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
    min-height: 2rem;
    z-index: 2;
    text-align: center;
  }
  .grip-practice__feedback--grip {
    color: var(--color-success);
  }
  .grip-practice__feedback--release {
    color: var(--color-primary);
  }
  .grip-practice__finger-count {
    position: absolute;
    bottom: var(--space-12);
    font-size: var(--font-size-base);
    color: var(--color-text-secondary);
    z-index: 2;
  }
`;
document.head.appendChild(style);
