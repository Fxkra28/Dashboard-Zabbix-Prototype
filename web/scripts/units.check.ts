/** Assertions for web/src/lib/units.ts. Run: npx tsx web/scripts/units.check.ts */
import assert from 'node:assert/strict';
import { dur, formatValue, formatDuration } from '../src/lib/units.ts';
import { naturalCompare, siteFromHostName } from '../src/lib/sites.ts';
import { monthBounds } from '../src/lib/time.ts';

const eq = (actual: string, expected: string) => assert.equal(actual, expected);

eq(formatValue(null), '—');
eq(formatValue(undefined, 'bps'), '—');
eq(formatValue(NaN, '%'), '—');

eq(formatValue(0, 'bps'), '0 bps');
eq(formatValue(999, 'bps'), '999 bps');
eq(formatValue(1500, 'bps'), '1.5 Kbps');
eq(formatValue(24_192_312, 'bps'), '24.19 Mbps');
eq(formatValue(20_000_000_000, 'bps'), '20 Gbps');
eq(formatValue(500_000_000, 'bps'), '500 Mbps');
eq(formatValue(100_000, 'bps'), '100 Kbps');
eq(formatValue(10, 'bps'), '10 bps');
eq(formatValue(300, 's'), '5 min');
eq(formatValue(100, 'ms'), '100 ms');
eq(formatValue(107_715_584, 'b/s'), '107.7 Mbps');

eq(formatValue(1024, 'B'), '1 KB');
eq(formatValue(1_039_176_940, 'B'), '991 MB');
eq(formatValue(1536, 'Bps'), '1.5 KB/s');
eq(formatValue(512, 'B'), '512 B');

eq(formatValue(23.77704635174604, '%'), '23.78 %');
eq(formatValue(100, '%'), '100.00 %');

eq(formatValue(0.123, 's'), '123 ms');
eq(formatValue(0.0254, 's'), '25.4 ms');
eq(formatValue(2.5, 's'), '2.5 s');
eq(formatValue(90, 's'), '1.5 min');
eq(formatValue(7200, 's'), '2 h');

eq(formatValue(3 * 86400 + 4 * 3600 + 120, 'uptime'), '3d 4h');
eq(formatDuration(3600 * 5 + 60 * 7), '5h 7m');
eq(dur(45), '45s');
eq(dur(750), '13m');
eq(dur(3.5 * 3600), '3.5h');
eq(dur(2.1 * 86400), '2.1d');
eq(dur(-5400), '−1.5h');
eq(dur(-0.4), '0s');
assert.match(formatValue(1789617000, 'unixtime'), /2026/);

eq(formatValue(49, '°C'), '49 °C');
eq(formatValue(1, ''), '1');
eq(formatValue(0.5), '0.5');
eq(formatValue(123456), '123,456');

assert.ok(naturalCompare('Gi1/0/2', 'Gi1/0/10') < 0);
assert.ok(naturalCompare('1.2.2. IDXSVFSW01', '1.2.10 IDX24C') < 0);
assert.deepEqual(siteFromHostName('2.1. SUB11FW01'), { code: 2, name: 'Surabaya' });
assert.deepEqual(siteFromHostName('INET : TWSB LINI 2 WAN 1'), { code: 14, name: 'TWSB' });
assert.equal(siteFromHostName('INTERNET'), null);
assert.deepEqual(monthBounds('2026-08'), { from: 1785517200, to: 1788195600 });
assert.deepEqual(monthBounds('2026-12'), { from: 1796058000, to: 1798736400 });

console.log('units.check: all assertions passed');
