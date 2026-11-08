import { describe, expect, it } from 'vitest';
import { resolveLatestModel } from './latestModel';

describe('resolveLatestModel', () => {
    it('maps pinned Opus and Sonnet ids to their family alias', () => {
        expect(resolveLatestModel('claude-opus-5', {})).toBe('opus');
        expect(resolveLatestModel('claude-opus-4-1-20250805', {})).toBe('opus');
        expect(resolveLatestModel('claude-sonnet-4-5-20250929', {})).toBe('sonnet');
        expect(resolveLatestModel('CLAUDE-SONNET-5', {})).toBe('sonnet');
    });

    it('keeps the 1M context suffix', () => {
        expect(resolveLatestModel('claude-opus-5[1m]', {})).toBe('opus[1m]');
        expect(resolveLatestModel('claude-sonnet-4-5[1m]', {})).toBe('sonnet[1m]');
    });

    it('leaves aliases, other families and unknown strings unchanged', () => {
        expect(resolveLatestModel('opus', {})).toBe('opus');
        expect(resolveLatestModel('sonnet[1m]', {})).toBe('sonnet[1m]');
        expect(resolveLatestModel('claude-haiku-4-5', {})).toBe('claude-haiku-4-5');
        expect(resolveLatestModel('claude-opus', {})).toBe('claude-opus');
        expect(resolveLatestModel('us.anthropic.claude-opus-4-1-v1:0', {})).toBe('us.anthropic.claude-opus-4-1-v1:0');
    });

    it('passes undefined through', () => {
        expect(resolveLatestModel(undefined, {})).toBeUndefined();
    });

    it('keeps the exact id when HAPPY_MODEL_POLICY=pinned', () => {
        expect(resolveLatestModel('claude-opus-5', { HAPPY_MODEL_POLICY: 'pinned' })).toBe('claude-opus-5');
    });
});
