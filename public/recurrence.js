/* Shared calendar rules: UTC calendar arithmetic avoids DST shifts. */
(function (root) {
  function day(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('日期格式无效');
    const time = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('日期无效');
    return time / 86400000;
  }
  const date = (value) => new Date(value * 86400000).toISOString().slice(0, 10);
  function occurrences(start, end, rule) {
    if (!rule) return [{ start, end }];
    const first = day(start), last = day(rule.until), duration = day(end) - first;
    if (duration < 0 || duration > 3660 || last < first || last - first > 3660) throw new Error('重复范围需在开始日起十年内，结束不得早于开始');
    if (!['day', 'week', 'month'].includes(rule.unit) || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 120) throw new Error('重复间隔需为 1–120 的整数');
    if (rule.unit === 'week' && (!Array.isArray(rule.weekdays) || !rule.weekdays.length || rule.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6) || new Set(rule.weekdays).size !== rule.weekdays.length)) throw new Error('请选择不重复的星期');
    const result = [];
    const anchor = new Date(first * 86400000);
    const monday = first - (anchor.getUTCDay() + 6) % 7;
    for (let current = first; current <= last; current++) {
      const d = new Date(current * 86400000);
      let match;
      if (rule.unit === 'day') match = (current - first) % rule.interval === 0;
      if (rule.unit === 'week') match = Math.floor((current - monday) / 7) % rule.interval === 0 && rule.weekdays.includes(d.getUTCDay());
      if (rule.unit === 'month') match = ((d.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + d.getUTCMonth() - anchor.getUTCMonth()) % rule.interval === 0 && d.getUTCDate() === anchor.getUTCDate();
      if (match) result.push({ start: date(current), end: date(current + duration) });
      if (result.length > 1000) throw new Error('重复次数不能超过 1000 次，请缩短范围或增大间隔');
    }
    if (!result.length) throw new Error('范围内没有符合规则的日期');
    return result;
  }
  function validateMarkers(markers) {
    if (!Array.isArray(markers)) throw new Error('日期标记必须为数组');
    for (const marker of markers) if (marker.recurrence) occurrences(marker.date, marker.date, marker.recurrence);
  }
  const api = { occurrences, validateMarkers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoboRecurrence = api;
})(typeof globalThis === 'object' ? globalThis : this);
