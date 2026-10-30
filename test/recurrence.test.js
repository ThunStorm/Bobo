const test = require('node:test');
const assert = require('node:assert/strict');
const { occurrences } = require('../public/recurrence');
const weekly = { unit: 'week', interval: 1, weekdays: [2], until: '2026-12-31' };
test('Tuesday markers include endpoints and shorten by editing the same rule', () => {
  assert.deepEqual(occurrences('2026-11-01', '2026-11-01', weekly).map(x => x.start), ['2026-11-03','2026-11-10','2026-11-17','2026-11-24','2026-12-01','2026-12-08','2026-12-15','2026-12-22','2026-12-29']);
  assert.equal(occurrences('2026-11-01', '2026-11-01', { ...weekly, until: '2026-11-30' }).length, 4);
  assert.equal(occurrences('2026-11-03', '2026-11-03', { ...weekly, until: '2026-11-03' }).length, 1);
});
test('biweekly periods anchor on Monday and preserve task duration across years', () => {
  assert.deepEqual(occurrences('2026-12-29', '2026-12-31', { ...weekly, interval: 2, until: '2027-01-31' }), [
    { start: '2026-12-29', end: '2026-12-31' }, { start: '2027-01-12', end: '2027-01-14' }, { start: '2027-01-26', end: '2027-01-28' }
  ]);
});
test('monthly recurrence skips unavailable dates without month-end drift and supports leap days', () => {
  assert.deepEqual(occurrences('2028-01-31','2028-02-01',{ unit:'month',interval:1,until:'2028-05-31' }).map(x=>x.start), ['2028-01-31','2028-03-31','2028-05-31']);
  assert.deepEqual(occurrences('2028-02-29','2028-02-29',{ unit:'month',interval:12,until:'2032-03-01' }).map(x=>x.start), ['2028-02-29','2032-02-29']);
});
test('custom day periods and multiple weekdays are calendar based', () => {
  assert.equal(occurrences('2026-11-01','2026-11-01',{ unit:'day',interval:3,until:'2026-11-10' }).length,4);
  assert.equal(occurrences('2026-11-02','2026-11-02',{ ...weekly, weekdays:[1,5],until:'2026-11-13' }).length,4);
});
test('invalid dates, rules, empty occurrences and excessive expansion fail explicitly', () => {
  for (const rule of [{...weekly, interval:0},{...weekly, interval:1.5},{...weekly,weekdays:[]},{...weekly,weekdays:[2,2]},{...weekly,weekdays:[7]},{...weekly,until:'2026-02-30'},{...weekly,until:'2026-10-01'},{...weekly,until:'2050-01-01'},{...weekly,unit:'year'},{...weekly,until:'2026-11-01'},{unit:'day',interval:1,until:'2030-01-01'}]) {
    assert.throws(()=>occurrences('2026-11-01','2026-11-01',rule));
  }
  assert.throws(()=>occurrences('2026-02-30','2026-03-01',weekly));
  assert.throws(()=>occurrences('2026-11-03','2026-11-01',weekly));
});
test('legacy single occurrences remain unchanged', () => {
  assert.deepEqual(occurrences('2026-11-01','2026-11-02',null), [{start:'2026-11-01',end:'2026-11-02'}]);
});
