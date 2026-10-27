import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDB, getProfile, initDB, saveProfile } from '../../../../src/core/db';
import type { TugStepCalibration, UserProfile } from '../../../../src/types/db-schemas';

const calibration: TugStepCalibration = {
  template: [0, 1, 0], template_dt_ms: 20, correlation_floor: 0.8,
  n_steps_used: 10, n_batches: 2, final_delta: 0.1, avg_stride_length_m: 0.5,
  avg_step_time_ms: 600, detection_rate_history: [1, 1],
  calibrated_at: '2026-01-01', app_version: '1.0.0',
};
const profile: UserProfile = {
  id: 'current', participant_id: 'test', name: 'Test', consent_date: '2026-01-01',
  consent_version: '1', created_at: '2026-01-01', updated_at: '2026-01-01',
  preferences: { audio_enabled: true, haptic_enabled: false, reminder_frequency: 'off' },
};
beforeAll(async () => { await initDB(); });
describe('pocket calibration transition', () => {
  it('removes a legacy calibration from storage while retaining the profile', async () => {
    await saveProfile({ ...profile, tug_step_calibration: calibration });
    const migrated = await getProfile();
    expect(migrated?.participant_id).toBe('test');
    expect(migrated?.tug_step_calibration).toBeUndefined();
    const stored = await new Promise<UserProfile>(resolve => {
      const request = getDB().transaction('user_profile').objectStore('user_profile').get('current');
      request.onsuccess = () => resolve(request.result);
    });
    expect(stored.tug_step_calibration).toBeUndefined();
  });
  it('retains a pocket calibration across profile reads', async () => {
    await saveProfile({ ...profile, tug_step_calibration: { ...calibration, placement: 'front_trouser_pocket' } });
    expect((await getProfile())?.tug_step_calibration?.placement).toBe('front_trouser_pocket');
    expect((await getProfile())?.tug_step_calibration?.template).toEqual(calibration.template);
  });
});
