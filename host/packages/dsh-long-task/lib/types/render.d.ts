/** Canonical plain-text rendering of the hardcoded long-task ledger. */
import type { LongTaskSnapshot } from './types.ts';
/**
 * Render the full ledger in its stable five-section form. The model re-reads
 * this at every seam; the driver injects it into continuation rounds and the
 * context policy folds it into a handoff checkpoint. Bounded by construction:
 * core, checkpoints, and open questions are capped by the service.
 * @param task - current durable snapshot.
 * @returns one deterministic multi-line ledger string.
 */
export declare function renderLongTaskLedger(task: LongTaskSnapshot): string;
//# sourceMappingURL=render.d.ts.map