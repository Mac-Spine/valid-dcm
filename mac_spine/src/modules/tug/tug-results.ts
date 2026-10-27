import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { createResultDecision } from '../../components/result-decision';
import { showDiscardDialog } from '../../components/discard-dialog';
import { getAllResults, saveResult, addAuditEntry } from '../../core/db';
import { WALKING_AID_LABELS } from './tug-types';
import { lastTugResult } from './tug-active';
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

export async function renderTugResults(container: HTMLElement): Promise<void> {
  clearContainer(container);

  if (!lastTugResult) {
    router.navigate('#/menu', true);
    return;
  }

  const result = lastTugResult;
  const m = result.computed_metrics;
  const timeS = m.tug_time_s;

  // Release wake lock if still held
  const wl = (window as unknown as Record<string, unknown>).__tugWakeLock as
    | WakeLockSentinel
    | undefined;
  if (wl) {
    wl.release().catch(() => {});
    delete (window as unknown as Record<string, unknown>).__tugWakeLock;
  }

  const wrapper = createElement('main', { className: 'assessment-results' });
  wrapper.setAttribute('role', 'main');

  const header = createElement('h1', {
    className: 'assessment-results__header',
    textContent: 'Test Complete!',
  });

  const metricsSection = createElement('section', { className: 'assessment-results__metrics' });

  // ── Headline time ────────────────────────────────────────────
  const headline = createElement('div', { className: 'tug-results__headline' });
  const timeBig = createElement('span', {
    className: 'tug-results__time-big',
    textContent: `${timeS.toFixed(1)}s`,
  });
  headline.appendChild(
    createElement('span', {
      className: 'tug-results__label',
      textContent: 'Your TUG time',
    }),
  );
  headline.appendChild(timeBig);
  metricsSection.appendChild(headline);

  // Walking aid
  const walkingAid = result.session_metadata.walking_aid ?? 'none';
  metricsSection.appendChild(
    createMetricCard('Walking aid', WALKING_AID_LABELS[walkingAid] ?? walkingAid),
  );

  // Flagged warning
  if (result.flagged) {
    const flagCard = createElement('div', { className: 'tug-results__flag-warning' });
    flagCard.textContent = result.flag_reason ?? 'This result has been flagged';
    metricsSection.appendChild(flagCard);
  }

  // ── Participant-facing gait measurements ─────────────────────
  const gaitSection = createElement('section', { className: 'tug-results__phase-section' });
  gaitSection.appendChild(
    createElement('h2', {
      className: 'tug-results__section-title',
      textContent: 'Gait measurements',
    }),
  );
  const gaitGrid = createElement('div', { className: 'tug-results__gait-grid' });
  gaitGrid.appendChild(
    createMetricCard(
      'Time to first step',
      m.time_to_first_step_ms === undefined
        ? '—'
        : `${(m.time_to_first_step_ms / 1000).toFixed(1)}s`,
    ),
  );
  gaitGrid.appendChild(
    createMetricCard(
      'Gait speed',
      m.walk_out_gait_speed_mps === undefined ? '—' : `${m.walk_out_gait_speed_mps.toFixed(2)} m/s`,
    ),
  );
  gaitGrid.appendChild(
    createMetricCard(
      'Average stride length',
      m.walk_out_avg_stride_length_m === undefined
        ? '—'
        : `${m.walk_out_avg_stride_length_m.toFixed(2)} m`,
    ),
  );
  gaitGrid.appendChild(createMetricCard('Number of steps', String(m.walk_out_steps ?? 0)));
  gaitSection.appendChild(gaitGrid);
  metricsSection.appendChild(gaitSection);

  // ── Comparison with previous TUG sessions ────────────────────
  const allResults = await getAllResults();
  const todayDiscards = countTodayDiscards(allResults, 'tug');
  const discardLimitReached = todayDiscards >= MAX_DAILY_DISCARDS;

  const previousResults = allResults
    .filter(
      (r) =>
        r.task_type.startsWith('tug') &&
        r.local_uuid !== result.local_uuid &&
        r.status === 'complete' &&
        !r.flagged,
    )
    .sort((a, b) => new Date(b.timestamp_start).getTime() - new Date(a.timestamp_start).getTime());

  if (previousResults.length >= 1) {
    const lastSession = previousResults[0];
    const lastTime = lastSession.computed_metrics.tug_time_s;
    const change = ((timeS - lastTime) / lastTime) * 100;

    let comparisonText: string;
    if (Math.abs(change) < 5) {
      comparisonText = 'About the same as last time';
    } else if (change < 0) {
      comparisonText = `${Math.abs(change).toFixed(0)}% faster than last time`;
    } else {
      comparisonText = `${Math.abs(change).toFixed(0)}% slower than last time`;
    }

    const comparison = createElement('div', { className: 'assessment-results__comparison' });
    comparison.textContent = comparisonText;
    metricsSection.appendChild(comparison);
  }

  // Actions
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
    onClick: () => router.navigate('#/assessment/tug_v1/setup'),
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
      details: { task_type: 'tug_v1', tug_time_s: m.tug_time_s, decision: 'saved' },
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
      details: { task_type: 'tug_v1', decision: 'discarded', reason },
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

const style = document.createElement('style');
style.textContent = `
  .tug-results__headline {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-bg-secondary);
  }
  .tug-results__label {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: var(--font-weight-semibold);
  }
  .tug-results__time-big {
    font-size: clamp(2.5rem, 10vw, 4rem);
    font-weight: var(--font-weight-bold);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .tug-results__flag-warning {
    padding: var(--space-3) var(--space-4);
    background: #FEF5E5;
    border: 1px solid #FDBF57;
    border-radius: var(--radius-md);
    text-align: center;
    color: #8B6914;
    font-weight: var(--font-weight-medium);
    font-size: var(--font-size-sm);
  }
  .tug-results__phase-section {
    margin-top: var(--space-4);
  }
  .tug-results__section-title {
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
    margin: 0 0 var(--space-2) 0;
  }
  .tug-results__gait-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }
  .tug-results__gait-grid .assessment-results__metric-card {
    padding: var(--space-2) var(--space-3);
  }
  .tug-results__gait-grid .assessment-results__metric-value {
    font-size: var(--font-size-base);
  }
  @media (max-width: 22rem) {
    .tug-results__gait-grid {
      grid-template-columns: 1fr;
    }
  }
`;
document.head.appendChild(style);
