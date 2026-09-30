/**
 * Runs the extension host-wiring tests: downloads VS Code, launches it with
 * this extension, and executes the mocha suite in the extension host.
 * Usage: `npm run test:ui` (CI wraps it in xvfb-run -a).
 */
const { runTests } = require('@vscode/test-electron');
const path = require('path');

async function main() {
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      launchArgs: [
        '--disable-extensions',
        '--user-data-dir', path.resolve(__dirname, '.tmp-profile'),
      ],
    });
  } catch (err) {
    console.error('Extension UI tests failed:', err);
    process.exit(1);
  }
}

main();