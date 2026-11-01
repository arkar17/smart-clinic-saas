import { describe, expect, it } from 'vitest';
import { QUEUE_TRANSITIONS, QueueStatus, formatToken, queueTransition, type QueueAction } from './queue';

describe('queue transitions (SRS 9.3, TC-QUE-008, TC-QUE-024)', () => {
  it('allows exactly the QT table pairs for every status × action', () => {
    const allowed = new Set(Object.entries(QUEUE_TRANSITIONS).flatMap(([a, t]) => t.from.map((f) => `${f}:${a}`)));
    for (const from of QueueStatus.options) {
      for (const action of Object.keys(QUEUE_TRANSITIONS) as QueueAction[]) {
        const r = queueTransition(from, action);
        expect(r !== null, `${from} ${action}`).toBe(allowed.has(`${from}:${action}`));
      }
    }
  });
  it('invalid examples: REGISTERED → CALLED and COMPLETED → WAITING are refused', () => {
    expect(queueTransition('REGISTERED', 'CALL')).toBeNull();
    expect(queueTransition('COMPLETED', 'RETURN_TO_WAITING')).toBeNull();
    expect(queueTransition('COMPLETED', 'CONFIRM_ARRIVAL')).toBeNull();
  });
  it('return to waiting is limited to 3 recalls (A-020)', () => {
    expect(queueTransition('CALLED', 'RETURN_TO_WAITING', { recallCount: 2 })).toBe('WAITING');
    expect(queueTransition('CALLED', 'RETURN_TO_WAITING', { recallCount: 3 })).toBe('RECALL_LIMIT');
  });
  it('BR-021 tokens are zero-padded to three digits', () => {
    expect([formatToken(7), formatToken(112), formatToken(1000)]).toEqual(['007', '112', '1000']);
  });
});
