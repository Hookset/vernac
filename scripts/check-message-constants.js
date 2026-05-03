'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backgroundPath = path.join(root, 'background.js');
const sharedPath = path.join(root, 'shared', 'messages.js');

function getMsgConstants(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/const\s+MSG\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) throw new Error(`Could not find MSG object in ${filePath}`);

  const constants = {};
  const lineRe = /^\s*([A-Z0-9_]+)\s*:\s*['"]([^'"]+)['"]\s*,?\s*(?:\/\/.*)?$/;
  for (const line of match[1].split('\n')) {
    const m = line.match(lineRe);
    if (m) constants[m[1]] = m[2];
  }

  if (Object.keys(constants).length === 0) {
    throw new Error(`No MSG constants found in ${filePath}`);
  }
  return constants;
}

const background = getMsgConstants(backgroundPath);
const shared = getMsgConstants(sharedPath);
const errors = [];

for (const key of Object.keys(background)) {
  if (!(key in shared)) {
    errors.push(`shared/messages.js is missing ${key}`);
  } else if (background[key] !== shared[key]) {
    errors.push(`Value mismatch for ${key}: background='${background[key]}' shared='${shared[key]}'`);
  }
}

for (const key of Object.keys(shared)) {
  if (!(key in background)) {
    errors.push(`background.js is missing ${key}`);
  }
}

if (errors.length > 0) {
  console.error('MSG constants drift detected:\n' + errors.join('\n'));
  process.exit(1);
}

console.log(`MSG constants are in sync (${Object.keys(shared).length} entries).`);
