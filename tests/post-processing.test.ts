import { describe, expect, it } from 'vitest';
import { getBloomSettings, isBloomEnabled } from '../src/engine/Post';

describe('bloom quality policy', () => {
  it('enables lightweight bloom for medium and high, but not low', () => {
    expect(getBloomSettings('low').enabled).toBe(false);
    expect(getBloomSettings('medium').enabled).toBe(true);
    expect(getBloomSettings('high').enabled).toBe(true);
  });

  it('allows an explicit toggle to override the quality default', () => {
    expect(isBloomEnabled('high', false)).toBe(false);
    expect(isBloomEnabled('low', true)).toBe(true);
  });

  it('has a predictable pass/draw-call budget when active', () => {
    expect(getBloomSettings('medium').estimatedExtraDrawCalls).toBe(2);
    expect(getBloomSettings('low').estimatedExtraDrawCalls).toBe(0);
  });
});
