import { TurnManager } from '../../src/state-machine/turn-manager';

describe('state-machine/TurnManager', () => {
  it('seats players and reports occupancy', () => {
    const tm = new TurnManager(6);
    tm.seat('alice', 0);
    tm.seat('bob', 2);
    tm.seat('carol', 4);
    expect(tm.playerCount).toBe(3);
    expect(tm.occupiedSeats.map((s) => s.playerId)).toEqual(['alice', 'bob', 'carol']);
    expect(tm.seatOf('bob')).toBe(2);
    expect(tm.playerAt(4)).toBe('carol');
  });

  it('rejects double-seating and out-of-range seats', () => {
    const tm = new TurnManager(6);
    tm.seat('alice', 0);
    expect(() => tm.seat('bob', 0)).toThrow(/occupied/);
    expect(() => tm.seat('alice', 1)).toThrow(/already at seat/);
    expect(() => tm.seat('carol', 9)).toThrow(/out of range/);
  });

  it('advances the dealer button to the next occupied seat', () => {
    const tm = new TurnManager(6);
    tm.seat('alice', 0);
    tm.seat('bob', 3);
    expect(tm.button).toBe(0);
    expect(tm.advanceButton()).toBe(3);
    expect(tm.advanceButton()).toBe(0); // wraps
  });

  it('multiway blind positions: SB=button+1, BB=+2, UTG=+3', () => {
    const tm = new TurnManager(6);
    for (let i = 0; i < 6; i++) tm.seat(`p${i}`, i);
    // button at 0
    const { smallBlind, bigBlind, firstToActPreflop } = tm.blindPositions();
    expect(smallBlind).toBe(1);
    expect(bigBlind).toBe(2);
    expect(firstToActPreflop).toBe(3);
  });

  it('heads-up: button is small blind and acts first preflop', () => {
    const tm = new TurnManager(6);
    tm.seat('alice', 0);
    tm.seat('bob', 1);
    const { smallBlind, bigBlind, firstToActPreflop } = tm.blindPositions();
    expect(smallBlind).toBe(0); // button
    expect(bigBlind).toBe(1);
    expect(firstToActPreflop).toBe(0); // button acts first heads-up preflop
  });

  it('advanceActor skips inactive (folded/all-in) seats', () => {
    const tm = new TurnManager(6);
    for (let i = 0; i < 4; i++) tm.seat(`p${i}`, i);
    tm.setActor(0);
    expect(tm.advanceActor()).toBe(1);
    tm.setInactive(2); // p2 folds
    expect(tm.advanceActor()).toBe(3); // skips 2
    expect(tm.advanceActor()).toBe(0); // wraps, skipping 2
  });

  it('activeSeats excludes inactive seats; resetActivity restores them', () => {
    const tm = new TurnManager(6);
    for (let i = 0; i < 4; i++) tm.seat(`p${i}`, i);
    tm.setInactive(1);
    tm.setInactive(3);
    expect(tm.activeSeats).toEqual([0, 2]);
    tm.resetActivity();
    expect(tm.activeSeats).toEqual([0, 1, 2, 3]);
  });

  it('firstToActPostflop is first active seat clockwise from button', () => {
    const tm = new TurnManager(6);
    for (let i = 0; i < 4; i++) tm.seat(`p${i}`, i);
    // button 0 → first active postflop is seat 1
    expect(tm.firstToActPostflop()).toBe(1);
    tm.setInactive(1);
    expect(tm.firstToActPostflop()).toBe(2);
  });

  it('unseat clears actor and activity', () => {
    const tm = new TurnManager(6);
    tm.seat('alice', 0);
    tm.seat('bob', 1);
    tm.setActor(1);
    tm.unseat(1);
    expect(tm.currentActorSeat).toBeNull();
    expect(tm.playerCount).toBe(1);
  });

  it('rejects invalid maxSeats', () => {
    expect(() => new TurnManager(1)).toThrow(/2\.\.10/);
    expect(() => new TurnManager(11)).toThrow(/2\.\.10/);
  });
});
