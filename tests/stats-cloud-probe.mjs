// Optional read-only provider proof: synthetic literals only, no dataset reads or writes.
// CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be supplied locally.
import assert from 'node:assert/strict';
const account=process.env.CLOUDFLARE_ACCOUNT_ID, token=process.env.CLOUDFLARE_API_TOKEN;
assert.match(account??'',/^[a-fA-F0-9]{32}$/); assert.ok(token,'Missing local query credential');
for(const [instant,zone,hour,day] of [
 ['2026-03-08T06:30:00Z','America/New_York',1772949600,1772946000],
 ['2026-03-08T07:30:00Z','America/New_York',1772953200,1772946000],
 ['2026-11-01T05:30:00Z','America/New_York',1793509200,1793505600],
 ['2026-11-01T06:30:00Z','America/New_York',1793512800,1793505600],
 ['2026-10-10T16:30:00Z','Asia/Shanghai',1791648000,1791648000],
]){
 const time=Date.parse(instant)/1000;
 const sql=`SELECT toUnixTimestamp(toStartOfInterval(toDateTime(${time}), INTERVAL '1' HOUR, '${zone}')) AS hour, toUnixTimestamp(toStartOfInterval(toDateTime(${time}), INTERVAL '1' DAY, '${zone}')) AS day, hex('é') AS encoded FORMAT JSON`;
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,{method:'POST',redirect:'manual',headers:{Authorization:`Bearer ${token}`},body:sql});
 assert.equal(response.status,200,`Provider HTTP ${response.status}`);
 const data=await response.json();
 // Never include upstream raw bodies in failed assertions; they can echo SQL or diagnostics.
 assert.ok(data.data?.[0]?.hour===hour,`${instant}: hour mismatch`);
 assert.ok(data.data?.[0]?.day===day,`${instant}: day mismatch`);
 assert.ok(data.data?.[0]?.encoded==='C3A9','UTF-8 hex mismatch');
 console.log(`${instant} ${zone}: hour=${hour}, day=${day}, UTF-8 hex verified`);
}
