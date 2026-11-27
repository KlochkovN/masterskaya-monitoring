import test from 'node:test';
import assert from 'node:assert/strict';
import { main, TARGETS, NETWORKS, NETWORK_CONFIG, INCIDENT_MARKER, NOTIFICATION_POLICY, parseState } from './monitor.mjs';

const STATE_TITLE = 'Мониторинг Мастерской — последний результат';
const MARKER = '<!-- masterskaya-monitor-v1 -->';

// Entire lifecycle is simulated: no GitHub writes, messages, or PROD traffic.
async function scenario(check) {
  const savedFetch = globalThis.fetch, savedTimer = globalThis.setTimeout;
  const keys = ['GITHUB_TOKEN', 'GLOBALPING_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME',
    'GITHUB_RUN_ID', 'TEST_ALERT', 'GITHUB_STEP_SUMMARY'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const issues = [], writes = [], measurements = new Map();
  let sample = () => 'up', providerError = false, id = 0, attempts = {}, failAfterWrite;
  Object.assign(process.env, { GITHUB_TOKEN: 'unit-test-placeholder', GITHUB_REPOSITORY: 'KlochkovN/masterskaya-monitoring',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '12345', TEST_ALERT: 'false' });
  delete process.env.GLOBALPING_TOKEN;
  delete process.env.GITHUB_STEP_SUMMARY;
  globalThis.setTimeout = (fn, ms, ...args) => ms === 10000
    ? (queueMicrotask(() => fn(...args)), 0) : savedTimer(fn, ms, ...args);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
    const reply = data => new Response(JSON.stringify(data), { status: 200 });
    if (u.hostname === 'api.globalping.io') {
      if (providerError) return new Response('{}', { status: 429 });
      if (method === 'POST') {
        const target = TARGETS.find(target => new URL(target.url).hostname === body.target);
        assert.ok(target);
        const round = attempts[target.id] = (attempts[target.id] ?? 0) + 1;
        const key = `measurement${++id}`; measurements.set(key, { target, round });
        return reply({ id: key });
      }
      const { target, round } = measurements.get(u.pathname.split('/').at(-1));
      const results = NETWORKS.flatMap((network, index) => {
        const status = sample(target, index, round);
        if (status === 'unknown') return [];
        return [{ probe: network, result: { status: 'finished',
          statusCode: status === 'down' ? 503 : target.api ? 401 : 200,
          tls: { authorized: true }, timings: { total: 100 },
          headers: { 'content-type': target.api ? 'application/json' : 'text/html' }, rawBody: target.api
            ? '{"ok":false,"error":"Unauthorized"}'
            : '<title>Мастерская</title><div id="root"></div><script src="/assets/main.js"></script>' } }];
      });
      return reply({ status: 'finished', results });
    }
    assert.equal(u.hostname, 'api.github.com');
    assert.ok(u.pathname.startsWith('/repos/KlochkovN/masterskaya-monitoring/issues'));
    if (method === 'GET') return reply(issues.filter(issue => issue.state === 'open'));
    const write = { path: u.pathname, method, body: structuredClone(body) };
    writes.push(write);
    let result;
    if (u.pathname.endsWith('/comments')) result = { id: writes.length };
    else if (method === 'POST') {
      result = { ...body, number: Math.max(0, ...issues.map(issue => issue.number)) + 1, state: 'open',
        created_at: '2026-11-27T10:15:00.000Z', user: { login: 'github-actions[bot]' } };
      issues.push(result);
    } else {
      assert.equal(method, 'PATCH');
      result = issues.find(issue => issue.number === Number(u.pathname.split('/').at(-1)));
      assert.ok(result); Object.assign(result, body);
    }
    if (failAfterWrite?.(write)) { failAfterWrite = null; return new Response('{}', { status: 500 }); }
    return reply(result);
  };
  const h = {
    issues, writes,
    async run(fn = () => 'up', options = {}) {
      sample = fn; providerError = options.providerError ?? false; attempts = {};
      await main(); return { ...attempts };
    },
    incidents: () => issues.filter(issue => issue.body?.includes(INCIDENT_MARKER)),
    snapshot: () => parseState(issues.find(issue => issue.title === STATE_TITLE)?.body ?? ''),
    comments: () => writes.filter(write => write.path.endsWith('/comments')),
    failAfter: fn => { failAfterWrite = fn; },
    addIssue(body, extra = {}) {
      const issue = { number: Math.max(0, ...issues.map(issue => issue.number)) + 1,
        title: 'Предыдущее предупреждение', state: 'open', body,
        created_at: '2026-11-27T09:00:00.000Z', user: { login: 'github-actions[bot]' }, ...extra };
      issues.push(issue); return issue;
    },
  };
  try { await check(h); }
  finally {
    globalThis.fetch = savedFetch; globalThis.setTimeout = savedTimer;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('27 November: absent Penza results produce a journal entry, not three incident threads', () => scenario(async h => {
  await h.run((target, index) => index === 3 ? 'unknown' : 'up');
  assert.equal(h.issues.length, 1); assert.equal(h.incidents().length, 0);
  assert.ok(h.snapshot().targets.every(target => target.status === 'unknown'));
  assert.ok(h.snapshot().targets.every(target => target.checks[3].reason === 'Нет результата из выбранной сети'));
  assert.equal(h.snapshot().notificationPolicy, NOTIFICATION_POLICY);
  await h.run(); await h.run();
  assert.equal(h.issues.length, 1); assert.equal(h.comments().length, 0);
  assert.ok(h.writes.every(write => !write.body.state && !write.body.body?.includes('@KlochkovN')));
}));

test('provider failures stay unknown in the journal and never send an outage or recovery', () => scenario(async h => {
  await h.run(undefined, { providerError: true });
  await h.run(undefined, { providerError: true });
  assert.ok(h.snapshot().targets.every(target => target.status === 'unknown'));
  await h.run();
  assert.equal(h.issues.length, 1); assert.equal(h.incidents().length, 0); assert.equal(h.comments().length, 0);
}));

test('three failing addresses create one incident, one mention and no repeat notifications', () => scenario(async h => {
  await h.run(() => 'down');
  const [incident] = h.incidents(); assert.ok(incident);
  assert.equal(h.incidents().length, 1); assert.equal(h.issues.length, 2);
  assert.match(incident.title, /подтверждён сбой/); assert.match(incident.body, /@KlochkovN/);
  assert.ok(incident.body.includes(`<!-- networks:${NETWORK_CONFIG} -->`));
  for (const target of TARGETS) assert.ok(incident.body.includes(target.name));
  await h.run(() => 'down'); await h.run(() => 'down');
  assert.equal(h.incidents().length, 1); assert.equal(h.comments().length, 0);
  const incidentWrites = h.writes.filter(write => write.body.body?.includes(INCIDENT_MARKER));
  assert.equal(incidentWrites.filter(write => write.method === 'POST').length, 1);
  assert.ok(incidentWrites.filter(write => write.method === 'PATCH').every(write =>
    !write.body.state && !write.body.title && !write.body.body.includes('@KlochkovN')));
  assert.match(incident.body, /Начало эпизода: 2026-11-27T10:15:00.000Z/);
}));

test('recovery is one atomic issue update/close, not a comment followed by a second email', () => scenario(async h => {
  await h.run(() => 'down'); const [incident] = h.incidents(); const before = h.writes.length;
  const attempts = await h.run();
  assert.deepEqual(attempts, { site: 2, 'edge-api': 2, 'yc-api': 2 });
  const recovery = h.writes.slice(before).filter(write => write.path.endsWith('/' + incident.number));
  assert.equal(recovery.length, 1); assert.equal(recovery[0].method, 'PATCH');
  assert.equal(recovery[0].body.state, 'closed'); assert.equal(recovery[0].body.state_reason, 'completed');
  assert.match(recovery[0].body.title, /восстановлена/); assert.match(recovery[0].body.body, /двумя измерениями/);
  assert.doesNotMatch(recovery[0].body.body, /@KlochkovN/); assert.equal(h.comments().length, 0);
  await h.run();
  assert.equal(h.incidents().length, 1);
  assert.equal(h.writes.filter(write => write.body.state === 'closed').length, 1);
}));

test('missing data never closes an incident or claims recovery', () => scenario(async h => {
  await h.run(target => target.id === 'site' ? 'down' : 'up');
  const [incident] = h.incidents();
  await h.run((target, index) => index === 3 ? 'unknown' : 'up');
  assert.equal(incident.state, 'open'); assert.match(incident.body, /восстановления пока недостаточно/);
  await h.run(undefined, { providerError: true });
  assert.equal(incident.state, 'open'); assert.equal(h.comments().length, 0);
  assert.equal(h.writes.filter(write => write.body.state === 'closed').length, 0);
}));

test('new affected addresses within an open episode update the report without extra mail', () => scenario(async h => {
  await h.run(target => target.id === 'site' ? 'down' : 'up');
  await h.run(target => target.id === 'yc-api' ? 'down' : 'up');
  await h.run(() => 'down');
  assert.equal(h.incidents().length, 1); assert.equal(h.comments().length, 0);
  assert.ok(h.snapshot().targets.every(target => target.status === 'down'));
}));

test('a confirmed failure in one network is a partial-network incident, not a total outage', () => scenario(async h => {
  await h.run((target, index) => target.id === 'site' && index === 0 ? 'down' : 'up');
  assert.equal(h.incidents().length, 1);
  assert.equal(h.snapshot().targets[0].status, 'degraded');
  assert.match(h.incidents()[0].body, /Сайт Мастерской — сбой из части сетей/);
}));

test('a failed check followed by success is inconclusive, not an incident', () => scenario(async h => {
  await h.run((target, index, round) => round === 1 ? 'down' : 'up');
  assert.equal(h.incidents().length, 0);
  assert.ok(h.snapshot().targets.every(target => target.status === 'unknown'));
}));

test('a recovery that fails its second check keeps the same incident open', () => scenario(async h => {
  await h.run(() => 'down');
  await h.run((target, index, round) => round === 1 ? 'up' : 'down');
  assert.equal(h.incidents()[0].state, 'open'); assert.equal(h.comments().length, 0);
}));

test('another outage after confirmed recovery creates exactly one new episode', () => scenario(async h => {
  await h.run(() => 'down'); await h.run(); await h.run(() => 'down');
  assert.equal(h.incidents().length, 2);
  assert.equal(h.incidents().filter(issue => issue.state === 'open').length, 1);
  assert.equal(h.comments().length, 0);
}));

test('incident deduplication survives a missing or invalid previous snapshot', () => scenario(async h => {
  await h.run(() => 'down');
  h.issues.find(issue => issue.title === STATE_TITLE).body = `${MARKER}\n<!-- state:{invalid} -->`;
  await h.run(() => 'down');
  assert.equal(h.incidents().length, 1); assert.equal(h.comments().length, 0);
}));

test('lost create response does not duplicate an already created incident on the next run', () => scenario(async h => {
  h.failAfter(write => write.method === 'POST' && write.body.body?.includes(INCIDENT_MARKER));
  await assert.rejects(h.run(() => 'down'));
  await h.run(() => 'down');
  assert.equal(h.incidents().length, 1); assert.equal(h.comments().length, 0);
}));

test('lost close response does not repeat recovery on the next run', () => scenario(async h => {
  await h.run(() => 'down');
  h.failAfter(write => write.body.state === 'closed');
  await assert.rejects(h.run()); await h.run();
  assert.equal(h.writes.filter(write => write.body.state === 'closed').length, 1);
  assert.equal(h.comments().length, 0);
}));

test('legacy warnings are retired once without comments or false recovery statements', () => scenario(async h => {
  const old = h.addIssue(`${MARKER}\n<!-- target:site -->\n<!-- networks:${NETWORK_CONFIG} -->\nНет результата`);
  await h.run();
  assert.equal(old.state, 'closed'); assert.equal(old.state_reason, 'not_planned');
  assert.match(old.body, /Это не подтверждение восстановления/);
  assert.doesNotMatch(old.body, /доступность.*подтверждена двумя измерениями/);
  assert.equal(h.incidents().length, 0); assert.equal(h.comments().length, 0);
  await h.run(); assert.equal(h.writes.filter(write => write.body.state === 'closed').length, 1);
}));

test('changing the network scope cannot be reported as recovery of a removed network', () => scenario(async h => {
  const old = h.addIssue(`${MARKER}\n${INCIDENT_MARKER}\n<!-- networks:FI:24940:Helsinki -->`);
  await h.run(() => 'down');
  assert.equal(old.state_reason, 'not_planned'); assert.match(old.body, /Это не подтверждение восстановления/);
  assert.equal(h.incidents().filter(issue => issue.state === 'open').length, 1);
  assert.equal(h.comments().length, 0);
}));

test('unrelated human issues are never edited or closed', () => scenario(async h => {
  const human = h.addIssue(`${MARKER}\n${INCIDENT_MARKER}\n<!-- networks:${NETWORK_CONFIG} -->`, { user: { login: 'human' } });
  await h.run(); assert.equal(human.state, 'open');
  assert.ok(!h.writes.some(write => write.path.endsWith('/' + human.number)));
}));

test('duplicate grouped incidents fail safely instead of producing more notifications', () => scenario(async h => {
  h.addIssue(`${MARKER}\n${INCIDENT_MARKER}\n<!-- networks:${NETWORK_CONFIG} -->`);
  h.addIssue(`${MARKER}\n${INCIDENT_MARKER}\n<!-- networks:${NETWORK_CONFIG} -->`);
  await assert.rejects(h.run(), /Duplicate grouped incidents/); assert.equal(h.writes.length, 0);
}));

test('explicit test notifications remain clearly labelled; normal runs never send them', () => scenario(async h => {
  await h.run(); assert.ok(!h.issues.some(issue => issue.title.startsWith('🧪')));
  process.env.TEST_ALERT = 'true'; await h.run();
  const notification = h.issues.find(issue => issue.title.startsWith('🧪'));
  assert.equal(notification.state, 'closed'); assert.match(notification.body, /не сбой/);
  assert.equal(h.comments().length, 0);
}));

test('unsupported events and foreign repositories cannot write issues', () => scenario(async h => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'; await assert.rejects(h.run(), /Unsupported event/);
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; process.env.GITHUB_REPOSITORY = 'other/repo';
  await assert.rejects(h.run(), /authentication unavailable/); assert.equal(h.writes.length, 0);
}));
