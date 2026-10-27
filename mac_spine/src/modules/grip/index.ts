import type { AssessmentModule, ComputedMetrics, RawSessionData, InstructionConfig, PracticeConfig, MetadataField } from '../../types/assessment';
import type { AssessmentResult } from '../../types/db-schemas';
import { computeGripMetrics } from './grip-metrics';
import { GRIP_PRACTICE_DURATION_MS, GRIP_DURATION_MS } from '../../constants';
import { GRIP_INSTRUCTION_STEPS } from '../../content/assessment-instructions';

export const gripModule: AssessmentModule = {
  id: 'grip_v1',
  name: 'Grip & Release Test',
  version: '1.0.0',
  description: 'Measure grip speed, rhythm, and coordination over 10 seconds',

  redcap: {
    instrument: 'grip_task',
    fieldMap: {
      local_uuid: 'local_uuid',
      timestamp_start: 'grip_timestamp',
      'computed_metrics.duration_actual_ms': 'grip_duration',
      'computed_metrics.tap_count': 'grip_count',
      'computed_metrics.frequency_hz': 'grip_freq',
      'computed_metrics.rhythm_cv': 'grip_regularity',
      'session_metadata.hand_used': 'grip_hand',
      'session_metadata.hand_weakness': 'grip_hand_weakness',
      flagged: 'grip_flagged',
      flag_reason: 'grip_flag_reason',
      raw_data: 'grip_raw_json',
      checksum: 'grip_checksum',
      'session_metadata.device_os': 'device_os',
      'session_metadata.screen_width_px': 'screen_width',
      'session_metadata.screen_height_px': 'screen_height',
      'session_metadata.app_version': 'app_version',
    },
  },

  metrics: [
    { key: 'frequency_hz', label: 'Grips per second', unit: 'Hz', higherIsBetter: true },
    { key: 'rhythm_cv', label: 'Consistency score', unit: '%', higherIsBetter: true },
  ],

  getInstructions(): InstructionConfig {
    return {
      title: 'Grip & Release Test',
      body: GRIP_INSTRUCTION_STEPS.join(' '),
      importantPoints: [
        'A grip counts when 3+ fingers touch the screen at the same time',
        'Open your hand completely between grips',
        'The test lasts 10 seconds',
      ],
      showMeHow: true,
    };
  },

  getPracticeConfig(): PracticeConfig {
    return {
      durationMs: GRIP_PRACTICE_DURATION_MS,
      showFeedback: true,
      showCounter: true,
    };
  },

  screens: {
    setup: async (c: HTMLElement) => { const { renderGripSetup } = await import('./grip-setup'); renderGripSetup(c); },
    instructions: async (c: HTMLElement) => { const { renderGripInstructions } = await import('./grip-instructions'); renderGripInstructions(c); },
    practice: async (c: HTMLElement) => { const { renderGripPractice } = await import('./grip-practice'); renderGripPractice(c); },
    countdown: async (c: HTMLElement) => { const { renderGripCountdown } = await import('./grip-countdown'); renderGripCountdown(c); },
    active: async (c: HTMLElement) => { const { renderGripActive } = await import('./grip-active'); renderGripActive(c); },
    results: async (c: HTMLElement) => { const { renderGripResults } = await import('./grip-results'); renderGripResults(c); },
  },

  computeMetrics(rawData: RawSessionData): ComputedMetrics {
    return computeGripMetrics(rawData, GRIP_DURATION_MS);
  },

  getSessionMetadataFields(): MetadataField[] {
    return [
      {
        key: 'hand_used',
        label: 'Which hand are you using?',
        type: 'radio',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
      },
      {
        key: 'hand_weakness',
        label: 'Weakness in this hand',
        type: 'radio',
        options: [
          { value: 'none', label: 'No weakness' },
          { value: 'mild', label: 'Mild' },
          { value: 'moderate', label: 'Moderate' },
          { value: 'severe', label: 'Severe' },
        ],
      },
    ];
  },

  getPrimaryMetric() {
    return { key: 'frequency_hz', label: 'Grips per second', unit: 'Hz', higherIsBetter: true };
  },

  getHistorySummary(result: AssessmentResult): string {
    const m = result.computed_metrics;
    return `${m.tap_count ?? 0} grips \u2022 ${(m.frequency_hz ?? 0).toFixed(1)} Hz \u2022 ${result.session_metadata.hand_used}`;
  },

  getSparklineValue(result: AssessmentResult): number {
    return result.computed_metrics.frequency_hz ?? 0;
  },
};
