import {
  IllegalStateTransitionError,
  StateMachine,
} from '../../src/state-machine/state-machine';

type S = 'WAITING' | 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'SETTLED';

function texasMachine(onTransition?: (from: S, to: S) => void): StateMachine<S> {
  return new StateMachine<S>({
    initial: 'WAITING',
    transitions: {
      WAITING: ['PRE_FLOP'],
      PRE_FLOP: ['FLOP', 'SHOWDOWN'], // SHOWDOWN if everyone folds to one
      FLOP: ['TURN', 'SHOWDOWN'],
      TURN: ['RIVER', 'SHOWDOWN'],
      RIVER: ['SHOWDOWN'],
      SHOWDOWN: ['SETTLED'],
      SETTLED: [],
    },
    ...(onTransition ? { onTransition } : {}),
  });
}

describe('state-machine/StateMachine', () => {
  it('starts in the initial state', () => {
    expect(texasMachine().current).toBe('WAITING');
  });

  it('allows legal transitions and records history', () => {
    const m = texasMachine();
    m.transition('PRE_FLOP');
    m.transition('FLOP');
    m.transition('TURN');
    expect(m.current).toBe('TURN');
    expect(m.history).toEqual(['WAITING', 'PRE_FLOP', 'FLOP', 'TURN']);
  });

  it('rejects illegal transitions', () => {
    const m = texasMachine();
    expect(() => m.transition('FLOP')).toThrow(IllegalStateTransitionError);
    expect(m.current).toBe('WAITING'); // unchanged
  });

  it('can() reports legality without transitioning', () => {
    const m = texasMachine();
    expect(m.can('PRE_FLOP')).toBe(true);
    expect(m.can('RIVER')).toBe(false);
    expect(m.current).toBe('WAITING');
  });

  it('supports the everyone-folds shortcut PRE_FLOP -> SHOWDOWN', () => {
    const m = texasMachine();
    m.transition('PRE_FLOP');
    expect(m.can('SHOWDOWN')).toBe(true);
    m.transition('SHOWDOWN');
    expect(m.current).toBe('SHOWDOWN');
  });

  it('fires onTransition callback', () => {
    const calls: Array<[S, S]> = [];
    const m = texasMachine((from, to) => calls.push([from, to]));
    m.transition('PRE_FLOP');
    m.transition('FLOP');
    expect(calls).toEqual([
      ['WAITING', 'PRE_FLOP'],
      ['PRE_FLOP', 'FLOP'],
    ]);
  });

  it('isTerminal true only at SETTLED', () => {
    const m = texasMachine();
    expect(m.isTerminal()).toBe(false);
    m.transition('PRE_FLOP');
    m.transition('SHOWDOWN');
    m.transition('SETTLED');
    expect(m.isTerminal()).toBe(true);
    expect(() => m.transition('WAITING')).toThrow(IllegalStateTransitionError);
  });
});
