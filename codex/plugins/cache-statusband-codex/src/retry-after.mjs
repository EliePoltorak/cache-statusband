// Retry-After, read from exactly two places. Nothing else is ever read; in particular no prose
// ("retry after 20 minutes", "retry at ...") is parsed.
//
// 1. STRUCTURED error data (the rpcData object, walked to a depth of 8): a key that starts with
//    retry_after or retry_at (also retry-after, retryAfter, RetryAt ...), optionally followed by a
//    unit word in snake, kebab or camel case (retry_after_ms, retry-after-seconds, retryAfterMs,
//    retryAtMs). The value is read as:
//      * a number, in the key's unit (seconds when it has none); retry_at without a duration unit
//        is a moment as an epoch count (seconds, or milliseconds for retry_at_ms);
//      * a string: a plain non-negative integer or decimal (read like a number), an HTTP-date, or
//        an ISO 8601 date-time with a zone (Z, +hh, +hhmm, +hh:mm; no zone = UTC);
//      * an object {secs, nanos}, {seconds} or {ms};
//      * null or undefined: nothing.
//    Any other string, object, array or boolean is "named but unreadable", which is the cap.
// 2. HTTP header LINES in the error message (RFC 9110). The message is split on CRLF, LF or CR. A
//    line that, after optional leading whitespace, starts with "Retry-After" (any case), optional
//    whitespace and ":" has the rest of the line, trimmed, as its value; a JSON header dump
//    ("retry-after": "30" or "retry-after": 30, anywhere in a line) has its quoted or bare token
//    as its value. One pair of surrounding double quotes on a value is dropped. The value must be
//    delay-seconds (a non-negative integer) or an HTTP-date (IMF-fixdate, obsolete RFC 850, or
//    asctime); a Retry-After with any other value is the cap.
//
// A wait that parsed always beats a cap; the cap answers only when no value parsed at all. No key
// anywhere answers null (the caller's own five-minute floor). The result is never negative or NaN,
// and a moment already past is 0.

export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_DEPTH = 8;
const STRING_CHARS = 200;

const STRUCTURED_KEY = /^retry[_-]?(after|at)(?:[_-]?(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|s|m|h))?$/i;
const PLAIN_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const DELAY_SECONDS = /^\d+$/;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
// One JSON header-map entry: "retry-after": "30" or "retry-after": 30 (value at most STRING_CHARS).
const JSON_HEADER = /"retry-after"\s*:\s*(?:"([^"]{0,200})"|([^,}\]\s]{0,200}))/gi;
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
const IMF_DATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`, "i");
const RFC850_DATE = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`, "i");
const ASCTIME_DATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} {1,2}(\\d{1,2}) ${TIME} (\\d{4})$`, "i");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function unitMilliseconds(unit) {
  const name = unit.toLowerCase();
  if (name.startsWith("ms") || name.startsWith("milli")) return 1;
  if (name.startsWith("h")) return HOUR;
  if (name.startsWith("m")) return MINUTE;
  return SECOND;
}

// Milliseconds since the epoch for a real calendar moment (UTC), or NaN.
function utcTime(year, month, day, hour, minute, second) {
  const time = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(time);
  const real = check.getUTCDate() === day && check.getUTCMonth() === month && hour < 24 && minute < 60 && second <= 60;
  return real ? time : NaN;
}

// An RFC 9110 HTTP-date in any of its three forms, as milliseconds since the epoch, or NaN.
function httpDate(text, now) {
  let match = IMF_DATE.exec(text);
  if (match) return utcTime(+match[3], MONTHS.indexOf(match[2].toLowerCase()), +match[1], +match[4], +match[5], +match[6]);
  match = RFC850_DATE.exec(text);
  if (match) {
    // A two-digit year more than 50 years ahead of now means the most recent matching past year.
    let year = Math.floor(new Date(now).getUTCFullYear() / 100) * 100 + +match[3];
    if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
    return utcTime(year, MONTHS.indexOf(match[2].toLowerCase()), +match[1], +match[4], +match[5], +match[6]);
  }
  match = ASCTIME_DATE.exec(text);
  if (match) return utcTime(+match[6], MONTHS.indexOf(match[1].toLowerCase()), +match[2], +match[3], +match[4], +match[5]);
  return NaN;
}

// An ISO 8601 date-time as milliseconds since the epoch (no zone = UTC), or NaN.
function isoDate(text) {
  const match = ISO_DATE_TIME.exec(text);
  if (!match) return NaN;
  const [, date, time, zone = "Z"] = match;
  const offset = zone.length === 3 ? `${zone}:00` : zone.length === 5 ?`${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  return Date.parse(`${date}T${time}${offset.toUpperCase()}`);
}

// Records one stated wait: a finite number is a parsed wait, null an unreadable one (the cap).
function record(wait, found) {
  if (wait === null || Number.isNaN(wait)) found.caps += 1;
  else found.waits.push(wait);
}

// {secs, nanos}, {seconds} or {ms} read as a wait in milliseconds; null for any other shape.
function objectWait(value) {
  if (Array.isArray(value)) return null;
  const count = (field) => (typeof field === "number" && Number.isFinite(field) ? field : null);
  const secs = count(value.secs) ?? count(value.seconds);
  if (secs !== null) return secs * SECOND + (count(value.nanos) ?? 0) / 1e6;
  return count(value.ms) ?? count(value.milliseconds);
}

// Records what a structured key states, if it is a retry key. null or undefined states nothing.
function structuredWait(key, value, now, found) {
  const match = STRUCTURED_KEY.exec(key);
  if (!match || value === null || value === undefined) return;
  const [, kind, unit] = match;
  const scale = unit ? unitMilliseconds(unit) : null;
  // retry_at is a moment unless its unit is a duration longer than a second (retry_at_minutes).
  const absolute = kind.toLowerCase() === "at" && (scale === null || scale <= SECOND);
  if (typeof value === "object") return record(absolute ? null : objectWait(value), found);
  if (typeof value === "boolean") return record(null, found);
  let number = value;
  if (typeof value === "string") {
    const text = value.slice(0, STRING_CHARS).trim();
    if (PLAIN_NUMBER.test(text)) number = Number(text);
    else {
      const time = httpDate(text, now);
      return record(Number.isNaN(time) ? isoDate(text) - now : time - now, found);
    }
  }
  if (typeof number !== "number" || Number.isNaN(number)) return record(null, found);
  // A moment as an epoch count: seconds, or milliseconds for retry_at_ms.
  record(absolute ? number * (scale ?? SECOND) - now : number * (scale ?? SECOND), found);
}

// The wait stated by one Retry-After value from message text: delay-seconds or an HTTP-date.
// Anything else is null (the cap).
function headerWait(value, now) {
  const text = value.trim().replace(/^"(.*)"$/s, "$1");
  if (DELAY_SECONDS.test(text)) return Number(text) * SECOND;
  const time = httpDate(text, now);
  return Number.isNaN(time) ? null : time - now;
}

// Every Retry-After stated by a header line or JSON header entry in the message.
function messageWaits(message, now, found) {
  for (const line of message.split(/\r\n|\n|\r/)) {
    const text = line.trimStart();
    if (text.slice(0, 11).toLowerCase() === "retry-after") {
      const rest = text.slice(11).trimStart();
      if (rest[0] === ":") {
        // Anything longer than a date is no date; the cap, not a long read.
        const value = rest.slice(1).trim();
        record(value.length > STRING_CHARS ? null : headerWait(value, now), found);
      }
    }
    if (!/retry-after/i.test(line)) continue;
    for (const entry of line.matchAll(JSON_HEADER)) record(headerWait(entry[1] ?? entry[2], now), found);
  }
}

// Never negative, never NaN; a count too big to hold is as long as a wait can be.
function clean(value) {
  return Number.isNaN(value) ? MAX_RETRY_AFTER_MS : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const data = error?.rpcData ?? error?.data ?? null;
  const found = { waits: [], caps: 0 };
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      structuredWait(key, child, now, found);
      walk(child, depth + 1);
    }
  };
  walk(data, 0);
  const message = error?.rpcMessage ?? error?.message;
  if (typeof message === "string") messageWaits(message, now, found);
  // A parsed wait always wins; the cap answers only when nothing parsed at all.
  if (found.waits.length > 0) return found.waits.reduce((longest, wait) => Math.max(longest, clean(wait)), 0);
  return found.caps > 0 ? MAX_RETRY_AFTER_MS : null;
}
