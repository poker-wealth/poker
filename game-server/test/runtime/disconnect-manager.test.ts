import { DisconnectManager } from '../../src/runtime/disconnect-manager';

describe('runtime/DisconnectManager (spec §6.4)', () => {
  let now = 0;
  const clock = (): number => now;

  function mgr(): DisconnectManager {
    return new DisconnectManager({ graceMs: 20_000, perHandCapMs: 60_000, perHourLimit: 3, clock });
  }

  beforeEach(() => {
    now = 1_000_000;
  });

  it('first disconnect pauses (grace running)', () => {
    const m = mgr();
    expect(m.onDisconnect('h1', 'alice')).toBe('PAUSED');
    expect(m.remainingGraceMs('h1', 'alice')).toBe(20_000);
  });

  it('grace expires after 20s → shouldAutoFold', () => {
    const m = mgr();
    m.onDisconnect('h1', 'alice');
    now += 19_000;
    expect(m.shouldAutoFold('h1', 'alice')).toBe(false);
    expect(m.remainingGraceMs('h1', 'alice')).toBe(1_000);
    now += 1_500; // total 20.5s
    expect(m.shouldAutoFold('h1', 'alice')).toBe(true);
  });

  it('reconnect within grace resumes and accrues pause time', () => {
    const m = mgr();
    m.onDisconnect('h1', 'alice');
    now += 10_000;
    expect(m.onReconnect('h1', 'alice')).toEqual({ resumed: true });
    // Reconnected → not subject to auto-fold.
    expect(m.shouldAutoFold('h1', 'alice')).toBe(false);
  });

  it('per-hand 60s cumulative pause cap triggers auto-fold across multiple disconnects', () => {
    const m = mgr();
    // 3 disconnects of ~19s each = 57s, reconnecting each time (stays ≤3/hr).
    for (let i = 0; i < 3; i++) {
      expect(m.onDisconnect('h1', 'alice')).toBe('PAUSED');
      now += 19_000;
      m.onReconnect('h1', 'alice');
    }
    // consumed ≈ 57s. 4th disconnect would exceed the per-hour limit anyway,
    // so use a fresh player to isolate the per-hand cap path.
    const m2 = new DisconnectManager({ graceMs: 20_000, perHandCapMs: 60_000, perHourLimit: 99, clock });
    for (let i = 0; i < 3; i++) {
      m2.onDisconnect('h1', 'bob');
      now += 19_000;
      m2.onReconnect('h1', 'bob');
    }
    // consumed ≈ 57s. Next disconnect pauses; within ~3s the cap is hit.
    expect(m2.onDisconnect('h1', 'bob')).toBe('PAUSED');
    now += 3_500; // 57 + 3.5 = 60.5s ≥ 60s cap
    expect(m2.shouldAutoFold('h1', 'bob')).toBe(true);
  });

  it('4th disconnect in an hour auto-folds (per-hour cap)', () => {
    const m = mgr();
    expect(m.onDisconnect('h1', 'alice')).toBe('PAUSED');
    m.onReconnect('h1', 'alice');
    now += 1000;
    expect(m.onDisconnect('h2', 'alice')).toBe('PAUSED');
    m.onReconnect('h2', 'alice');
    now += 1000;
    expect(m.onDisconnect('h3', 'alice')).toBe('PAUSED');
    m.onReconnect('h3', 'alice');
    now += 1000;
    // 4th within the hour → auto-fold, no pause.
    expect(m.onDisconnect('h4', 'alice')).toBe('AUTO_FOLD');
    expect(m.disconnectsThisHour('alice')).toBe(4);
  });

  it('disconnect count rolls off after an hour', () => {
    const m = mgr();
    m.onDisconnect('h1', 'alice');
    m.onReconnect('h1', 'alice');
    m.onDisconnect('h2', 'alice');
    m.onReconnect('h2', 'alice');
    m.onDisconnect('h3', 'alice');
    m.onReconnect('h3', 'alice');
    expect(m.disconnectsThisHour('alice')).toBe(3);
    now += 3_600_001; // > 1 hour
    expect(m.disconnectsThisHour('alice')).toBe(0);
    // Fresh budget after the window.
    expect(m.onDisconnect('h4', 'alice')).toBe('PAUSED');
  });

  it('resetHand clears per-hand pause accounting', () => {
    const m = mgr();
    m.onDisconnect('h1', 'alice');
    now += 10_000;
    m.onReconnect('h1', 'alice');
    m.resetHand('h1', ['alice']);
    // New disconnect on the same hand id starts fresh.
    m.onDisconnect('h1', 'alice');
    expect(m.remainingGraceMs('h1', 'alice')).toBe(20_000);
  });
});
