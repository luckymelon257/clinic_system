// F-44 / BR-17: ONE server-side script per reading, so the stream append, the "latest" hash, the threshold check
// and the alert fan-out happen atomically in one round trip. Thresholds are identical to fn_icu_violations (011)
// and in the same order: HR < 40 | > 140, SpO2 < 88, SBP < 80 | > 200, RR < 8 | > 30, t° > 39.5.
//
// KEYS[1] stream icu:vitals · KEYS[2] hash icu:latest:{bedId} · KEYS[3] list icu:events
// ARGV  1 channel · 2 bedId · 3 patientId ('' = unknown) · 4 atMs · 5 hr · 6 spo2 · 7 sbp · 8 dbp · 9 rr · 10 temp
//       11 MAXLEN (approximate) · 12 latest TTL seconds · 13 events list length
// Returns { streamId, alertJson | '' }.
export const ICU_INGEST_LUA = `
local hr, spo2, sbp, dbp, rr, temp = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10])
local v = {}
local function add(sign, value, rule) v[#v + 1] = { sign = sign, value = value, rule = rule } end
if hr < 40 then add('hr', hr, '< 40') end
if hr > 140 then add('hr', hr, '> 140') end
if spo2 < 88 then add('spo2', spo2, '< 88') end
if sbp < 80 then add('sbp', sbp, '< 80') end
if sbp > 200 then add('sbp', sbp, '> 200') end
if rr < 8 then add('rr', rr, '< 8') end
if rr > 30 then add('rr', rr, '> 30') end
if temp > 39.5 then add('temp', temp, '> 39.5') end

local alert = #v > 0
local fields = { 'bed', ARGV[2], 'patient', ARGV[3], 'at', ARGV[4], 'hr', ARGV[5], 'spo2', ARGV[6], 'sbp', ARGV[7],
  'dbp', ARGV[8], 'rr', ARGV[9], 'temp', ARGV[10], 'alert', alert and '1' or '0' }
local json = ''
if alert then
  local vitals = { hr = hr, spo2 = spo2, sbp = sbp, dbp = dbp, rr = rr, temp = temp, at = tonumber(ARGV[4]) }
  local body = { bedId = tonumber(ARGV[2]), violations = v, vitals = vitals, atMs = tonumber(ARGV[4]) }
  if ARGV[3] ~= '' then body.patientId = tonumber(ARGV[3]) end
  fields[#fields + 1] = 'violations'
  fields[#fields + 1] = cjson.encode(v)
  local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[11], '*', unpack(fields))
  body.id = id
  json = cjson.encode(body)
  redis.call('HSET', KEYS[2], 'hr', ARGV[5], 'spo2', ARGV[6], 'sbp', ARGV[7], 'dbp', ARGV[8], 'rr', ARGV[9], 'temp', ARGV[10], 'at', ARGV[4], 'streamId', id, 'alert', '1')
  redis.call('EXPIRE', KEYS[2], ARGV[12])
  redis.call('PUBLISH', ARGV[1], json)
  redis.call('LPUSH', KEYS[3], json)
  redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[13]) - 1)
  return { id, json }
end
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[11], '*', unpack(fields))
redis.call('HSET', KEYS[2], 'hr', ARGV[5], 'spo2', ARGV[6], 'sbp', ARGV[7], 'dbp', ARGV[8], 'rr', ARGV[9], 'temp', ARGV[10], 'at', ARGV[4], 'streamId', id, 'alert', '0')
redis.call('EXPIRE', KEYS[2], ARGV[12])
return { id, '' }
`;
