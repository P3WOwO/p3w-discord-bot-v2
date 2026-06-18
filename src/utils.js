function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d) parts.push(`${d}д`);
  if (h || d) parts.push(`${h}ч`);
  if (m || h || d) parts.push(`${m}м`);
  parts.push(`${s}с`);
  return parts.join(' ');
}

function formatShortTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}д`);
  if (h || d) parts.push(`${h}ч`);
  parts.push(`${m}м`);
  return parts.join(' ');
}

function formatTopTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}д ${h}ч` : `${h}ч`;
}

function clampText(text, max = 2000) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getNextTargetDayUnix(dayOfMonth = 23) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  target.setDate(dayOfMonth);
  if (target <= now) {
    target.setMonth(target.getMonth() + 1);
    target.setDate(dayOfMonth);
  }
  return Math.floor(target.getTime() / 1000);
}

module.exports = {
  pickRandom,
  formatTime,
  formatShortTime,
  formatTopTime,
  clampText,
  getNextTargetDayUnix,
};
