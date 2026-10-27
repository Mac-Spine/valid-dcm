/**
 * Approved participant-facing instruction copy.
 *
 * Keep this module presentation-only so Help and assessment screens can share
 * wording without importing assessment logic, persistence, or networking.
 */
export const GRIP_INSTRUCTION_STEPS = [
  'With the screen facing up, rest the phone flat in your palm.',
  'When the timer starts, close your fingers onto the screen, then open your hand all the way.',
  'Repeat as quickly as you can for 10 seconds.',
] as const;

export const GRIP_HELP_SUMMARY =
  'A grip requires 3+ fingers touching the screen at the same time and a complete release between grips.';

export const GRIP_INSTRUCTION_TIPS = [
  'Before you start, ensure the phone is in a comfortable position and kept still for the duration of the test.',
  'Make sure to touch the screen firmly with 3+ fingers.',
  'To make sure you completely open your hand on release, try to tap the backs of your fingers against the table before beginning the next grip.',
  'Be mindful of the side buttons and avoid accidentally turning the phone off during the test.',
  'Avoid shaking the phone during the test. On some devices, shaking can trigger an operating-system undo prompt.',
  'Please save your test result following successful completion of the test.',
] as const;

export const TUG_INSTRUCTION_STEPS = [
  'Before you begin: Ensure you are seated with your back against the chair.',
  'Press Start, then place your phone fully inside a front trouser pocket within 3 seconds. Keep it there for the duration of the test and stay seated until the start tone.',
  'When you hear the start tone, stand up from the chair and walk forwards until you hear a beep.',
  'When you hear the beep, walk back to the chair and sit down with your back against the chair.',
  'Once seated, the test will automatically conclude.',
] as const;

export const TUG_HELP_SUMMARY =
  'A sensor-based walking test completed with your phone placed securely in a front trouser pocket for the duration of the test.';

export const TUG_TROUBLESHOOTING =
  'Make sure your phone is fully inside a front trouser pocket and remains in the same pocket throughout the test. Start seated with your back against the chair, stand at the start tone, walk forwards until the beep, then return to the chair and sit with your back against it. If the app still does not detect your movements, run Sensor Calibration from the TUG instructions screen.';
