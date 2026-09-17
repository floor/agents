# Decision for the committee: RFC-013 v3 touch engine — Option A or Option B?

You are deciding a **single architectural question** for vlist 3.0, not approving/rejecting a
document. Deliberate and end with exactly **`RECOMMEND: A`** or **`RECOMMEND: B`**.

## The contradiction you are resolving

RFC-013 §4 currently *proposes Option B (synthetic touch)*. But its own implementation plan
(`docs/refactor/rfc-013-implementation-plan.md`, in the vlist.io repo) *commits to Option A
(idle-rebase + larger runway)* — and the team has already started building A (inverted TDD
tests in `test/core/runway.test.ts`, a Chrome/CDP fling harness, an iOS-Simulator bench). The
two documents disagree on the core decision. Which should v3 actually ship?

## Option A — hardened native runway (idle-rebase), per the implementation plan

- Keep native touch momentum (the browser flings). The fix: **never write `scrollTop` during an
  active gesture** — move the rebase out of `onScrollEvent` (`runway.ts:163,171`) to the **idle**
  boundary, and force a render after re-centering `baseOffset`.
- Raise `BOUNDED_RUNWAY_FACTOR` from **2** (`constants.ts:90`) to a measured **12–16×** so a
  single fling cannot exhaust the runway before idle fires.
- Wheel/keyboard already synthetic; unchanged. Viewport stays `overflow:auto`.
- **Residual risk:** an intermittent momentum stall on iOS if a fling somehow reaches a hard
  runway edge before idle — a *catastrophic* failure mode (hard stop), but made physically
  unreachable by the larger runway. Device-validated.
- **Cost:** small — two changes to `runway.ts` + one constant; tests/harness/bench already in
  progress. Does **not** dissolve the rebase race; it makes it unreachable.

## Option B — scoped-minimal synthetic touch

- Own touch entirely: viewport touch/pointer listeners + an input FSM + a **signed**
  touch-velocity sampler + an exponential-decay inertia tick driving `setLogical`
  (`runway.ts:147`). No runway, no rebase, no `scrollTop` write → the momentum-kill class
  **cannot occur.**
- Scope: ships the inertia core + boundary scroll-chaining passthrough + per-axis `touch-action`;
  **defers** rubber-band / iOS feel-parity post-3.0 (boundary = hard stop in v3).
- **Residual risk:** *feel parity* — a hand-built deceleration that doesn't match iOS-native (a
  *tunable* gap, not a stall).
- **Cost — grounded in the code (verified 2026-06-14):**
  - `velocity.ts` is **unsigned, render-sampled, 2-sample** (`Math.abs(...)` from
    `state.scrollPosition`) — it **cannot** seed a touch fling; a new signed per-`touchmove`
    sampler is required.
  - Touch driver needs a real **FSM** (idle/axis-pending/tracking/inertia/cancelled +
    touchcancel, multi-touch, resize, programmatic-scroll-during-inertia, scrollbar coexistence).
  - **Scroll chaining is not trivial** — once `preventDefault`'d, Blink/WebKit don't reliably
    hand the gesture back to a parent; the decision must be made before the first `preventDefault`.
  - **`touch-action: none` breaks the table plugin**, which reads/writes native
    `viewport.scrollLeft` for header sync + keyboard column nav (`table/plugin.ts:355,457,465`);
    needs per-axis `touch-action` (`pan-x`/`pan-y`).
  - Integration surface: **172 refs to `baseOffset`/`scrollPosition` across 26 files** must route
    through the adapter before the engine can be swapped safely.

## What to weigh

- **Shipping risk & scope** for a 3.0 deliverable (A is mostly built; B is net-new input handling).
- **Bug class:** A *manages* the rebase race (makes it unreachable); B *dissolves* it.
- **Failure modes:** A's residual is a catastrophic *stall*; B's is a tunable *feel gap*.
- **The camera framing** (RFC §1) is "real" only if the engine owns its input (argues for B), but
  v3 can adopt the vocabulary without shipping B.
- **Sunk/parallel work** on A, and whether B is better as the **first post-3.0 spatial increment**.

You may read the vlist codebase in your working directory to verify any claim. Deliberate with the
other reviewers; in later rounds, respond to their arguments. End with **`RECOMMEND: A`** or
**`RECOMMEND: B`** (and, if useful, one line on what would change your mind).
