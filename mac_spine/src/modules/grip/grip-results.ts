import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { createResultDecision } from '../../components/result-decision';
import { showDiscardDialog } from '../../components/discard-dialog';
import { getAllResults, saveResult, addAuditEntry } from '../../core/db';
import { getRhythmLabel } from './grip-metrics';
import { lastGripResult } from './grip-active';
import { router } from '../../main';
import type { AssessmentResult } from '../../types/db-schemas';

const MAX_DAILY_DISCARDS = 2;

function countTodayDiscards(results: AssessmentResult[], taskPrefix: string): number {
  const todayStr = new Date().toLocaleDateString();
  return results.filter(
    (r) =>
      r.task_type.startsWith(taskPrefix) &&
      r.status === 'discarded' &&
      new Date(r.timestamp_start).toLocaleDateString() === todayStr,
  ).length;
}

export async function renderGripResults(container: HTMLElement): Promise<void> {
  clearContainer(container);

  if (!lastGripResult) {
    router.navigate('#/menu', true);
    return;
  }

  const result = lastGripResult;
  const m = result.computed_metrics;

  const allResults = await getAllResults();
  const todayDiscards = countTodayDiscards(allResults, 'grip');
  const discardLimitReached = todayDiscards >= MAX_DAILY_DISCARDS;

  const wrapper = createElement('main', { className: 'assessment-results' });
  wrapper.setAttribute('role', 'main');

  const header = createElement('h1', {
    className: 'assessment-results__header',
    textContent: 'Test Complete!',
  });

  const metricsSection = createElement('section', { className: 'assessment-results__metrics' });

  // Grip count and frequency
  metricsSection.appendChild(
    createMetricCard(
      `You completed ${m.tap_count} grip/release cycle${m.tap_count !== 1 ? 's' : ''}`,
      `That's ${m.frequency_hz.toFixed(1)} grips per second`,
    ),
  );

  // Rhythm
  const rhythmLabel = getRhythmLabel(m.rhythm_cv);
  metricsSection.appendChild(createMetricCard('Rhythm consistency', rhythmLabel));

  // Comparison with previous grip sessions
  const previousResults = allResults
    .filter(
      (r) =>
        r.task_type.startsWith('grip') &&
        r.local_uuid !== result.local_uuid &&
        r.status === 'complete' &&
        !r.flagged,
    )
    .sort((a, b) => new Date(b.timestamp_start).getTime() - new Date(a.timestamp_start).getTime());

  if (previousResults.length >= 1) {
    const lastSession = previousResults[0];
    const lastFreq = lastSession.computed_metrics.frequency_hz;
    const change = ((m.frequency_hz - lastFreq) / lastFreq) * 100;

    let comparisonText: string;
    if (Math.abs(change) < 5) {
      comparisonText = 'About the same as last time';
    } else if (change > 0) {
      comparisonText = `That's ${Math.abs(change).toFixed(0)}% faster than last time`;
    } else {
      comparisonText = `That's ${Math.abs(change).toFixed(0)}% slower than last time`;
    }

    const comparison = createElement('div', { className: 'assessment-results__comparison' });
    comparison.textContent = comparisonText;
    metricsSection.appendChild(comparison);
  }

  // Actions — disabled until save/discard decision
  const homeBtn = createButton({
    text: 'Return to Home',
    variant: 'primary',
    fullWidth: true,
    disabled: true,
    onClick: () => router.navigate('#/menu'),
  });

  const againBtn = createButton({
    text: 'Take Test Again',
    variant: 'secondary',
    fullWidth: true,
    disabled: true,
    onClick: () => router.navigate('#/assessment/grip_v1/setup'),
  });

  const syncStatus = createElement('div', {
    className: 'assessment-results__sync',
    'aria-live': 'polite',
  });
  syncStatus.style.display = 'none';

  function enableNavigation(): void {
    homeBtn.disabled = false;
    homeBtn.classList.remove('btn--disabled');
    againBtn.disabled = false;
    againBtn.classList.remove('btn--disabled');
  }

  async function doSave(): Promise<void> {
    result.status = result.flagged ? 'flagged' : 'complete';
    await saveResult(result);
    await addAuditEntry({
      action: 'assessment_completed',
      entity_id: result.local_uuid,
      details: { task_type: 'grip_v1', grip_count: m.tap_count, decision: 'saved' },
    });
    enableNavigation();
    showSyncFeedback(syncStatus, result.local_uuid);
  }

  let discardCount = todayDiscards;

  const counter = createElement('div', {
    className: 'assessment-results__discard-counter',
    textContent: `Discards used today: ${discardCount} / ${MAX_DAILY_DISCARDS}`,
  });
  if (discardCount === 0) counter.style.display = 'none';

  async function doDiscard(reason: string): Promise<void> {
    result.status = 'discarded';
    result.flagged = true;
    result.flag_reason = reason;
    await saveResult(result);
    await addAuditEntry({
      action: 'assessment_flagged',
      entity_id: result.local_uuid,
      details: { task_type: 'grip_v1', decision: 'discarded', reason },
    });
    discardCount++;
    counter.style.display = '';
    counter.textContent = `Discards used today: ${discardCount} / ${MAX_DAILY_DISCARDS}`;
    enableNavigation();
    showSyncFeedback(syncStatus, result.local_uuid);
  }

  wrapper.appendChild(header);
  wrapper.appendChild(metricsSection);

  if (discardLimitReached) {
    // Auto-save — no decision controls
    const banner = createElement('div', {
      className: 'assessment-results__discard-limit-banner',
      textContent: `Daily discard limit reached (${MAX_DAILY_DISCARDS}/${MAX_DAILY_DISCARDS}) — session saved automatically.`,
    });
    wrapper.appendChild(banner);
    wrapper.appendChild(syncStatus);
    wrapper.appendChild(homeBtn);
    wrapper.appendChild(againBtn);
    container.appendChild(wrapper);
    await doSave();
  } else {
    wrapper.appendChild(counter);

    const decision = createResultDecision({
      onSave: doSave,
      onDiscard: doDiscard,
      requestDiscardReason: showDiscardDialog,
    });

    wrapper.appendChild(decision);
    wrapper.appendChild(syncStatus);
    wrapper.appendChild(homeBtn);
    wrapper.appendChild(againBtn);
    container.appendChild(wrapper);
  }
}

function showSyncFeedback(el: HTMLElement, localUuid: string): void {
  el.style.display = '';
  el.className = 'assessment-results__sync';

  if (!navigator.onLine) {
    el.classList.add('assessment-results__sync--offline');
    el.textContent =
      'No internet connection. Your data is saved and will sync automatically when you reconnect.';
    setTimeout(() => {
      el.classList.add('assessment-results__sync--fade-out');
      setTimeout(() => {
        el.style.display = 'none';
      }, 300);
    }, 3500);
    return;
  }

  el.textContent = 'Saved. Syncing…';
  import('../../services/sync-service')
    .then(async (mod) => {
      await mod.triggerSync();
      const { getResult } = await import('../../core/db');
      const updated = await getResult(localUuid);
      if (updated?.synced) {
        el.textContent = 'Synced!';
      } else {
        const err = mod.lastSyncError;
        el.classList.add('assessment-results__sync--error');
        el.textContent =
          err ?? 'Sync failed. Your data is saved locally — try again from the home screen.';
      }
    })
    .catch(() => {
      el.classList.add('assessment-results__sync--error');
      el.textContent = 'Sync failed. Your data is saved locally — try again from the home screen.';
    });
}

function createMetricCard(label: string, value: string): HTMLElement {
  const card = createElement('div', { className: 'assessment-results__metric-card' });
  card.appendChild(
    createElement('span', { className: 'assessment-results__metric-label', textContent: label }),
  );
  card.appendChild(
    createElement('span', { className: 'assessment-results__metric-value', textContent: value }),
  );
  return card;
}
