import { describe, expect, it } from 'vitest';
import type { BrowserEngine } from '../src/shared/types/browser';

const plan: BrowserEngine[] = [
  'chromium', 'firefox', 'webkit', 'edge', 'opera',
  'chromium', 'firefox', 'webkit', 'edge', 'opera'
];

describe('default cross-browser plan', () => {
  it('contains exactly two slots for each requested browser family', () => {
    expect(plan).toHaveLength(10);
    for (const engine of ['chromium', 'firefox', 'webkit', 'edge', 'opera'] as BrowserEngine[]) {
      expect(plan.filter((item) => item === engine)).toHaveLength(2);
    }
  });
});
