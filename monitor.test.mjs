import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, NETWORKS, NETWORK_CONFIG, INTERVAL_MINUTES, normalize, classify, confirm, boundedJson, measure, parseState } from './monitor.mjs';
const records = target => NETWORKS.map(n => ({ probe: n, result: { status: 'finished', statusCode: target.api ? 401 : 200,
  tls: { authorized: true }, headers: { 'content-type': target.api ? 'application/json' : 'text/html' }, timings: { total: 100 },
  rawBody: target.api ? '{"ok":false,"error":"Unauthenticated"}' : '<title>Мастерская</title><div id="root"></div><script src="/assets/index.js"></script>' } }));
for (const target of TARGETS) test(`${target.id}: expected public response`, () => assert.equal(classify(normalize(target, records(target))), 'up'));
test('six distinct Russian locations fit the anonymous budget at ten-minute intervals', () => {
  assert.equal(NETWORKS.length, 6);
  assert.ok(NETWORKS.every(n => n.country === 'RU' && typeof n.city === 'string' && n.city.length > 0));
  const identities = NETWORKS.map(n => `${n.country}:${n.asn}:${n.city}`);
  assert.equal(new Set(identities).size, NETWORKS.length);
  assert.equal(NETWORK_CONFIG, identities.join('|'));
  assert.equal(INTERVAL_MINUTES, 10);
  const maximumHourlyProbes = NETWORKS.length * TARGETS.length * (60 / INTERVAL_MINUTES) * 2;
  assert.equal(maximumHourlyProbes, 216);
  assert.ok(maximumHourlyProbes < 250);
});
test('missing, duplicate and mismatched probes never green', () => {
  assert.equal(classify(normalize(TARGETS[0], [])), 'unknown');
  const x = records(TARGETS[0]); x.push(x[0]); assert.equal(classify(normalize(TARGETS[0], x)), 'unknown');
  x[0] = { ...x[0], probe: { asn: 123, country: 'US' } }; x.pop(); assert.equal(classify(normalize(TARGETS[0], x)), 'unknown');
});
test('same operator in a different or missing city cannot satisfy the requested location', () => {
  const x = records(TARGETS[0]);
  x[0] = { ...x[0], probe: { ...x[0].probe, city: 'Wrong city' } };
  assert.equal(normalize(TARGETS[0], x)[0].status, 'unknown');
  delete x[0].probe.city;
  assert.equal(normalize(TARGETS[0], x)[0].status, 'unknown');
});
test('TLS failure is down, absent proof is unknown', () => {
  const x = records(TARGETS[0]); x[0].result.tls.authorized = false; assert.equal(classify(normalize(TARGETS[0], x)), 'degraded');
  delete x[0].result.tls; assert.equal(classify(normalize(TARGETS[0], x)), 'unknown');
});
test('bad HTTP and wrong HTML are not green', () => {
  const x = records(TARGETS[0]); x[0].result.statusCode = 503; assert.equal(classify(normalize(TARGETS[0], x)), 'degraded');
  x[0].result.statusCode = 200; x[0].result.rawBody = '<title>Maintenance</title>'; assert.equal(classify(normalize(TARGETS[0], x)), 'degraded');
});
test('unexpected API fields rejected and not retained', () => {
  const x = records(TARGETS[1]); x[0].result.rawBody = '{"ok":false,"error":"Unauthorized","customer":"DO NOT PUBLISH"}';
  const out = normalize(TARGETS[1], x); assert.equal(out[0].status, 'down'); assert.ok(!JSON.stringify(out).includes('DO NOT PUBLISH'));
});
test('probe/resolver failure differs from target failure', () => {
  const x = records(TARGETS[0]); x[0].result = { status: 'failed', failureSource: 'probe' }; assert.equal(normalize(TARGETS[0], x)[0].status, 'unknown');
  x[0].result.failureSource = 'target'; assert.equal(normalize(TARGETS[0], x)[0].status, 'down');
});
test('confirmation requires matching states from matching networks', () => {
  const first = normalize(TARGETS[0], records(TARGETS[0]));
  assert.equal(classify(confirm(first, first)), 'up');
  const second = structuredClone(first); second[0].status = 'down'; assert.equal(classify(confirm(first, second)), 'unknown');
});
test('confirmation rejects a different city even with matching country, operator and status', () => {
  const first = normalize(TARGETS[0], records(TARGETS[0]));
  const second = structuredClone(first); second[0].city = 'Wrong city';
  assert.equal(confirm(first, second)[0].status, 'unknown');
});
test('provider limit does not become application outage', async () => assert.equal(classify(await measure(TARGETS[0], async () => new Response('{}', { status: 429 }))), 'unknown'));
test('provider response is bounded', async () => await assert.rejects(boundedJson('https://example.com', {}, async () => new Response('x'.repeat(600000)))));
test('measurement only sends public GET URLs with exact country, ASN and city filters', async () => {
  let count = 0;
  const out = await measure(TARGETS[1], async (url, init) => {
    count++;
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); assert.equal(body.target, 'edge.klochkov.tech'); assert.equal(body.measurementOptions.request.path, '/auth/me');
      assert.equal(body.measurementOptions.request.method, 'GET'); assert.equal(body.locations.length, NETWORKS.length);
      assert.deepEqual(body.locations, NETWORKS.map(n => ({ asn: n.asn, country: n.country, city: n.city, limit: 1 })));
      assert.ok(!('Authorization' in body.measurementOptions.request.headers));
      return new Response('{"id":"abcdefgh12345"}');
    }
    return new Response(JSON.stringify({ status: 'finished', results: records(TARGETS[1]) }));
  }, async () => {});
  assert.equal(count, 2); assert.equal(classify(out), 'up');
});
test('invalid state is rejected', () => { assert.equal(parseState('hello'), null); assert.equal(parseState('<!-- state:{broken} -->'), null); });
