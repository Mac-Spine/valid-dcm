import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { audioManager } from '../../utils/audio';
import { getProfile } from '../../core/db';
import { isScreenReaderActive } from '../../utils/device';
import {
  GRIP_INSTRUCTION_STEPS,
  GRIP_INSTRUCTION_TIPS,
} from '../../content/assessment-instructions';
import { gripSessionSetup } from './grip-setup';
import { router } from '../../main';

export function renderGripInstructions(container: HTMLElement): void {
  clearContainer(container);

  if (isScreenReaderActive()) {
    renderScreenReaderGate(container);
    return;
  }

  const wrapper = createElement('main', { className: 'assessment-instructions' });
  wrapper.setAttribute('role', 'main');

  const handAbbreviation = gripSessionSetup.hand === 'left' ? 'L' : 'R';
  const title = createElement('h1', {
    textContent: `Grip & Release Test (${handAbbreviation})`,
  });

  const practiceBtn = createButton({
    text: 'Practice',
    variant: 'secondary',
    fullWidth: true,
    onClick: async () => {
      audioManager.initOnGesture();
      const profile = await getProfile();
      const audioEnabled = profile?.preferences.audio_enabled ?? true;
      audioManager.setEnabled(audioEnabled);
      await audioManager.preloadAll();
      router.navigate('#/assessment/grip_v1/practice');
    },
  });

  const readyBtn = createButton({
    text: "I'm Ready",
    variant: 'primary',
    fullWidth: true,
    onClick: async () => {
      audioManager.initOnGesture();
      const profile = await getProfile();
      const audioEnabled = profile?.preferences.audio_enabled ?? true;
      audioManager.setEnabled(audioEnabled);
      await audioManager.preloadAll();
      router.navigate('#/assessment/grip_v1/countdown');
    },
  });

  const cancelBtn = createButton({
    text: 'Cancel',
    variant: 'text',
    onClick: () => router.navigate('#/menu'),
  });

  const actions = createElement('div', { className: 'assessment-instructions__actions' });
  actions.appendChild(readyBtn);
  actions.appendChild(practiceBtn);
  actions.appendChild(cancelBtn);

  const steps = createElement('div', { className: 'assessment-instructions__important' });
  const stepsHeading = createElement('h2', {
    className: 'grip-instructions__section-heading',
    textContent: 'Instructions',
  });
  const stepsList = createElement('ol', { className: 'grip-instructions__steps' });
  for (const step of GRIP_INSTRUCTION_STEPS) {
    stepsList.appendChild(createElement('li', { textContent: step }));
  }
  steps.appendChild(stepsHeading);
  steps.appendChild(stepsList);

  const media = createGripInstructionMedia();

  const tips = createElement('section', {
    className: 'grip-instructions__tips',
    'aria-labelledby': 'grip-instructions-tips-title',
  });
  const tipsHeading = createElement('h2', {
    className: 'grip-instructions__section-heading',
    id: 'grip-instructions-tips-title',
    textContent: 'Tips',
  });
  const tipsList = createElement('ul', { className: 'grip-instructions__tips-list' });
  for (const tip of GRIP_INSTRUCTION_TIPS) {
    tipsList.appendChild(createElement('li', { textContent: tip }));
  }
  tips.appendChild(tipsHeading);
  tips.appendChild(tipsList);

  const divider = createElement('hr', { className: 'grip-instructions__divider' });

  wrapper.appendChild(title);
  wrapper.appendChild(actions);
  wrapper.appendChild(divider);
  wrapper.appendChild(steps);
  wrapper.appendChild(media);
  wrapper.appendChild(tips);
  container.appendChild(wrapper);
}

function createGripInstructionMedia(): HTMLElement {
  const base = import.meta.env.BASE_URL;
  const container = createElement('figure', { className: 'grip-instructions__media' });
  const caption = createElement('figcaption', {
    className: 'grip-instructions__media-caption',
    textContent:
      'Demonstration of closing 3+ fingers onto the phone screen and fully opening the hand between grips.',
  });
  const fallback = createElement('img', {
    className: 'grip-instructions__fallback',
    alt: 'Hand open with fingers extended above a phone before the next grip',
  }) as HTMLImageElement;
  fallback.src = `${base}images/grip-open.png`;
  fallback.width = 256;
  fallback.height = 256;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const video = createElement('video', {
    className: 'grip-instructions__video',
    'aria-label': 'Video demonstration of the Grip and Release Test',
  }) as HTMLVideoElement;
  video.src = `${base}videos/grip-instruction.mp4`;
  video.muted = true;
  video.loop = true;
  video.autoplay = !prefersReducedMotion;
  video.playsInline = true;
  video.preload = 'auto';

  const toggle = createElement('button', {
    className: 'grip-instructions__media-toggle',
    textContent: prefersReducedMotion ? 'Play demonstration' : 'Pause demonstration',
    'aria-label': prefersReducedMotion
      ? 'Play Grip and Release demonstration'
      : 'Pause Grip and Release demonstration',
  }) as HTMLButtonElement;

  function showFallback(): void {
    video.remove();
    toggle.remove();
    if (!fallback.isConnected) container.insertBefore(fallback, caption);
  }

  video.addEventListener('error', showFallback, { once: true });
  video.addEventListener('play', () => {
    toggle.textContent = 'Pause demonstration';
    toggle.setAttribute('aria-label', 'Pause Grip and Release demonstration');
  });
  video.addEventListener('pause', () => {
    toggle.textContent = 'Play demonstration';
    toggle.setAttribute('aria-label', 'Play Grip and Release demonstration');
  });
  toggle.addEventListener('click', async () => {
    if (video.paused) {
      try {
        await video.play();
      } catch {
        showFallback();
      }
    } else {
      video.pause();
    }
  });

  container.appendChild(video);
  container.appendChild(toggle);
  container.appendChild(caption);
  if (!prefersReducedMotion) {
    video.play().catch(() => {
      toggle.textContent = 'Play demonstration';
      toggle.setAttribute('aria-label', 'Play Grip and Release demonstration');
    });
  }
  return container;
}

function renderScreenReaderGate(container: HTMLElement): void {
  const wrapper = createElement('main', { className: 'assessment-instructions' });
  wrapper.setAttribute('role', 'main');

  const msg = createElement('div', { className: 'assessment-instructions__sr-gate' });
  msg.innerHTML = `
    <h1>Accessibility Notice</h1>
    <p>This assessment requires gripping the phone with multiple fingers and is not compatible
    with screen readers. All other parts of the app — including your results, history,
    and settings — are fully accessible.</p>
  `;

  const backBtn = createButton({
    text: 'Return to Home',
    variant: 'primary',
    fullWidth: true,
    onClick: () => router.navigate('#/menu'),
  });

  wrapper.appendChild(msg);
  wrapper.appendChild(backBtn);
  container.appendChild(wrapper);
}

const style = document.createElement('style');
style.textContent = `
  .grip-instructions__divider {
    border: none;
    border-top: 2px solid var(--color-secondary);
    margin: var(--space-2) 0;
  }
  .grip-instructions__section-heading {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
    color: var(--color-text);
    margin-bottom: var(--space-3);
  }
  .grip-instructions__steps {
    list-style: decimal;
    padding-left: var(--space-6);
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .grip-instructions__steps li {
    padding-left: var(--space-2);
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
  }
  .grip-instructions__steps li::marker {
    color: var(--color-primary);
    font-weight: var(--font-weight-bold);
  }
  .grip-instructions__media {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }
  .grip-instructions__video,
  .grip-instructions__fallback {
    display: block;
    width: min(100%, 22rem);
    max-height: 24rem;
    object-fit: contain;
    border-radius: var(--radius-lg);
    background: var(--color-bg-secondary);
  }
  .grip-instructions__media-toggle {
    min-height: var(--tap-target-min);
    padding: var(--space-2) var(--space-4);
    border: 2px solid var(--color-primary);
    border-radius: var(--radius-md);
    color: var(--color-primary);
    font-weight: var(--font-weight-semibold);
    background: var(--color-bg);
  }
  .grip-instructions__media-caption {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    text-align: center;
  }
  .grip-instructions__tips {
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-bg-secondary);
  }
  .grip-instructions__tips-list {
    list-style: disc;
    padding-left: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .grip-instructions__tips-list li {
    padding-left: var(--space-1);
    line-height: var(--line-height-relaxed);
  }
`;
document.head.appendChild(style);
