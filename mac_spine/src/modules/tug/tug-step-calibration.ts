import { clearContainer, createElement } from '../../utils/dom';
import { createButton } from '../../components/button';
import { audioManager } from '../../utils/audio';
import { vibrate, supportsVibration } from '../../utils/device';
import { getProfile, saveProfile, addAuditEntry } from '../../core/db';
import { requestMotionPermission } from '../../utils/motion-permission';
import {
  APP_VERSION,
  TUG_STEP_CAL_EXPECTED_STEPS,
  TUG_STEP_CAL_PREP_COUNTDOWN_MS,
  TUG_TEMPLATE_DT_MS,
  TUG_TEMPLATE_MIN_BATCHES,
  TUG_TEMPLATE_MAX_BATCHES,
  TUG_TEMPLATE_CONVERGENCE_DELTA,
  TUG_TEMPLATE_TARGET_STEPS,
  TUG_TEMPLATE_SOFT_ALLOW_STEPS,
  TUG_CAL_BASELINE_WINDOW_MS,
  TUG_CAL_STILLNESS_WINDOW_MS,
  TUG_CAL_WALK_ON_RATIO,
  TUG_CAL_WALK_OFF_RATIO,
  TUG_CAL_TRIM_PAD_MS,
} from '../../constants';
import {
  type Vec3,
  lowPassFilter,
  decomposeAcceleration,
} from './tug-signal-processing';
import {
  type VerticalSample,
  type TroughPair,
  processBatch,
  findTroughPairs,
  trailingStd,
  trimToWalkingRegion,
} from './tug-template';
import { TUG_CONFIG } from './tug-types';
import type { TugStepCalibration } from '../../types/db-schemas';
import { router } from '../../main';

type Stage = 'intro' | 'capture' | 'batch-review' | 'batch-empty';

interface BatchSnapshot {
  samples: VerticalSample[];        // trimmed walking region of this batch
  detectedPairs: TroughPair[];      // all W's found
  acceptedPairs: TroughPair[];      // merged into template
  rejectedPairs: TroughPair[];      // candidates dropped as outliers vs prior template
  delta: number | null;             // L2 change vs prior template (null on batch 1)
  totalSteps: number;
  correlationFloor: number;
  meanStride: number;
  meanStepTimeMs: number;
}

interface EmptyBatch {
  samples: VerticalSample[];
}

export async function renderTugStepCalibration(container: HTMLElement): Promise<void> {
  clearContainer(container);

  const profile = await getProfile();
  if (!profile) {
    router.navigate('#/splash', true);
    return;
  }

  // First-run gate: sensor permission/practice must be completed first.
  if (!profile.practice_completed) {
    router.navigate('#/assessment/tug_v1/practice', true);
    return;
  }

  audioManager.initOnGesture();
  audioManager.setEnabled(profile.preferences.audio_enabled ?? true);
  await audioManager.preloadAll();

  let stage: Stage = 'intro';
  let template: number[] = [];
  let windowPool: number[][] = [];
  let stridePool: number[] = [];
  let stepTimePool: number[] = [];
  const batches: BatchSnapshot[] = [];
  let emptyBatch: EmptyBatch | null = null;
  let lastCorrelationFloor = 0;

  const wrapper = createElement('main', { className: 'tug-stepcal' });
  wrapper.setAttribute('role', 'main');
  container.appendChild(wrapper);

  function render(): void {
    clearContainer(wrapper);
    switch (stage) {
      case 'intro': renderIntro(); break;
      case 'capture': renderCaptureScreen(); break;
      case 'batch-review': renderBatchReview(); break;
      case 'batch-empty': renderBatchEmpty(); break;
    }
  }

  function renderIntro(): void {
    wrapper.appendChild(createElement('h1', { textContent: 'Walking Calibration' }));
    wrapper.appendChild(elFromHTML(`
      <div class="tug-stepcal__body">
        <p>To conduct the test, we must first calibrate the phone's step-detection feature.</p>
        <p>Click <strong>Start Calibration</strong> to begin.</p>
      </div>
    `));

    wrapper.appendChild(createButton({
      text: 'Start Calibration',
      variant: 'primary',
      fullWidth: true,
      onClick: async () => {
        const perm = await requestMotionPermission();
        if (perm !== 'granted') {
          alert('Motion sensor permission is required to calibrate.');
          return;
        }
        stage = 'capture';
        render();
      },
    }));

    wrapper.appendChild(createButton({
      text: 'Cancel',
      variant: 'text',
      onClick: () => router.navigate('#/menu'),
    }));
  }

  function renderCaptureScreen(): void {
    const batchNum = batches.length + 1;
    appendSetHeading(batchNum);

    const instructions = createElement('ol', { className: 'tug-stepcal__instructions' });
    const instructionCopy = [
      'Place your phone fully inside a front trouser pocket as shown below. Use the same pocket during calibration and the TUG test.',
      `Press Start, put the phone in your pocket within 3 seconds, then remain still until the tone. At the tone, walk ${TUG_STEP_CAL_EXPECTED_STEPS} steps forward.`,
      'Remain still while the app checks the recording.',
      `If more information is needed, the app will ask you to walk another ${TUG_STEP_CAL_EXPECTED_STEPS} steps, repeating until the app has collected enough information.`,
    ];
    for (const instruction of instructionCopy) {
      instructions.appendChild(createElement('li', { textContent: instruction }));
    }
    wrapper.appendChild(instructions);

    const base = import.meta.env.BASE_URL;
    const placementImage = createElement('img', {
      className: 'tug-stepcal__placement-image',
      alt: 'Person walking and then standing still with a smartphone in a front trouser pocket for TUG calibration',
    }) as HTMLImageElement;
    placementImage.src = `${base}images/tug-calibration.png`;
    placementImage.width = 1091;
    placementImage.height = 1441;
    wrapper.appendChild(placementImage);

    const status = createElement('div', { className: 'tug-stepcal__status', textContent: 'Ready when you are.' });
    wrapper.appendChild(status);

    const goFlash = createElement('div', { className: 'tug-stepcal__go-flash', textContent: 'GO!' });
    goFlash.style.display = 'none';
    wrapper.appendChild(goFlash);

    let phase: 'idle' | 'placement' | 'baseline' | 'recording' = 'idle';
    let gravity: Vec3 = { x: 0, y: 0, z: 9.81 };
    let recordStartT = 0;
    let baselineStartT = 0;
    let baselineSamples: VerticalSample[] = [];
    let samples: VerticalSample[] = [];
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    let walkingDetected = false;
    let stillSince: number | null = null;

    const motionHandler = (ev: DeviceMotionEvent) => {
      const a = ev.accelerationIncludingGravity;
      if (a?.x == null || a.y == null || a.z == null) return;
      if (![a.x, a.y, a.z].every(Number.isFinite)) return;
      const accelRaw: Vec3 = { x: a.x, y: a.y, z: a.z };
      if (phase === 'baseline' && baselineSamples.length === 0) {
        gravity = { ...accelRaw };
      }
      gravity = lowPassFilter(accelRaw, gravity, TUG_CONFIG.gravityFilterAlpha);
      const dec = decomposeAcceleration(accelRaw, gravity);

      if (phase === 'baseline') {
        const t = performance.now() - baselineStartT;
        baselineSamples.push({ t, vertical: dec.vertical });
        return;
      }
      if (phase !== 'recording') return;

      const t = performance.now() - recordStartT;
      samples.push({ t, vertical: dec.vertical });

      // Auto-terminate: compare trailing std to baseline.
      const baseStd = computeBaselineStd(baselineSamples);
      if (baseStd <= 0) return;
      const win = TUG_CAL_STILLNESS_WINDOW_MS;
      const trailing = trailingStd(samples, samples.length - 1, win);
      if (!walkingDetected) {
        if (trailing >= TUG_CAL_WALK_ON_RATIO * baseStd) walkingDetected = true;
      } else {
        if (trailing < TUG_CAL_WALK_OFF_RATIO * baseStd) {
          if (stillSince === null) stillSince = t;
          if (t - stillSince >= TUG_CAL_STILLNESS_WINDOW_MS) {
            finishBatch(false);
          }
        } else {
          stillSince = null;
        }
      }
    };

    const removeCaptureGuard = router.addGuard(() => { cleanup(); return true; });

    function cleanup(): void {
      removeCaptureGuard();
      window.removeEventListener('devicemotion', motionHandler);
      if (countdownTimer) clearInterval(countdownTimer);
    }

    function flashGo(): void {
      audioManager.play('go');
      goFlash.style.display = 'flex';
      setTimeout(() => { goFlash.style.display = 'none'; }, 600);
    }

    function finishBatch(_manualStop: boolean): void {
      if (phase !== 'recording') return;
      phase = 'idle';
      cleanup();

      // Always cue end-of-batch — even if nothing usable was captured.
      audioManager.play('end');
      if (supportsVibration()) vibrate(80);

      const baseStd = computeBaselineStd(baselineSamples);
      const trimmed = baseStd > 0
        ? trimToWalkingRegion(samples, baseStd, {
          windowMs: TUG_CAL_STILLNESS_WINDOW_MS,
          walkOnRatio: TUG_CAL_WALK_ON_RATIO,
          walkOffRatio: TUG_CAL_WALK_OFF_RATIO,
          padMs: TUG_CAL_TRIM_PAD_MS,
        })
        : samples;

      const prev = template.length > 0 ? template : null;
      const res = processBatch(trimmed, windowPool, stridePool, stepTimePool, prev, lastCorrelationFloor);

      if (res.acceptedPairs.length === 0) {
        // Nothing usable — don't count this attempt against batch totals.
        emptyBatch = { samples: trimmed };
        stage = 'batch-empty';
        render();
        return;
      }

      template = res.template;
      lastCorrelationFloor = res.correlationFloor;
      batches.push({
        samples: trimmed,
        detectedPairs: res.detectedPairs,
        acceptedPairs: res.acceptedPairs,
        rejectedPairs: res.rejectedPairs,
        delta: res.delta,
        totalSteps: res.totalSteps,
        correlationFloor: res.correlationFloor,
        meanStride: res.meanStride,
        meanStepTimeMs: res.meanStepTimeMs,
      });
      stage = 'batch-review';
      render();
    }

    const startBtn = createButton({
      text: 'Start',
      variant: 'primary',
      fullWidth: true,
      onClick: async () => {
        startBtn.disabled = true;
        audioManager.initOnGesture();
        audioManager.setEnabled(true);
        await audioManager.preloadAll();
        if (!wrapper.isConnected) return;
        startBtn.classList.add('btn--disabled');

        phase = 'placement';
        baselineSamples = [];
        samples = [];
        walkingDetected = false;
        stillSince = null;
        window.addEventListener('devicemotion', motionHandler);

        status.textContent = 'Put the phone in your pocket within 3 seconds, then remain still until the walking tone.';
        countdownTimer = setTimeout(() => {
          phase = 'baseline';
          baselineSamples = [];
          baselineStartT = performance.now();
          status.textContent = 'Remain still. Waiting to start walking calibration...';
          countdownTimer = setTimeout(() => {
            if (baselineSamples.length < 2) {
              phase = 'idle';
              window.removeEventListener('devicemotion', motionHandler);
              status.textContent = 'No sensor data. Enable motion sensors, then press Start to try again.';
              startBtn.disabled = false;
              startBtn.classList.remove('btn--disabled');
              return;
            }
            phase = 'recording';
            recordStartT = performance.now();
            status.textContent = `Walk ${TUG_STEP_CAL_EXPECTED_STEPS} steps, then stand still`;
            flashGo();
            stopBtn.disabled = false;
            stopBtn.classList.remove('btn--disabled');
          }, TUG_CAL_BASELINE_WINDOW_MS);
        }, TUG_STEP_CAL_PREP_COUNTDOWN_MS);
      },
    });

    const stopBtn = createButton({
      text: 'Stop',
      variant: 'secondary',
      fullWidth: true,
      disabled: true,
      onClick: () => finishBatch(true),
    });

    wrapper.appendChild(startBtn);
    wrapper.appendChild(stopBtn);
  }

  function renderBatchEmpty(): void {
    if (!emptyBatch) { stage = 'capture'; render(); return; }
    const batchNum = batches.length + 1;
    const progressPct = Math.round(
      100 * Math.min(1, windowPool.length / TUG_TEMPLATE_TARGET_STEPS),
    );
    appendSetHeading(batchNum);
    appendCalibrationSummary({
      stepsDetected: 0,
      progressPct,
      outcome: 'retry',
      message: `Let's try again. Walk ${TUG_STEP_CAL_EXPECTED_STEPS} more steps, then remain still.`,
    });
    wrapper.appendChild(createButton({
      text: `Try set ${batches.length + 1} again`,
      variant: 'primary',
      fullWidth: true,
      onClick: () => { emptyBatch = null; stage = 'capture'; render(); },
    }));
    if (batches.length >= TUG_TEMPLATE_MIN_BATCHES && windowPool.length >= TUG_TEMPLATE_SOFT_ALLOW_STEPS) {
      wrapper.appendChild(createButton({
        text: 'Save with what we have',
        variant: 'secondary',
        fullWidth: true,
        onClick: saveAndExit,
      }));
    }
    wrapper.appendChild(createButton({
      text: 'Restart',
      variant: 'text',
      onClick: () => {
        template = [];
        windowPool = [];
        stridePool = [];
        stepTimePool = [];
        batches.length = 0;
        emptyBatch = null;
        lastCorrelationFloor = 0;
        stage = 'capture';
        render();
      },
    }));
  }

  function computeBaselineStd(baseline: VerticalSample[]): number {
    if (baseline.length < 4) return 0;
    // Use only the last TUG_CAL_BASELINE_WINDOW_MS of countdown.
    const endT = baseline[baseline.length - 1].t;
    const window = baseline.filter((s) => endT - s.t <= TUG_CAL_BASELINE_WINDOW_MS);
    if (window.length < 4) return 0;
    let sum = 0;
    let sumSq = 0;
    for (const s of window) { sum += s.vertical; sumSq += s.vertical * s.vertical; }
    const n = window.length;
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    return Math.sqrt(variance);
  }

  function renderBatchReview(): void {
    const last = batches[batches.length - 1];
    const batchNum = batches.length;
    appendSetHeading(batchNum);

    // Stopping gates
    const converged = last.delta !== null && last.delta <= TUG_TEMPLATE_CONVERGENCE_DELTA;
    const totalAccepted = windowPool.length;
    const reachedTarget = totalAccepted >= TUG_TEMPLATE_TARGET_STEPS && batches.length >= TUG_TEMPLATE_MIN_BATCHES;
    const softAllow = totalAccepted >= TUG_TEMPLATE_SOFT_ALLOW_STEPS && batches.length >= TUG_TEMPLATE_MIN_BATCHES;
    const mustSave = batches.length >= TUG_TEMPLATE_MAX_BATCHES;

    // Participant-facing progress only. Internal convergence and stopping gates
    // above remain the authority for deciding which actions are available.
    const totalProgressPct = Math.round(100 * Math.min(1, totalAccepted / TUG_TEMPLATE_TARGET_STEPS));
    const isComplete = mustSave || (reachedTarget && converged);
    appendCalibrationSummary({
      stepsDetected: last.acceptedPairs.length,
      progressPct: totalProgressPct,
      outcome: isComplete ? 'success' : 'retry',
      message: isComplete
        ? 'Calibration complete. Your phone is ready for the test.'
        : `Let's try again. Walk ${TUG_STEP_CAL_EXPECTED_STEPS} more steps, then remain still.`,
    });

    // Buttons — three-state stopping
    if (mustSave) {
      wrapper.appendChild(createButton({
        text: 'Save calibration',
        variant: 'primary',
        fullWidth: true,
        onClick: saveAndExit,
      }));
    } else if (reachedTarget && converged) {
      wrapper.appendChild(createButton({
        text: 'Save calibration',
        variant: 'primary',
        fullWidth: true,
        onClick: saveAndExit,
      }));
      wrapper.appendChild(createButton({
        text: `Walk ${TUG_STEP_CAL_EXPECTED_STEPS} more steps`,
        variant: 'secondary',
        fullWidth: true,
        onClick: () => { stage = 'capture'; render(); },
      }));
    } else if (softAllow) {
      wrapper.appendChild(createButton({
        text: `Walk ${TUG_STEP_CAL_EXPECTED_STEPS} more steps`,
        variant: 'primary',
        fullWidth: true,
        onClick: () => { stage = 'capture'; render(); },
      }));
      wrapper.appendChild(createButton({
        text: 'Save with what we have',
        variant: 'secondary',
        fullWidth: true,
        onClick: saveAndExit,
      }));
    } else {
      wrapper.appendChild(createButton({
        text: `Walk ${TUG_STEP_CAL_EXPECTED_STEPS} more steps`,
        variant: 'primary',
        fullWidth: true,
        onClick: () => { stage = 'capture'; render(); },
      }));
    }

    wrapper.appendChild(createButton({
      text: 'Restart',
      variant: 'text',
      onClick: () => {
        template = [];
        windowPool = [];
        stridePool = [];
        stepTimePool = [];
        batches.length = 0;
        lastCorrelationFloor = 0;
        stage = 'capture';
        render();
      },
    }));
  }

  function appendCalibrationSummary(config: {
    stepsDetected: number;
    progressPct: number;
    outcome: 'success' | 'retry';
    message: string;
  }): void {
    const summary = createElement('section', {
      className: `tug-stepcal__summary tug-stepcal__summary--${config.outcome}`,
      role: 'status',
      'aria-live': 'polite',
    });

    const icon = createElement('span', {
      className: 'tug-stepcal__summary-icon',
      textContent: config.outcome === 'success' ? '✓' : '↻',
      'aria-hidden': 'true',
    });
    const message = createElement('p', {
      className: 'tug-stepcal__summary-message',
      textContent: config.message,
    });
    const details = createElement('dl', { className: 'tug-stepcal__summary-details' });
    details.innerHTML = `
      <div>
        <dt>Steps detected</dt>
        <dd>${config.stepsDetected} of ${TUG_STEP_CAL_EXPECTED_STEPS}</dd>
      </div>
      <div>
        <dt>Calibration progress</dt>
        <dd>${config.progressPct}%</dd>
      </div>
    `;

    const progress = createElement('div', {
      className: 'tug-stepcal__progress',
      role: 'progressbar',
      'aria-label': 'Calibration progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(config.progressPct),
    });
    const progressFill = createElement('div', { className: 'tug-stepcal__progress-fill' });
    progressFill.style.width = `${config.progressPct}%`;
    progress.appendChild(progressFill);

    summary.appendChild(icon);
    summary.appendChild(message);
    summary.appendChild(details);
    summary.appendChild(progress);
    wrapper.appendChild(summary);
  }

  function appendSetHeading(batchNum: number): void {
    const heading = createElement('h1', { className: 'tug-stepcal__set-heading' });
    heading.appendChild(createElement('span', {
      className: 'tug-stepcal__set-label',
      textContent: `Set ${batchNum}`,
    }));
    heading.append(' - Walking Calibration');
    wrapper.appendChild(heading);
  }

  async function saveAndExit(): Promise<void> {
    if (template.length === 0 || batches.length === 0) return;
    const last = batches[batches.length - 1];
    const detectionHistory = batches.map(
      (b) => Math.round(100 * b.acceptedPairs.length / TUG_STEP_CAL_EXPECTED_STEPS) / 100,
    );
    const cal: TugStepCalibration = {
      placement: 'front_trouser_pocket',
      template: template.map((x) => Math.round(x * 1e4) / 1e4),
      template_dt_ms: TUG_TEMPLATE_DT_MS,
      correlation_floor: Math.round(last.correlationFloor * 1e4) / 1e4,
      n_steps_used: last.totalSteps,
      n_batches: batches.length,
      final_delta: last.delta,
      avg_stride_length_m: Math.round(last.meanStride * 1e3) / 1e3,
      avg_step_time_ms: Math.round(last.meanStepTimeMs),
      detection_rate_history: detectionHistory,
      calibrated_at: new Date().toISOString(),
      app_version: APP_VERSION,
    };
    const p = await getProfile();
    if (!p) return;
    p.tug_step_calibration = cal;
    p.updated_at = new Date().toISOString();
    await saveProfile(p);
    await addAuditEntry({
      action: 'tug_step_calibration_saved',
      entity_id: p.participant_id,
      details: {
        correlation_floor: cal.correlation_floor,
        n_steps_used: cal.n_steps_used,
        n_batches: cal.n_batches,
        final_delta: cal.final_delta,
        template_dt_ms: cal.template_dt_ms,
        avg_stride_length_m: cal.avg_stride_length_m,
        avg_step_time_ms: cal.avg_step_time_ms,
      },
    });
    router.navigate('#/assessment/tug_v1/instructions');
  }

  render();
}

// ─────────────────────────────────────────────────────────── visualisation

function buildSparkline(samples: VerticalSample[], pairs: TroughPair[]): HTMLElement {
  const W = 320;
  const H = 140;
  const PAD_X = 4;
  const PAD_Y = 8;

  const wrap = document.createElement('div');
  wrap.className = 'tug-stepcal__spark';

  if (samples.length < 2) {
    wrap.textContent = 'No signal recorded.';
    return wrap;
  }

  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const dt = Math.max(1, t1 - t0);

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of samples) {
    if (s.vertical < vMin) vMin = s.vertical;
    if (s.vertical > vMax) vMax = s.vertical;
  }
  const vSpan = Math.max(0.5, vMax - vMin);

  const xOf = (t: number) => PAD_X + ((t - t0) / dt) * (W - 2 * PAD_X);
  const yOf = (v: number) => PAD_Y + (1 - (v - vMin) / vSpan) * (H - 2 * PAD_Y);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'tug-stepcal__spark-svg');

  // Highlight detected W-pair regions in the background.
  for (const p of pairs) {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(xOf(p.t1)));
    rect.setAttribute('y', String(PAD_Y));
    rect.setAttribute('width', String(Math.max(2, xOf(p.t2) - xOf(p.t1))));
    rect.setAttribute('height', String(H - 2 * PAD_Y));
    rect.setAttribute('class', 'tug-stepcal__spark-pair');
    svg.appendChild(rect);
  }

  const poly = document.createElementNS(ns, 'polyline');
  const pts: string[] = [];
  for (const s of samples) pts.push(`${xOf(s.t).toFixed(1)},${yOf(s.vertical).toFixed(1)}`);
  poly.setAttribute('points', pts.join(' '));
  poly.setAttribute('class', 'tug-stepcal__spark-line');
  svg.appendChild(poly);

  // Dots at each trough of each pair.
  for (const p of pairs) {
    for (const tT of [p.t1, p.t2]) {
      let nearest = samples[0];
      let bestDt = Math.abs(samples[0].t - tT);
      for (const s of samples) {
        const d = Math.abs(s.t - tT);
        if (d < bestDt) { bestDt = d; nearest = s; }
      }
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(xOf(nearest.t)));
      dot.setAttribute('cy', String(yOf(nearest.vertical)));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', 'tug-stepcal__spark-dot');
      svg.appendChild(dot);
    }
  }

  wrap.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'tug-stepcal__spark-legend';
  legend.textContent = `${(dt / 1000).toFixed(1)} s of recording • ${pairs.length} W-pairs detected`;
  wrap.appendChild(legend);

  return wrap;
}

function buildTemplatePreview(template: number[]): HTMLElement {
  const W = 200;
  const H = 80;
  const PAD = 4;
  const wrap = document.createElement('div');
  wrap.className = 'tug-stepcal__template';

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const x of template) {
    if (x < vMin) vMin = x;
    if (x > vMax) vMax = x;
  }
  const span = Math.max(0.01, vMax - vMin);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'tug-stepcal__template-svg');

  const poly = document.createElementNS(ns, 'polyline');
  const pts: string[] = [];
  for (let i = 0; i < template.length; i++) {
    const x = PAD + (i / (template.length - 1)) * (W - 2 * PAD);
    const y = PAD + (1 - (template[i] - vMin) / span) * (H - 2 * PAD);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  poly.setAttribute('points', pts.join(' '));
  poly.setAttribute('class', 'tug-stepcal__template-line');
  svg.appendChild(poly);

  wrap.appendChild(svg);
  return wrap;
}

// Keep `findTroughPairs` reachable for any external debug; suppress unused warn.
void findTroughPairs;
// Keep the technical renderers available for a future explicitly gated debug
// view; they are intentionally omitted from the participant-facing screens.
void buildSparkline;
void buildTemplatePreview;

function elFromHTML(html: string): HTMLElement {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html.trim();
  return tmpl.content.firstElementChild as HTMLElement;
}

const style = document.createElement('style');
style.textContent = `
  .tug-stepcal {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    padding-bottom: calc(var(--space-8) + var(--safe-area-bottom));
    max-width: 30rem;
    margin: 0 auto;
  }
  .tug-stepcal h1 {
    font-size: var(--font-size-xl);
    margin: 0;
  }
  .tug-stepcal__set-label {
    color: var(--color-primary);
    font-size: 1.05em;
    font-weight: var(--font-weight-bold);
  }
  .tug-stepcal__body p,
  .tug-stepcal p {
    margin: 0;
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
  }
  .tug-stepcal__body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .tug-stepcal__instructions {
    list-style: decimal;
    padding-left: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    line-height: var(--line-height-relaxed);
  }
  .tug-stepcal__instructions li {
    padding-left: var(--space-2);
  }
  .tug-stepcal__instructions li::marker {
    color: var(--color-primary);
    font-weight: var(--font-weight-bold);
  }
  .tug-stepcal__placement-image {
    display: block;
    width: min(100%, 18rem);
    height: auto;
    margin: var(--space-2) auto;
    border-radius: var(--radius-lg);
  }
  .tug-stepcal__note {
    background: var(--color-bg-secondary);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
  }
  .tug-stepcal__status {
    text-align: center;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-primary);
    margin: var(--space-3) 0;
  }
  .tug-stepcal__go-flash {
    position: fixed;
    inset: 0;
    background: var(--color-primary);
    color: #fff;
    font-size: clamp(4rem, 20vw, 10rem);
    font-weight: var(--font-weight-bold);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    pointer-events: none;
  }
  .tug-stepcal__summary {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 2px solid;
    border-radius: var(--radius-lg);
    text-align: center;
  }
  .tug-stepcal__summary--success {
    color: var(--color-success);
    background: var(--color-success-bg);
    border-color: var(--color-success);
  }
  .tug-stepcal__summary--retry {
    color: var(--color-warning);
    background: var(--color-warning-bg);
    border-color: var(--color-warning-border);
  }
  .tug-stepcal__summary-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border: 2px solid currentColor;
    border-radius: var(--radius-full);
    font-size: var(--font-size-2xl);
    font-weight: var(--font-weight-bold);
    line-height: 1;
  }
  .tug-stepcal__summary-message {
    font-weight: var(--font-weight-bold);
  }
  .tug-stepcal__summary-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
    width: 100%;
  }
  .tug-stepcal__summary-details div {
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.72);
  }
  .tug-stepcal__summary-details dt {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .tug-stepcal__summary-details dd {
    margin-top: var(--space-1);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
  }
  .tug-stepcal__progress {
    width: 100%;
    height: 0.625rem;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: rgba(0, 0, 0, 0.1);
  }
  .tug-stepcal__progress-fill {
    height: 100%;
    border-radius: inherit;
    background: currentColor;
    transition: width var(--transition-normal);
  }
  .tug-stepcal__spark {
    background: var(--color-bg-secondary);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .tug-stepcal__spark-svg {
    width: 100%;
    height: 140px;
    display: block;
  }
  .tug-stepcal__spark-line {
    fill: none;
    stroke: var(--color-primary);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .tug-stepcal__spark-pair {
    fill: var(--color-accent, #FDBF57);
    opacity: 0.25;
  }
  .tug-stepcal__spark-dot {
    fill: var(--color-accent, #FDBF57);
    stroke: var(--color-primary);
    stroke-width: 1;
  }
  .tug-stepcal__spark-legend {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary, var(--color-primary));
    text-align: center;
  }
  .tug-stepcal__template-label {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary, var(--color-primary));
    margin-bottom: calc(var(--space-2) * -1);
  }
  .tug-stepcal__template {
    background: var(--color-bg-secondary);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    display: flex;
    justify-content: center;
  }
  .tug-stepcal__template-svg {
    width: 60%;
    height: 80px;
    display: block;
  }
  .tug-stepcal__template-line {
    fill: none;
    stroke: var(--color-primary);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .tug-stepcal__confidence {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--color-bg-secondary);
    border-radius: var(--radius-md);
  }
  .tug-stepcal__confidence-bar {
    width: 100%;
    height: 8px;
    background: rgba(0,0,0,0.08);
    border-radius: 4px;
    overflow: hidden;
  }
  .tug-stepcal__confidence-fill {
    height: 100%;
    background: var(--color-accent, #FDBF57);
    transition: width 0.3s ease;
  }
  .tug-stepcal__confidence-text {
    font-size: var(--font-size-sm);
    text-align: center;
  }
  .tug-stepcal__rejected {
    color: var(--color-text-secondary, var(--color-primary));
    font-size: var(--font-size-sm);
  }
`;
document.head.appendChild(style);
