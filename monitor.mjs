import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This repository is public. Never add customer data or application credentials.
export const TARGETS = [
  { id: 'site', name: 'Сайт Мастерской', url: 'https://workshop.klochkov.tech/', api: false },
  { id: 'edge-api', name: 'API через входной сервер', url: 'https://edge.klochkov.tech/auth/me', api: true },
  { id: 'yc-api', name: 'API Яндекса напрямую', url: 'https://d5d3p8ndl77ofgvuc29p.uvah0e6r.apigw.yandexcloud.net/auth/me', api: true },
];
export const NETWORKS = [
  { asn: 9123, country: 'RU', city: 'Moscow', name: 'Москва — Timeweb' },
  { asn: 49505, country: 'RU', city: 'Saint Petersburg', name: 'Санкт-Петербург — Selectel' },
  { asn: 12389, country: 'RU', city: 'Kostroma', name: 'Кострома — Ростелеком' },
  { asn: 41754, country: 'RU', city: 'Penza', name: 'Пенза — Дом.ру (ЭР-Телеком)' },
  { asn: 3216, country: 'RU', city: 'Ufa', name: 'Уфа — Билайн (ВымпелКом)' },
  { asn: 8359, country: 'RU', city: 'Novosibirsk', name: 'Новосибирск — МТС' },
];
export const INTERVAL_MINUTES = 10;
export const NETWORK_CONFIG = NETWORKS.map(n => `${n.country}:${n.asn}:${n.city}`).join('|');
const REPO = 'KlochkovN/masterskaya-monitoring';
const PROVIDER = 'https://api.globalping.io/v1/measurements';
const MARKER = '<!-- masterskaya-monitor-v1 -->';
const STATE_TITLE = 'Мониторинг Мастерской — последний результат';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalize(target, records) {
  return NETWORKS.map(network => {
    const base = { network: network.name, asn: network.asn, country: network.country, city: network.city,
      status: 'unknown', code: null, ms: null, reason: 'Нет результата из выбранной сети' };
    const matches = Array.isArray(records) ? records.filter(x => x?.probe?.asn === network.asn
      && x?.probe?.country === network.country && x?.probe?.city === network.city) : [];
    if (matches.length !== 1) return base;
    const r = matches[0].result;
    if (r?.status === 'failed') return { ...base, status: r.failureSource === 'target' ? 'down' : 'unknown', reason: r.failureSource === 'target' ? 'Нет соединения с адресом' : 'Ошибка внешней проверки' };
    if (r?.status !== 'finished') return base;
    base.code = Number.isInteger(r.statusCode) && r.statusCode >= 100 && r.statusCode <= 599 ? r.statusCode : null;
    base.ms = Number.isFinite(r.timings?.total) && r.timings.total >= 0 ? Math.min(120000, Math.round(r.timings.total)) : null;
    if (r.tls?.authorized === false) return { ...base, status: 'down', reason: 'Ошибка HTTPS-сертификата' };
    if (r.tls?.authorized !== true || base.code === null) return { ...base, reason: 'Нет подтверждения HTTPS/HTTP' };
    if (base.code !== (target.api ? 401 : 200)) return { ...base, status: 'down', reason: `Неожиданный HTTP ${base.code}` };
    if (typeof r.rawBody !== 'string') return { ...base, reason: 'Нет содержимого для проверки' };
    const ct = Object.entries(r.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
    let valid = false;
    if (target.api) {
      try {
        const body = JSON.parse(r.rawBody);
        valid = typeof ct === 'string' && ct.includes('application/json') && body?.ok === false
          && typeof body.error === 'string' && body.error.length > 0
          && Object.keys(body).every(key => ['ok', 'error'].includes(key));
      } catch { /* Never log raw responses. */ }
    } else {
      valid = typeof ct === 'string' && ct.includes('text/html') && /<title>\s*Мастерская\s*<\/title>/i.test(r.rawBody)
        && /\bid=["']root["']/i.test(r.rawBody) && /\bsrc=["']\/assets\/[^"'\s]+\.js["']/i.test(r.rawBody);
    }
    return { ...base, status: valid ? 'up' : 'down', reason: valid ? '' : 'Неожиданный ответ приложения' };
  });
}

export function classify(checks) {
  if (checks.length !== NETWORKS.length) return 'unknown';
  if (checks.every(x => x.status === 'down')) return 'down';
  if (checks.some(x => x.status === 'down')) return 'degraded';
  return checks.length === NETWORKS.length && checks.every(x => x.status === 'up') ? 'up' : 'unknown';
}

// Confirmation happens inside the same run, so delayed GitHub schedules do not
// turn a single failed probe into an outage. An absent probe is never "up".
export function confirm(first, second) {
  return first.map((x, i) => {
    const y = second[i];
    if (y && x.asn === y.asn && x.country === y.country && x.city === y.city && x.status === y.status) return y;
    return { ...x, status: 'unknown', reason: 'Два измерения расходятся', code: null, ms: null };
  });
}

export async function boundedJson(url, init = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const parts = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function measure(target, fetcher = fetch, wait = sleep) {
  try {
    const url = new URL(target.url);
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.GLOBALPING_TOKEN) headers.Authorization = `Bearer ${process.env.GLOBALPING_TOKEN}`;
    const body = { type: 'http', target: url.hostname, timeout: 15,
      locations: NETWORKS.map(x => ({ asn: x.asn, country: x.country, city: x.city, limit: 1 })),
      measurementOptions: { protocol: 'HTTPS', request: { method: 'GET', path: url.pathname, headers: { 'Cache-Control': 'no-cache' } } } };
    const created = await boundedJson(PROVIDER, { method: 'POST', headers, body: JSON.stringify(body) }, fetcher);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(created.id ?? '')) throw new Error('Invalid measurement');
    for (let i = 0; i < 16; i++) {
      const result = await boundedJson(`${PROVIDER}/${created.id}`, { headers }, fetcher);
      if (result.status === 'finished') return normalize(target, result.results);
      if (result.status !== 'in-progress') throw new Error('Invalid measurement status');
      await wait(2000);
    }
  } catch { /* Provider errors are not evidence of an application outage. */ }
  return normalize(target, []);
}

const statusText = { up: 'Доступно', degraded: 'Сбой из части сетей', down: 'Недоступно', unknown: 'Не удалось подтвердить доступность' };
function table(targets) {
  return '| Адрес | Сеть проверки | Результат | HTTP | мс |\n|---|---|---|---:|---:|\n' + targets.flatMap(t =>
    t.checks.map(c => `| ${t.name} | ${c.network} | ${statusText[c.status]}${c.reason ? `: ${c.reason}` : ''} | ${c.code ?? '—'} | ${c.ms ?? '—'} |`)).join('\n');
}

async function github(path, method = 'GET', body) {
  if (!process.env.GITHUB_TOKEN || process.env.GITHUB_REPOSITORY !== REPO) throw new Error('Repository authentication unavailable');
  return boundedJson(`https://api.github.com/repos/${REPO}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function owned(issue) { return !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(MARKER); }
export function parseState(body) {
  try {
    const value = JSON.parse(body.match(/<!-- state:([\s\S]*?) -->/)?.[1] ?? '{}');
    return value.version === 1 && typeof value.checkedAt === 'string' ? value : null;
  } catch { return null; }
}

export async function main() {
  // Only repository-owned scheduled/manual runs are authorized, never PR code.
  if (!['schedule', 'workflow_dispatch', 'push'].includes(process.env.GITHUB_EVENT_NAME)) throw new Error('Unsupported event');
  const run = `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issues = await github('/issues?state=open&per_page=100');
  if (!Array.isArray(issues) || issues.length >= 100) throw new Error('Issue inventory needs review');
  const stateIssue = issues.find(x => owned(x) && x.title === STATE_TITLE);
  const previous = parseState(stateIssue?.body ?? '');
  const checkedAt = new Date().toISOString();
  const targets = await Promise.all(TARGETS.map(async target => {
    let checks = await measure(target);
    const active = issues.some(x => owned(x) && x.body.includes(`<!-- target:${target.id} -->`));
    if (classify(checks) !== 'up' || active) {
      await sleep(10000);
      checks = confirm(checks, await measure(target));
    }
    return { ...target, status: classify(checks), checks };
  }));
  for (const target of targets) {
    const tag = `<!-- target:${target.id} -->`;
    let existing = issues.find(x => owned(x) && x.body.includes(tag));
    const networkTag = `<!-- networks:${NETWORK_CONFIG} -->`;
    // A removed probe becoming irrelevant is not evidence that it recovered.
    // Retire the old incident explicitly and evaluate the new scope separately.
    if (existing && !existing.body.includes(networkTag)) {
      await github(`/issues/${existing.number}/comments`, 'POST', { body: `ℹ️ @KlochkovN Состав проверок изменён: теперь только шесть российских сетей. Прежнее предупреждение закрывается из-за изменения набора проверок, а не как подтверждение восстановления исключённой сети.\n\n${checkedAt}. [Запуск](${run}).` });
      await github(`/issues/${existing.number}`, 'PATCH', { state: 'closed', state_reason: 'not_planned' });
      existing = undefined;
    }
    const body = `${MARKER}\n${tag}\n${networkTag}\n\n@KlochkovN\n\n${target.name}: **${statusText[target.status]}**.\n\nПроверено: ${checkedAt}. [Запуск](${run}).\n\n${table([target])}\n\nЭто проверка публичного входа, не базы и не сохранения записей. «Не удалось подтвердить» не означает доказанный сбой приложения.`;
    if (target.status !== 'up' && !existing) {
      await github('/issues', 'POST', { title: `${target.status === 'unknown' ? '❔' : '🔴'} ${target.name}: ${statusText[target.status]}`, body });
    } else if (target.status === 'up' && existing) {
      await github(`/issues/${existing.number}/comments`, 'POST', { body: `🟢 @KlochkovN ${target.name}: доступность подтверждена двумя измерениями.\n\n${checkedAt}. [Запуск](${run}).` });
      await github(`/issues/${existing.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    } else if (existing && previous?.targets?.find(x => x.id === target.id)?.status !== target.status) {
      await github(`/issues/${existing.number}/comments`, 'POST', { body });
      await github(`/issues/${existing.number}`, 'PATCH', { title: `${target.status === 'unknown' ? '❔' : '🔴'} ${target.name}: ${statusText[target.status]}` });
    }
  }
  const snapshot = { version: 1, networkConfig: NETWORK_CONFIG, checkedAt, completedAt: new Date().toISOString(), staleAfterSeconds: 900, targets };
  const summary = `## Последний результат\n\nПроверено: **${snapshot.completedAt}** (UTC). [Запуск](${run}).\n\n**Если результату больше 15 минут — текущая доступность неизвестна.** Эта страница не обновляет свой статус сама при остановке GitHub.\n\n${table(targets)}\n\nПлан: каждые ${INTERVAL_MINUTES} минут; GitHub может задерживать или пропускать запуски. Проверки из шести российских городов и сетей: дата-центры и сети доступа. Узел в сети МТС или Билайна не гарантирует проверку именно LTE. Основной сайт и edge используют одну VM. API: ожидается HTTP 401 без входа, база и данные клиентов не читаются.\n\n[История инцидентов](https://github.com/${REPO}/issues?q=is%3Aissue) · [Все запуски](https://github.com/${REPO}/actions)\n`;
  const stateBody = `${MARKER}\n${summary}\n<!-- state:${JSON.stringify(snapshot)} -->`;
  await github(stateIssue ? `/issues/${stateIssue.number}` : '/issues', stateIssue ? 'PATCH' : 'POST', { title: STATE_TITLE, body: stateBody });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify({ checkedAt, results: targets.map(x => ({ id: x.id, status: x.status })) }));
  if (process.env.TEST_ALERT === 'true') {
    const test = await github('/issues', 'POST', { title: '🧪 Проверка оповещений — Мастерская', body: `${MARKER}\n\n@KlochkovN Это тест оповещений, не сбой Мастерской.\n\n[Тестовый запуск](${run}). Проверь уведомление GitHub и письмо на привязанной почте. Доставка письма зависит от настроек твоего аккаунта GitHub.` });
    await github(`/issues/${test.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Monitoring run failed. No fresh status is available. Check GitHub/Globalping availability and repository permissions.'); process.exitCode = 1; });
}
