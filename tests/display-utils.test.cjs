const test = require('node:test');
const assert = require('node:assert/strict');

const {
  connectedDisplays,
  displayIdsEqual,
  findCaptureSource,
  findDisplayById,
  normalizedDisplayId,
} = require('../dist/electron/display-utils.js');
const { parseClamshellState } = require('../dist/electron/clamshell.js');

test('display IDs compare across signed and unsigned 32-bit representations', () => {
  assert.equal(normalizedDisplayId(-1), 0xffffffff);
  assert.equal(displayIdsEqual(-1, '4294967295'), true);
  assert.equal(displayIdsEqual(42, '42'), true);
  assert.equal(displayIdsEqual(42, '43'), false);
});

test('capture source lookup never falls back to screen 1', () => {
  const sources = [
    { display_id: '101', id: 'screen:1' },
    { display_id: '202', id: 'screen:2' },
  ];
  assert.equal(findCaptureSource(sources, 202), sources[1]);
  assert.equal(findCaptureSource(sources, 999), undefined);
});

test('closed MacBook lid removes only the internal detected display', () => {
  const displays = [
    { id: 1, internal: true, detected: true },
    { id: 2, internal: false, detected: true },
    { id: 3, internal: false, detected: false },
  ];
  assert.deepEqual(connectedDisplays(displays, true, true).map((d) => d.id), [2]);
  assert.deepEqual(connectedDisplays(displays, false, true).map((d) => d.id), [1, 2]);
  assert.deepEqual(connectedDisplays(displays, true, false).map((d) => d.id), [1, 2]);
  assert.equal(findDisplayById(displays, 2), displays[1]);
});

test('ioreg clamshell state parser handles open, closed and unavailable output', () => {
  assert.equal(parseClamshellState('"AppleClamshellState" = Yes'), true);
  assert.equal(parseClamshellState('"AppleClamshellState" = No'), false);
  assert.equal(parseClamshellState(''), null);
});
