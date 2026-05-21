import { sha256 } from '@noble/hashes/sha256';
import { TexasHoldem, type TexasConfig } from '../../src/games/texas/texas-holdem';

function seedFrom(s: string): Uint8Array {
  return sha256(new TextEncoder().encode(s));
}

function makeTable(overrides: Partial<TexasConfig> = {}): TexasHoldem {
  return new TexasHoldem({
    tableId: 't1',
    tableType: 'PLATFORM',
    minPlayers: 2,
    maxPlayers: 6,
    smallBlind: 50n,
    bigBlind: 100n,
    ...overrides,
  });
}

/**
 * Sum of all seated players' STACKS. Invariant between hand start and
 * settlement: at both points every chip lives in a stack (mid-hand, chips
 * temporarily sit in the pot via `committed`, so only compare at start vs
 * SETTLED). The engine takes no rake; the settlement adapter does that later.
 */
function totalStacks(game: TexasHoldem): bigint {
  const pub = game.getPublicState() as { players: Array<{ stack: string }> };
  return pub.players.reduce((s, p) => s + BigInt(p.stack), 0n);
}

describe('games/texas/TexasHoldem', () => {
  it('seats players, buys in, and can start with 2 funded players', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    expect(g.canStart()).toBe(false); // no chips yet
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    expect(g.canStart()).toBe(true);
  });

  it('posts blinds on hand start and deals hole cards', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    g.startHand({ roundId: 'r1', finalSeed: seedFrom('r1') });

    expect(g.state).toBe('PRE_FLOP');
    const pub = g.getPublicState() as { pot: string; players: Array<{ playerId: string }> };
    // SB(50) + BB(100) = 150 in the pot.
    expect(pub.pot).toBe('150');
    // Each player can see their own 2 hole cards.
    const view = g.getPrivateView('alice') as { holeCards: string[] };
    expect(view.holeCards).toHaveLength(2);
  });

  it('heads-up: button/SB folds preflop → big blind wins the blinds', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    const before = totalStacks(g);
    g.startHand({ roundId: 'r1', finalSeed: seedFrom('r1') });

    // Heads-up: button (seat with the button) is SB and acts first preflop.
    const pub = g.getPublicState() as { actor: string };
    const folder = pub.actor;
    const r = g.applyAction(folder, { type: 'fold' });
    expect(r.ok).toBe(true);
    expect(g.state).toBe('SETTLED');

    const result = g.getHandResult()!;
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0]).not.toBe(folder);
    // Chip conservation.
    expect(totalStacks(g)).toBe(before);
    // Winner net should be positive (won the SB), folder net negative.
    const winner = result.players.find((p) => p.playerId === result.winners[0]);
    expect(winner!.net).toBeGreaterThan(0n);
  });

  it('plays a full hand to showdown when both check/call down', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    const before = totalStacks(g);
    g.startHand({ roundId: 'r2', finalSeed: seedFrom('full-hand') });

    // Drive the hand: always call/check with whoever is to act until SETTLED.
    let guard = 0;
    while (g.state !== 'SETTLED' && guard++ < 50) {
      const pub = g.getPublicState() as { actor: string | null; currentBet: string; players: Array<{ playerId: string; streetCommitted: string }> };
      const actor = pub.actor;
      if (!actor) break;
      const me = pub.players.find((p) => p.playerId === actor)!;
      const toCall = BigInt(pub.currentBet) - BigInt(me.streetCommitted);
      const r = g.applyAction(actor, { type: toCall === 0n ? 'check' : 'call' });
      expect(r.ok).toBe(true);
    }
    expect(g.state).toBe('SETTLED');
    const result = g.getHandResult()!;
    expect(result.board).toHaveLength(5); // full board dealt
    expect(result.winners.length).toBeGreaterThanOrEqual(1);
    expect(totalStacks(g)).toBe(before); // chips conserved
    // Pot total equals what was committed (each put in 100).
    expect(result.potTotal).toBe(200n);
  });

  it('rejects out-of-turn and illegal actions', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    g.startHand({ roundId: 'r3', finalSeed: seedFrom('r3') });

    const pub = g.getPublicState() as { actor: string; players: Array<{ playerId: string }> };
    const notActor = pub.players.find((p) => p.playerId !== pub.actor)!.playerId;
    expect(g.applyAction(notActor, { type: 'check' }).ok).toBe(false); // not your turn
    // Actor faces the BB, so check is illegal preflop for the SB.
    const checkRes = g.applyAction(pub.actor, { type: 'check' });
    expect(checkRes.ok).toBe(false);
  });

  it('three-handed all-in produces a settled result with chips conserved', () => {
    const g = makeTable({ maxPlayers: 6 });
    g.join('a', 0);
    g.join('b', 1);
    g.join('c', 2);
    g.buyIn('a', 1_000n);
    g.buyIn('b', 5_000n);
    g.buyIn('c', 5_000n);
    const before = totalStacks(g);
    g.startHand({ roundId: 'r4', finalSeed: seedFrom('allin') });

    // Everyone shoves all-in / calls until settled.
    let guard = 0;
    while (g.state !== 'SETTLED' && guard++ < 50) {
      const pub = g.getPublicState() as {
        actor: string | null;
        currentBet: string;
        players: Array<{ playerId: string; stack: string; streetCommitted: string }>;
      };
      const actor = pub.actor;
      if (!actor) break;
      const me = pub.players.find((p) => p.playerId === actor)!;
      const toCall = BigInt(pub.currentBet) - BigInt(me.streetCommitted);
      // Shove: raise to entire stack+committed, or call if can't.
      const target = BigInt(me.stack) + BigInt(me.streetCommitted);
      let r = g.applyAction(actor, { type: 'raise', payload: { amount: target.toString() } });
      if (!r.ok) r = g.applyAction(actor, { type: toCall === 0n ? 'check' : 'call' });
      expect(r.ok).toBe(true);
    }
    expect(g.state).toBe('SETTLED');
    const result = g.getHandResult()!;
    expect(totalStacks(g)).toBe(before); // chips conserved even with side pots
    // a could only win up to 3×1000 = 3000 (main pot) given the short stack.
    const aNet = result.players.find((p) => p.playerId === 'a')!.net;
    expect(aNet).toBeGreaterThanOrEqual(-1_000n); // can't lose more than they had
  });

  it('cannot join mid-hand', () => {
    const g = makeTable();
    g.join('alice', 0);
    g.join('bob', 1);
    g.buyIn('alice', 10_000n);
    g.buyIn('bob', 10_000n);
    g.startHand({ roundId: 'r5', finalSeed: seedFrom('r5') });
    expect(() => g.join('carol', 2)).toThrow(/mid-hand/);
  });
});
