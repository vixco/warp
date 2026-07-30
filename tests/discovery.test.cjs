const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMagicPacket,
  normalizeMac,
  normalizeMacList,
  parseHardwarePortMacs,
} = require('../dist/electron/discovery.js');

test('normalizes and deduplicates wake MAC addresses', () => {
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('invalid'), null);
  assert.deepEqual(
    normalizeMacList(['AA-BB-CC-DD-EE-FF', 'aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66']),
    ['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'],
  );
});

test('builds a standards-compliant 102-byte magic packet', () => {
  const packet = buildMagicPacket('01:23:45:67:89:ab');
  assert.ok(packet);
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let offset = 6; offset < packet.length; offset += 6) {
    assert.deepEqual([...packet.subarray(offset, offset + 6)], [1, 35, 69, 103, 137, 171]);
  }
});

test('extracts hardware MACs from macOS networksetup output', () => {
  const output = `
Hardware Port: Wi-Fi
Device: en0
Ethernet Address: a0:9a:8e:32:38:4a

Hardware Port: Ethernet
Device: en3
Ethernet Address: 10:20:30:40:50:60
`;
  assert.deepEqual(parseHardwarePortMacs(output), [
    'a0:9a:8e:32:38:4a',
    '10:20:30:40:50:60',
  ]);
});
