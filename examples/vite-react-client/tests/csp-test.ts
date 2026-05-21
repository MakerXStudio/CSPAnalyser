import { test as base, expect } from 'playwright/test';
import { createCspTest } from '@makerx/csp-analyser/playwright';

export const test = createCspTest(base, {
  outputDir: 'examples/vite-react-client/test-results/csp-analyser',
  format: 'json',
  strictness: 'moderate',
  includeHashes: true,
  useHashes: true,
  collapseHashThreshold: 40,
  project: 'vite-react-client',
});

export { expect };
