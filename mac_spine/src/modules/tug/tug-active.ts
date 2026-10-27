import { clearContainer, createElement } from '../../utils/dom';
import { getProfile, saveProfile, saveResult, addAuditEntry } from '../../core/db';
import { generateUUID } from '../../utils/uuid';
import { computeChecksum } from '../../utils/crypto';
import { audioManager } from '../../utils/audio';
import { vibrate, supportsVibration, getDeviceOS, getBrowserInfo, getViewportDimensions } from '../../utils/device';
import { computeTugSensorMetrics } from './tug-metrics';
import { tugSessionSetup } from './tug-setup';
import { TugSensorEngine } from './tug-sensor';
import { TUG_PHASE_LABELS, TUG_CONFIG } from './tug-types';
import { type Vec3, lowPassFilter, decomposeAcceleration } from './tug-signal-processing';
import type { TugPhase } from './tug-types';
import {
  TUG_MAX_DURATION_MS,
  TUG_SENSOR_SAVE_INTERVAL_MS,
  APP_VERSION,
  TUG_CUE_RESPONSE_TIME_S,
  TUG_CUE_MIN_DISTANCE_M,
} from '../../constants';
import type { RawTimerEvent, RawMotionEvent, RawEvent } from '../../types/assessment';
import type { AssessmentResult, SessionMetadata, UserProfile } from '../../types/db-schemas';
import { showConfirm } from '../../components/confirm-dialog';
import { router } from '../../main';

// Shared state for results screen
export let lastTugResult: AssessmentResult | null = null;

export async function renderTugActive(container: HTMLElement): Promise<void> {
  clearContainer(container);

  const profileOrUndef = await getProfile();
  if (!profileOrUndef) {
    router.navigate('#/splash', true);
    return;
  }
  const profile: UserProfile = profileOrUndef;

  // Pick up wake lock from countdown
  let wakeLock: WakeLockSentinel | null =
    ((window as unknown as Record<string, unknown>).__tugWakeLock as WakeLockSentinel) ?? null;
  delete (window as unknown as Record<string, unknown>).__tugWakeLock;

  if (!wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await (navigator as Navigator).wakeLock.request('screen');
    } catch { /* not available */ }
  }

  const viewport = getViewportDimensions();
  const localUuid = generateUUID();
  const sessionStartISO = new Date().toISOString();

  if (!profile.tug_step_calibration) {
    router.navigate('#/assessment/tug_v1/step_calibration', true);
    return;
  }
  // Audio cue is fired early to compensate for participant reaction +
  // deceleration time. Distance overshoot = response_time × gait_speed,
  // where gait_speed = stride_length / step_time (both from calibration).
  // A fast walker overshoots more than a slow walker during the same
  // response window, so the cue scales naturally with cadence.
  const stride = profile.tug_step_calibration.avg_stride_length_m ?? 0;
  const stepTimeMs = profile.tug_step_calibration.avg_step_time_ms ?? 0;
  const gaitSpeedMps = (stride > 0 && stepTimeMs > 0) ? stride / (stepTimeMs / 1000) : 0;
  const cueDistanceM = gaitSpeedMps > 0
    ? Math.max(TUG_CUE_MIN_DISTANCE_M, TUG_CONFIG.walkDistanceM - TUG_CUE_RESPONSE_TIME_S * gaitSpeedMps)
    : TUG_CONFIG.walkDistanceM;
  const sensorConfig = { ...TUG_CONFIG, walkDistanceM: cueDistanceM };

  const cal = profile.tug_step_calibration;
  const sessionMetadata: SessionMetadata = {
    hand_used: 'n/a',
    fatigue_rating: null,
    medication_taken: null,
    screen_width_px: viewport.width,
    screen_height_px: viewport.height,
    target_radius_px: 0,
    device_os: getDeviceOS(),
    browser: getBrowserInfo(),
    app_version: APP_VERSION,
    walking_aid: tugSessionSetup.walkingAid,
    cue_distance_m: Math.round(cueDistanceM * 1e3) / 1e3,
    // end_trigger is set when the trial actually ends (endAssessment).
    calibration_snapshot: {
      calibrated_at: cal.calibrated_at,
      app_version: cal.app_version,
      n_steps_used: cal.n_steps_used,
      correlation_floor: cal.correlation_floor,
      avg_stride_length_m: cal.avg_stride_length_m,
      avg_step_time_ms: cal.avg_step_time_ms,
      template: JSON.stringify(cal.template),
      template_dt_ms: cal.template_dt_ms,
    },
  };

  // Pre-allocate event arrays
  const rawMotionEvents: RawMotionEvent[] = [];
  const rawTimerEvents: RawTimerEvent[] = [];
  let running = false;
  let startTime = 0;
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let saveInterval: ReturnType<typeof setInterval> | null = null;
  let safetyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Build UI
  const wrapper = createElement('div', { className: 'tug-active tug-active--sensor' });

  // GO signal overlay
  const goSignal = createElement('div', {
    className: 'assessment-active__go',
    textContent: 'GO!',
    'aria-live': 'assertive',
  });

  // Phase label
  const phaseLabel = createElement('div', {
    className: 'tug-sensor__phase-label',
    textContent: 'Starting...',
  });

  // Timer display
  const timerDisplay = createElement('div', {
    className: 'tug-active__timer',
    textContent: '00:00.0',
  });

  // Walk info (steps + distance) — shown during walking phases
  const walkInfo = createElement('div', { className: 'tug-sensor__walk-info' });
  walkInfo.style.display = 'none';

  const stepsDisplay = createElement('span', { textContent: 'Steps: 0' });
  const distDisplay = createElement('span', { textContent: 'Dist: 0.0m' });
  walkInfo.appendChild(stepsDisplay);
  walkInfo.appendChild(distDisplay);

  // Progress bar for distance
  const progressContainer = createElement('div', { className: 'tug-sensor__progress' });
  progressContainer.style.display = 'none';
  const progressBar = createElement('div', { className: 'tug-sensor__progress-bar' });
  const progressLabel = createElement('span', {
    className: 'tug-sensor__progress-label',
    textContent: `0.0 / ${sensorConfig.walkDistanceM.toFixed(1)}m`,
  });
  progressContainer.appendChild(progressBar);
  progressContainer.appendChild(progressLabel);

  // Return-and-sit prompt — shown after the walk-out beep
  const returnPrompt = createElement('div', { className: 'tug-sensor__return-prompt' });
  returnPrompt.style.display = 'none';
  returnPrompt.textContent = 'Turn around, walk back, and sit down';

  // Emergency stop button
  const stopBtn = createElement('button', {
    className: 'tug-active__stop-btn',
    textContent: 'STOP (Emergency)',
    'aria-label': 'Emergency stop',
  });
  stopBtn.addEventListener('click', () => {
    if (running) endAssessment(false, true);
  });

  // Gesture prevention
  wrapper.style.touchAction = 'none';
  wrapper.style.userSelect = 'none';
  (wrapper.style as unknown as Record<string, string>)['-webkit-touch-callout'] = 'none';
  document.body.style.overscrollBehavior = 'none';

  // beforeunload handler
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (running) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // Navigation guard
  const removeGuard = router.addGuard(async (_from, _to) => {
    if (!running) return true;
    const leave = await showConfirm('End test early? Data from this session will be discarded.');
    if (leave) cleanup();
    return leave;
  });

  // Sensor engine (mode-specific config)
  const engine = new TugSensorEngine({
    onStateUpdate(state) {
      // While in walking_out but no steps yet, the participant is rising.
      const prelimLabel = state.phase === 'walking_out' && state.steps === 0
        ? 'Stand and walk forward'
        : (TUG_PHASE_LABELS[state.phase] ?? state.phase);
      phaseLabel.textContent = prelimLabel;

      const isWalking = state.phase === 'walking_out';
      walkInfo.style.display = isWalking ? 'flex' : 'none';
      progressContainer.style.display = isWalking ? 'flex' : 'none';

      if (isWalking) {
        stepsDisplay.textContent = `Steps: ${state.steps}`;
        distDisplay.textContent = `Dist: ${state.distance.toFixed(1)}m`;
        const pct = Math.min(100, (state.distance / state.targetDistance) * 100);
        progressBar.style.width = `${pct}%`;
        progressLabel.textContent = `${state.distance.toFixed(1)} / ${state.targetDistance.toFixed(1)}m`;
      }

      returnPrompt.style.display = state.phase === 'sitting_down' ? 'block' : 'none';
    },

    onPhaseChange(_from: TugPhase, to: TugPhase) {
      phaseLabel.textContent = TUG_PHASE_LABELS[to] ?? to;
    },

    onStepDetected(_step) {
      // Visual/haptic feedback on step
      if (supportsVibration()) vibrate(10);
    },

    onWalkCompleteCue() {
      audioManager.play('beep');
      if (supportsVibration()) vibrate(50);
    },

    onComplete(finalElapsedMs: number) {
      // Record stop event with the engine's final time (may be backdated to sit-down impact)
      rawTimerEvents.push({
        kind: 'timer',
        t: finalElapsedMs,
        event: 'stop',
        source: 'sensor',
      });
      endAssessment(false, false, finalElapsedMs);
    },
  }, sensorConfig, profile.tug_step_calibration);

  // Retrieve calibration gravity
  const calGravity = window.__tugCalibrationGravity;
  if (calGravity) {
    engine.calibrate(calGravity);
  }

  // DeviceMotion handler
  // Storage-only gravity filter, parallel to the engine's internal one.
  // Lets us compute and persist the gravity-projected vertical accel —
  // the only channel TUG analyses need — without exposing engine internals.
  let storageGravity: Vec3 = { x: 0, y: 0, z: 9.81 };
  let storageGravityInit = false;

  const motionHandler = (event: DeviceMotionEvent) => {
    if (!running) return;
    const elapsed = performance.now() - startTime;

    const accelRaw: Vec3 = {
      x: event.accelerationIncludingGravity?.x ?? 0,
      y: event.accelerationIncludingGravity?.y ?? 0,
      z: event.accelerationIncludingGravity?.z ?? 0,
    };
    if (!storageGravityInit) { storageGravity = accelRaw; storageGravityInit = true; }
    storageGravity = lowPassFilter(accelRaw, storageGravity, TUG_CONFIG.gravityFilterAlpha);
    const dec = decomposeAcceleration(accelRaw, storageGravity);

    rawMotionEvents.push({
      kind: 'motion',
      t: elapsed,
      v: dec.vertical,
    });

    // Feed to engine (it maintains its own gravity tracking)
    engine.handleMotionEvent(event);
  };

  function formatTime(ms: number): string {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const tenths = Math.floor((totalSeconds * 10) % 10);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }

  function cleanup(): void {
    running = false;
    if (timerInterval) clearInterval(timerInterval);
    if (saveInterval) clearInterval(saveInterval);
    if (safetyTimeout) clearTimeout(safetyTimeout);
    window.removeEventListener('devicemotion', motionHandler);
    window.removeEventListener('beforeunload', onBeforeUnload);
    removeGuard();
    document.body.style.overscrollBehavior = '';
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    delete window.__tugCalibrationGravity;
  }

  async function endAssessment(timedOut: boolean, manualStop: boolean, overrideElapsedMs?: number): Promise<void> {
    if (!running) return;
    running = false;
    if (timerInterval) clearInterval(timerInterval);
    if (saveInterval) clearInterval(saveInterval);
    if (safetyTimeout) clearTimeout(safetyTimeout);
    window.removeEventListener('devicemotion', motionHandler);

    // Use backdated time from engine if provided, otherwise real wall-clock time
    const elapsed = overrideElapsedMs ?? (performance.now() - startTime);

    // Ensure stop event is recorded
    if (!rawTimerEvents.some(e => e.event === 'stop')) {
      rawTimerEvents.push({
        kind: 'timer',
        t: elapsed,
        event: 'stop',
        source: manualStop ? 'manual' : 'sensor',
      });
    }

    audioManager.play('end');
    if (supportsVibration()) vibrate(50);

    // Update UI
    timerDisplay.textContent = formatTime(elapsed);
    stopBtn.style.display = 'none';
    walkInfo.style.display = 'none';
    progressContainer.style.display = 'none';
    returnPrompt.style.display = 'none';

    const endMsg = createElement('div', {
      className: 'tug-active__end-msg',
      textContent: timedOut ? 'Safety timeout reached' : manualStop ? 'Test stopped' : 'Test complete!',
    });
    wrapper.appendChild(endMsg);

    // Combine all raw data
    const allRawData: RawEvent[] = [...rawTimerEvents, ...rawMotionEvents];

    // Compute metrics
    const phaseTransitions = engine.getPhaseTransitions();
    const metrics = computeTugSensorMetrics(allRawData, phaseTransitions, engine.getWalkOutData());
    const checksum = await computeChecksum(allRawData);

    // Record end-trigger. Priority: explicit manual / safety_timeout from
    // the active screen, otherwise the final phase transition's trigger
    // ('stillness_detected' | 'sitdown_timeout').
    let endTrigger: SessionMetadata['end_trigger'] = 'stillness';
    if (manualStop) {
      endTrigger = 'manual';
    } else if (timedOut) {
      endTrigger = 'safety_timeout';
    } else {
      const lastTransition = phaseTransitions[phaseTransitions.length - 1];
      if (lastTransition?.trigger === 'sitdown_timeout') endTrigger = 'sitdown_timeout';
      else endTrigger = 'stillness';
    }
    sessionMetadata.end_trigger = endTrigger;

    const isFlagged = timedOut || manualStop;
    let flagReason: string | null = null;
    if (timedOut) flagReason = 'Safety timeout: test exceeded 2 minutes';
    else if (manualStop) flagReason = 'Manual stop during sensor test';

    const finalResult: AssessmentResult = {
      local_uuid: localUuid,
      participant_id: profile.participant_id,

      timestamp_start: sessionStartISO,
      task_type: 'tug_v1',
      status: 'in_progress',
      session_metadata: sessionMetadata,
      raw_data: allRawData,
      computed_metrics: metrics,
      flagged: isFlagged,
      flag_reason: flagReason,
      synced: false,
      sync_attempts: 0,
      checksum,
    };

    try {
      await saveResult(finalResult);

      if (!profile.first_assessment_completed) {
        profile.first_assessment_completed = true;
        await saveProfile(profile);
      }

      lastTugResult = finalResult;
    } catch (err) {
      console.error('Failed to save TUG sensor result:', err);
    }

    cleanup();

    setTimeout(() => {
      router.navigate('#/assessment/tug_v1/results', true);
    }, 500);
  }

  // Assemble DOM
  wrapper.appendChild(goSignal);
  wrapper.appendChild(phaseLabel);
  wrapper.appendChild(timerDisplay);
  wrapper.appendChild(walkInfo);
  wrapper.appendChild(progressContainer);
  wrapper.appendChild(returnPrompt);
  wrapper.appendChild(stopBtn);
  container.appendChild(wrapper);

  // Audit start
  await addAuditEntry({
    action: 'assessment_started',
    entity_id: localUuid,
    details: { task_type: 'tug_v1', walking_aid: tugSessionSetup.walkingAid },
  });

  // Record start event
  rawTimerEvents.push({
    kind: 'timer',
    t: 0,
    event: 'start',
    source: 'sensor',
  });

  // Initial incremental save
  const partialResult: AssessmentResult = {
    local_uuid: localUuid,
    participant_id: profile.participant_id,
    timestamp_start: sessionStartISO,
    task_type: 'tug_v1',
    status: 'in_progress',
    session_metadata: sessionMetadata,
    raw_data: [...rawTimerEvents],
    computed_metrics: { duration_actual_ms: 0, tug_time_s: 0 },
    flagged: false,
    flag_reason: null,
    synced: false,
    sync_attempts: 0,
    checksum: '',
  };

  try {
    await saveResult(partialResult);
  } catch (err) {
    console.error('Incremental save failed:', err);
  }

  // Start timing and sensing at the GO cue, after the placement buffer.
  running = true;
  startTime = performance.now();
  engine.start();
  window.addEventListener('devicemotion', motionHandler);
  goSignal.style.display = 'flex';
  audioManager.play('go');
  if (supportsVibration()) vibrate(30);

  setTimeout(() => { goSignal.style.display = 'none'; }, 500);

  // Timer display
  timerInterval = setInterval(() => {
    if (!running) return;
    const elapsed = performance.now() - startTime;
    timerDisplay.textContent = formatTime(elapsed);
  }, 100);

  // Incremental saves
  saveInterval = setInterval(async () => {
    if (!running) return;
    const elapsed = performance.now() - startTime;
    try {
      await saveResult({
        local_uuid: localUuid,
        participant_id: profile.participant_id,

        timestamp_start: sessionStartISO,
        task_type: 'tug_v1',
        status: 'in_progress',
        session_metadata: sessionMetadata,
        raw_data: [...rawTimerEvents, ...rawMotionEvents],
        computed_metrics: { duration_actual_ms: Math.round(elapsed), tug_time_s: 0 },
        flagged: false,
        flag_reason: null,
        synced: false,
        sync_attempts: 0,
        checksum: '',
      });
    } catch (err) {
      console.error('Incremental sensor save failed:', err);
    }
  }, TUG_SENSOR_SAVE_INTERVAL_MS);

  // Safety timeout
  safetyTimeout = setTimeout(() => {
    if (running) endAssessment(true, false);
  }, TUG_MAX_DURATION_MS);
}

const style = document.createElement('style');
style.textContent = `
  .tug-active {
    position: fixed;
    inset: 0;
    background: var(--color-bg);
    z-index: var(--z-overlay);
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-8);
  }
  .tug-active__timer {
    font-size: clamp(3rem, 15vw, 6rem);
    font-weight: var(--font-weight-bold);
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
    z-index: 6;
  }
  .tug-active__stop-btn {
    width: min(80vw, 20rem);
    min-height: 5rem;
    border: none;
    border-radius: var(--radius-lg);
    background: #7A003C;
    color: #fff;
    font-size: var(--font-size-2xl);
    font-weight: var(--font-weight-bold);
    cursor: pointer;
    z-index: 6;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .tug-active__stop-btn:active {
    background: #5C002D;
    transform: scale(0.97);
  }
  .tug-active__end-msg {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
    z-index: 6;
  }

  /* Sensor mode extras */
  .tug-sensor__phase-label {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-primary);
    z-index: 6;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tug-sensor__walk-info {
    display: flex;
    gap: var(--space-6);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    color: var(--color-text);
    z-index: 6;
  }
  .tug-sensor__progress {
    width: min(80vw, 20rem);
    height: 1.5rem;
    background: var(--color-bg-secondary);
    border-radius: var(--radius-full);
    overflow: hidden;
    position: relative;
    z-index: 6;
    display: flex;
    align-items: center;
  }
  .tug-sensor__progress-bar {
    height: 100%;
    background: var(--color-primary);
    border-radius: var(--radius-full);
    transition: width 0.2s ease-out;
    width: 0%;
  }
  .tug-sensor__progress-label {
    position: absolute;
    width: 100%;
    text-align: center;
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
    z-index: 1;
  }
  .tug-sensor__return-prompt {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-primary);
    z-index: 6;
    text-align: center;
    padding: 0 var(--space-4);
  }
`;
document.head.appendChild(style);
