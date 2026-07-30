const test = require('node:test');
const assert = require('node:assert/strict');

const {
  localMonitorRef,
  resolveSavedMapping,
  scoreRemoteDisplay,
} = require('../dist-tests/mapping.js');

const local = (label, x, primary = false) => ({
  label,
  width: 2560,
  height: 1440,
  bounds: { x, y: 0 },
  primary,
});

const remote = (id, label, x, internal = false) => ({
  id,
  label,
  width: 2560,
  height: 1440,
  x,
  y: 0,
  primary: x === 0,
  virtual: false,
  internal,
  refreshRate: 60,
});

const savedSlot = (monitor, host) => ({
  mon: localMonitorRef(monitor),
  kind: 'host',
  host,
  res: 'auto',
  fps: '60',
});

test('a changed local topology is exposed as partial instead of auto-starting screen 1', () => {
  const oldMonitors = [local('Left', -2560), local('Middle', 0, true), local('Right', 2560)];
  const hostDisplays = [
    remote(11, 'Host left', -2560),
    remote(12, 'Host middle', 0),
    remote(13, 'Host right', 2560),
  ];
  const saved = {
    version: 2,
    slots: oldMonitors.map((monitor, index) => savedSlot(monitor, hostDisplays[index])),
  };

  const changed = [local('Middle', 0, true), local('New 4K monitor', 3840)];
  changed[1].width = 3840;
  changed[1].height = 2160;
  const resolved = resolveSavedMapping(saved, changed, hostDisplays);

  assert.equal(resolved.size, 1);
  assert.equal(resolved.get(0).choice, '12');
});

test('closed internal host display is omitted while matched external screens remain', () => {
  const monitors = [local('Left', -2560), local('Middle', 0, true), local('Right', 2560)];
  const internal = { ...remote(21, 'Built-in Retina Display', 0, true), primary: true };
  const left = remote(22, 'External A', -2560);
  const right = remote(23, 'External B', 2560);
  const saved = {
    version: 2,
    slots: [
      savedSlot(monitors[0], left),
      savedSlot(monitors[1], internal),
      savedSlot(monitors[2], right),
    ],
  };

  const resolved = resolveSavedMapping(saved, monitors, [left, right]);
  assert.equal(resolved.size, 3);
  assert.equal(resolved.get(0).choice, '22');
  assert.equal(resolved.get(1).choice, 'none');
  assert.equal(resolved.get(1).missingHost, true);
  assert.equal(resolved.get(2).choice, '23');
});

test('remote matching prefers stable internal/position identity when IDs change', () => {
  const before = remote(100, 'Built-in Retina Display', 0, true);
  const after = remote(999, 'Built-in Retina Display', 0, true);
  const unrelated = remote(100, 'External', 2560, false);
  assert.ok(scoreRemoteDisplay(before, after) > scoreRemoteDisplay(before, unrelated));
});

test('legacy saved built-in label cannot steal an external display after lid close', () => {
  const legacyBuiltIn = {
    id: 44,
    label: 'Built-in Retina Display',
    width: 2560,
    height: 1440,
    primary: true,
    virtual: false,
  };
  const external = remote(44, 'External Display', 0, false);
  assert.equal(scoreRemoteDisplay(legacyBuiltIn, external), 0);
});
