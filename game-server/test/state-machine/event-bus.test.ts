import { TypedEventBus, type GameEventMap } from '../../src/state-machine/event-bus';

describe('state-machine/TypedEventBus', () => {
  it('delivers emitted events to listeners with typed args', () => {
    const bus = new TypedEventBus<GameEventMap>();
    const seen: Array<{ from: string; to: string }> = [];
    bus.on('state_changed', (e) => seen.push(e));
    bus.emit('state_changed', { from: 'WAITING', to: 'PRE_FLOP' });
    expect(seen).toEqual([{ from: 'WAITING', to: 'PRE_FLOP' }]);
  });

  it('once fires a single time', () => {
    const bus = new TypedEventBus<GameEventMap>();
    let count = 0;
    bus.once('player_joined', () => count++);
    bus.emit('player_joined', { playerId: 'a', seat: 0 });
    bus.emit('player_joined', { playerId: 'b', seat: 1 });
    expect(count).toBe(1);
  });

  it('off removes a listener', () => {
    const bus = new TypedEventBus<GameEventMap>();
    let count = 0;
    const handler = (): void => {
      count++;
    };
    bus.on('turn_changed', handler);
    bus.emit('turn_changed', { playerId: 'a', seat: 0 });
    bus.off('turn_changed', handler);
    bus.emit('turn_changed', { playerId: 'b', seat: 1 });
    expect(count).toBe(1);
  });

  it('multiple listeners all receive the event', () => {
    const bus = new TypedEventBus<GameEventMap>();
    let a = 0;
    let b = 0;
    bus.on('hand_settled', () => a++);
    bus.on('hand_settled', () => b++);
    bus.emit('hand_settled', { roundId: 'r1', winners: ['alice'] });
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(bus.listenerCount('hand_settled')).toBe(2);
  });

  it('removeAllListeners clears everything', () => {
    const bus = new TypedEventBus<GameEventMap>();
    bus.on('state_changed', () => {});
    bus.removeAllListeners();
    expect(bus.listenerCount('state_changed')).toBe(0);
  });
});
