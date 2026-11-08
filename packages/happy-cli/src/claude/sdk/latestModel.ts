/**
 * Latest-flagship model policy.
 *
 * Mobile clients pick a concrete model id (e.g. `claude-opus-5`) based on the
 * CLI version they see, and older app builds keep sending ids that have been
 * superseded. Claude Code resolves the family aliases (`opus`, `sonnet`,
 * optionally with `[1m]`) to the newest model it ships, so mapping pinned
 * Opus/Sonnet ids to their alias keeps sessions on the latest flagship without
 * an app release. Set HAPPY_MODEL_POLICY=pinned to pass ids through unchanged.
 */

const PINNED_FLAGSHIP = /^claude-(opus|sonnet)-\d[\w.-]*?(\[1m\])?$/i;

/**
 * Returns the family alias for a pinned Opus/Sonnet id, or the input unchanged.
 */
export function resolveLatestModel(model: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!model || env.HAPPY_MODEL_POLICY === 'pinned') return model;
    const match = PINNED_FLAGSHIP.exec(model);
    return match ? match[1].toLowerCase() + (match[2] ?? '') : model;
}
