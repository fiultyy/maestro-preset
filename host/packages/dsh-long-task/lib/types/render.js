/** Canonical plain-text rendering of the hardcoded long-task ledger. */
/**
 * Render the full ledger in its stable five-section form. The model re-reads
 * this at every seam; the driver injects it into continuation rounds and the
 * context policy folds it into a handoff checkpoint. Bounded by construction:
 * core, checkpoints, and open questions are capped by the service.
 * @param task - current durable snapshot.
 * @returns one deterministic multi-line ledger string.
 */
export function renderLongTaskLedger(task) {
    const core = task.core.length === 0
        ? ['  (empty)']
        : task.core.map((entry, index) => `  [${index < 2 ? 'live' : 'parked'}] ${entry}`);
    const verified = task.checkpoints.length === 0
        ? ['  (none yet)']
        : task.checkpoints.map(c => `  ✓${String(c.seq).padStart(2, '0')} ${c.statement} — verified by: ${c.verifiedBy}`);
    const open = task.openQuestions.length === 0
        ? ['  (none)']
        : task.openQuestions.map(q => `  ?${String(q.seq).padStart(2, '0')} ${q.question} — settled by: ${q.settledBy}`);
    return [
        '<long_task_ledger>',
        `Objective: ${task.objective}`,
        `Phase: ${task.phase} | Rounds: ${task.maxRounds} | Handoffs: ${task.handoffs}`,
        'Core:',
        ...core,
        'Verified:',
        ...verified,
        'Open:',
        ...open,
        `Next: ${task.next}`,
        '</long_task_ledger>',
    ].join('\n');
}
//# sourceMappingURL=render.js.map