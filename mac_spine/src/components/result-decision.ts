import { createButton } from './button';
import { createElement } from '../utils/dom';

export interface ResultDecisionConfig {
  onSave: () => void | Promise<void>;
  onDiscard: (reason: string) => void | Promise<void>;
  requestDiscardReason: () => Promise<string | null>;
}

export function createResultDecision(config: ResultDecisionConfig): HTMLElement {
  const container = createElement('div', { className: 'result-decision' });
  const status = createElement('p', {
    className: 'result-decision__status',
    'aria-live': 'polite',
  });
  status.style.display = 'none';

  let inProgress = false;
  let decisionComplete = false;

  const saveButton = createButton({
    text: 'Save Result',
    variant: 'primary',
    fullWidth: true,
    onClick: () => {
      void handleSave();
    },
  });

  const discardButton = createButton({
    text: 'Discard Result',
    variant: 'danger',
    fullWidth: true,
    onClick: () => {
      void handleDiscard();
    },
  });

  function setInProgress(active: boolean, message = ''): void {
    inProgress = active;
    saveButton.disabled = active || decisionComplete;
    discardButton.disabled = active || decisionComplete;
    saveButton.classList.toggle('btn--disabled', saveButton.disabled);
    discardButton.classList.toggle('btn--disabled', discardButton.disabled);
    status.style.display = message ? '' : 'none';
    status.textContent = message;
  }

  function completeDecision(message: string): void {
    decisionComplete = true;
    setInProgress(false, message);
  }

  async function handleSave(): Promise<void> {
    if (inProgress || decisionComplete) return;
    setInProgress(true, 'Saving result…');

    try {
      await config.onSave();
      completeDecision('Result saved.');
    } catch (error) {
      console.error('Unable to save result:', error);
      setInProgress(false, 'Unable to save the result. Please try again.');
    }
  }

  async function handleDiscard(): Promise<void> {
    if (inProgress || decisionComplete) return;
    setInProgress(true, 'Waiting for discard confirmation…');

    try {
      const reason = await config.requestDiscardReason();
      if (reason === null) {
        setInProgress(false);
        return;
      }

      setInProgress(true, 'Discarding result…');
      await config.onDiscard(reason);
      completeDecision('Result discarded.');
    } catch (error) {
      console.error('Unable to discard result:', error);
      setInProgress(false, 'Unable to discard the result. Please try again.');
    }
  }

  container.appendChild(saveButton);
  container.appendChild(discardButton);
  container.appendChild(status);
  return container;
}

const style = document.createElement('style');
style.textContent = `
  .result-decision {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }
  .result-decision .btn + .btn {
    margin-top: 0;
  }
  .result-decision__status {
    margin: var(--space-1) 0 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    text-align: center;
  }
`;
document.head.appendChild(style);
