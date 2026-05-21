/**
 * Generic finite state machine (spec §7, Iron Rule 2: all game state changes
 * go ONLY through the StateMachine — no scattered boolean flags).
 *
 * Each game declares its states and the legal transitions between them.
 * Illegal transitions throw, so an invalid game flow fails loudly rather than
 * silently corrupting state.
 */

export interface StateMachineOptions<S extends string> {
  initial: S;
  /** Map of state → states it may transition to. Terminal states map to []. */
  transitions: Readonly<Record<S, readonly S[]>>;
  /** Optional callback fired after every successful transition. */
  onTransition?: (from: S, to: S) => void;
}

export class IllegalStateTransitionError<S extends string> extends Error {
  constructor(
    public readonly from: S,
    public readonly to: S,
  ) {
    super(`IllegalStateTransition: ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export class StateMachine<S extends string> {
  private state: S;
  private readonly transitions: Readonly<Record<S, readonly S[]>>;
  private readonly onTransition: ((from: S, to: S) => void) | undefined;
  private readonly _history: S[];

  constructor(opts: StateMachineOptions<S>) {
    this.state = opts.initial;
    this.transitions = opts.transitions;
    this.onTransition = opts.onTransition;
    this._history = [opts.initial];
  }

  get current(): S {
    return this.state;
  }

  get history(): readonly S[] {
    return this._history;
  }

  /** Is `to` a legal next state from the current state? */
  can(to: S): boolean {
    return (this.transitions[this.state] ?? []).includes(to);
  }

  /** Transition to `to`. Throws IllegalStateTransitionError if not permitted. */
  transition(to: S): void {
    if (!this.can(to)) throw new IllegalStateTransitionError(this.state, to);
    const from = this.state;
    this.state = to;
    this._history.push(to);
    this.onTransition?.(from, to);
  }

  /** True if the current state has no outgoing transitions. */
  isTerminal(): boolean {
    return (this.transitions[this.state] ?? []).length === 0;
  }
}
