import test from 'node:test';
import assert from 'node:assert/strict';
import { main, TARGETS, NETWORKS } from './monitor.mjs';

test('incident lifecycle, deduplication and recovery without network or PROD writes', async () => {
  const savedFetch = globalThis.fetch, savedTimer = globalThis.setTimeout;
  const keys = ['GITHUB_TOKEN','GITHUB_REPOSITORY','GITHUB_EVENT_NAME','GITHUB_RUN_ID','TEST_ALERT','GITHUB_STEP_SUMMARY'];
  const savedEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const issues = [], comments = [], measurements = new Map(); let phase = 'down', id = 0;
  Object.assign(process.env, { GITHUB_TOKEN: 'unit-test-placeholder', GITHUB_REPOSITORY: 'KlochkovN/masterskaya-monitoring',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '12345', TEST_ALERT: 'false' });
  delete process.env.GITHUB_STEP_SUMMARY;
  globalThis.setTimeout = (fn, ms, ...args) => ms === 10000 ? (queueMicrotask(() => fn(...args)), 0) : savedTimer(fn, ms, ...args);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
    const reply = data => new Response(JSON.stringify(data), { status: 200 });
    if (u.hostname === 'api.globalping.io') {
      if (phase === 'provider-error') return new Response('{}', { status: 429 });
      if (method === 'POST') {
        const key = `measurement${++id}`; measurements.set(key, TARGETS.find(t => new URL(t.url).hostname === body.target));
        return reply({ id: key });
      }
      const target = measurements.get(u.pathname.split('/').at(-1)); assert.ok(target);
      const bad = phase === 'down' && target.id === 'site';
      return reply({ status: 'finished', results: NETWORKS.map(n => ({ probe: n, result: { status: 'finished',
        statusCode: bad ? 503 : target.api ? 401 : 200, tls: { authorized: true }, timings: { total: 100 },
        headers: { 'content-type': target.api ? 'application/json' : 'text/html' }, rawBody: target.api
          ? '{"ok":false,"error":"Unauthorized"}' : '<title>Мастерская</title><div id="root"></div><script src="/assets/main.js"></script>' } })) });
    }
    assert.equal(u.hostname, 'api.github.com');
    assert.ok(u.pathname.startsWith('/repos/KlochkovN/masterskaya-monitoring/issues'));
    if (method === 'GET') return reply(issues.filter(x => x.state === 'open'));
    if (u.pathname.endsWith('/comments')) { comments.push(body.body); return reply({ id: comments.length }); }
    if (method === 'POST') {
      const issue = { ...body, number: issues.length + 1, state: 'open', user: { login: 'github-actions[bot]' } };
      issues.push(issue); return reply(issue);
    }
    assert.equal(method, 'PATCH');
    const issue = issues.find(x => x.number === Number(u.pathname.split('/').at(-1))); assert.ok(issue);
    Object.assign(issue, body); return reply(issue);
  };
  try {
    await main();
    const incident = issues.find(x => x.body.includes('<!-- target:site -->'));
    assert.ok(incident); assert.match(incident.title, /Недоступно/); assert.match(incident.body, /@KlochkovN/);
    await main(); assert.equal(issues.length, 2); assert.equal(comments.length, 0);
    phase = 'up'; await main(); assert.equal(incident.state, 'closed'); assert.equal(comments.length, 1); assert.match(comments[0], /двумя измерениями/);
    phase = 'provider-error'; await main();
    assert.equal(issues.filter(x => x.state === 'open' && x.title.startsWith('❔')).length, 3);
    assert.equal(issues.filter(x => x.state === 'open' && x.title.startsWith('🔴')).length, 0);
    phase = 'up'; await main();
    assert.equal(issues.filter(x => x.state === 'open').length, 1);
    process.env.TEST_ALERT = 'true'; await main();
    const notification = issues.find(x => x.title.startsWith('🧪'));
    assert.equal(notification.state, 'closed'); assert.match(notification.body, /не сбой/);
    process.env.GITHUB_REPOSITORY = 'other/repo'; await assert.rejects(main());
  } finally {
    globalThis.fetch = savedFetch; globalThis.setTimeout = savedTimer;
    for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
