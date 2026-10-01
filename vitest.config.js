import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The VS Code host-wiring suite runs under @vscode/test-electron with
    // mocha (needs the real vscode module) — never under vitest.
    exclude: ['**/node_modules/**', '**/dist/**', '**/vscode-ext/test/suite/**'],
  },
});