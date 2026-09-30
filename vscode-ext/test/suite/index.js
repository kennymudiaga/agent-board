/**
 * Mocha entry point executed inside the VS Code extension host.
 */
const Mocha = require('mocha');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 30_000, color: true });
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
  for (const f of files) mocha.addFile(path.join(__dirname, f));
  await new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}

module.exports = { run };