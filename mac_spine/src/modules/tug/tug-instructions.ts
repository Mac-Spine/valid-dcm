import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { audioManager } from '../../utils/audio';
import { getProfile } from '../../core/db';
import { TUG_INSTRUCTION_STEPS } from '../../content/assessment-instructions';
import { router } from '../../main';

export async function renderTugInstructions(container: HTMLElement): Promise<void> {
  clearContainer(container);

  const profile = await getProfile();

  // Auto-navigate to sensor check on first run (if never calibrated)
  if (!profile?.practice_completed) {
    router.navigate('#/assessment/tug_v1/practice');
    return;
  }

  // Auto-navigate to step calibration if not yet done.
  if (!profile?.tug_step_calibration) {
    router.navigate('#/assessment/tug_v1/step_calibration');
    return;
  }

  const wrapper = createElement('main', { className: 'assessment-instructions' });
  wrapper.setAttribute('role', 'main');

  const title = createElement('h1', { textContent: 'Timed Up & Go' });

  const readyBtn = createButton({
    text: "I'm Ready",
    variant: 'primary',
    fullWidth: true,
    onClick: async () => {
      audioManager.initOnGesture();
      const p = await getProfile();
      const audioEnabled = p?.preferences.audio_enabled ?? true;
      audioManager.setEnabled(audioEnabled);
      await audioManager.preloadAll();
      router.navigate('#/assessment/tug_v1/countdown');
    },
  });

  const calibrateBtn = createButton({
    text: 'Sensor Calibration',
    variant: 'secondary',
    fullWidth: true,
    onClick: () => router.navigate('#/assessment/tug_v1/practice'),
  });

  const stepCalBtn = createButton({
    text: 'Re-calibrate Step Detection',
    variant: 'secondary',
    fullWidth: true,
    onClick: () => router.navigate('#/assessment/tug_v1/step_calibration'),
  });

  const safetySection = createElement('section', {
    className: 'tug-instructions__safety',
    'aria-labelledby': 'tug-instructions-safety-title',
  });
  const safetyTitle = createElement('h2', {
    id: 'tug-instructions-safety-title',
    textContent: 'Before you begin',
  });

  const testSoundBtn = createButton({
    text: 'Test Sound',
    variant: 'secondary',
    fullWidth: true,
    onClick: async () => {
      audioManager.initOnGesture();
      const p = await getProfile();
      const audioEnabled = p?.preferences.audio_enabled ?? true;
      audioManager.setEnabled(audioEnabled);
      await audioManager.preloadAll();
      audioManager.play('beep');
    },
  });

  const volumeNote = createElement('p', {
    className: 'tug-instructions__volume-note',
    textContent:
      'Ensure your phone volume is turned up and your ringer is on. You will hear a tone at the start, a beep at 3 meters, and a tone when the test ends.',
  });
  const emergencyNote = createElement('p', {
    className: 'tug-instructions__emergency-note',
    textContent: 'An emergency stop button is always available on screen during the test.',
  });

  safetySection.appendChild(safetyTitle);
  safetySection.appendChild(volumeNote);
  safetySection.appendChild(emergencyNote);
  safetySection.appendChild(testSoundBtn);

  const divider = createElement('hr', { className: 'tug-instructions__divider' });

  const steps = createElement('div', { className: 'assessment-instructions__important' });
  const instructionList = createElement('ol', { className: 'tug-instructions__steps' });
  for (const instruction of TUG_INSTRUCTION_STEPS) {
    instructionList.appendChild(createElement('li', { textContent: instruction }));
  }
  steps.appendChild(instructionList);

  const visual = createElement('img', {
    className: 'tug-instructions__visual',
    alt: 'Five illustrated TUG test steps with the phone in a front trouser pocket: sit upright, stand at the start tone, walk until the beep, turn and walk back, then sit down',
  }) as HTMLImageElement;
  visual.src = `${import.meta.env.BASE_URL}images/tug-instructions.png`;
  visual.width = 1024;
  visual.height = 1536;

  const cancelBtn = createButton({
    text: 'Cancel',
    variant: 'text',
    onClick: () => router.navigate('#/menu'),
  });

  wrapper.appendChild(title);
  wrapper.appendChild(steps);
  wrapper.appendChild(visual);
  wrapper.appendChild(safetySection);
  wrapper.appendChild(divider);
  wrapper.appendChild(readyBtn);
  wrapper.appendChild(calibrateBtn);
  wrapper.appendChild(stepCalBtn);
  wrapper.appendChild(cancelBtn);
  container.appendChild(wrapper);
}

const style = document.createElement('style');
style.textContent = `
  .tug-instructions__safety {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-bg-secondary);
    border-radius: var(--radius-md);
    line-height: var(--line-height-relaxed);
  }
  .tug-instructions__safety h2 {
    margin: 0;
    font-size: var(--font-size-lg);
  }
  .tug-instructions__volume-note,
  .tug-instructions__emergency-note {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--color-text);
    line-height: var(--line-height-relaxed);
  }

  .tug-instructions__divider {
    border: none;
    border-top: 2px solid var(--color-secondary);
    margin: var(--space-2) 0;
  }

  .tug-instructions__steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    counter-reset: step;
  }
  .tug-instructions__steps li {
    position: relative;
    padding-left: var(--space-6);
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
  }
  .tug-instructions__steps li::before {
    content: counter(step);
    counter-increment: step;
    position: absolute;
    left: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--color-primary);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    top: 2px;
  }
  .tug-instructions__visual {
    display: block;
    width: 100%;
    max-width: 28.625rem;
    height: auto;
    margin: 0 auto;
    border-radius: var(--radius-md);
  }
`;
document.head.appendChild(style);
