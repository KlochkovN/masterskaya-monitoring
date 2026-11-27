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
export const INCIDENT_MARKER = '<!-- incident:availability-v2 -->';
export const NOTIFICATION_POLICY = 'confirmed-grouped-v2';
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

export function hasConfirmedFailure(targets) {
  return targets.some(target => ['down', 'degraded'].includes(target.status));
}

function incidentBody(targets, { checkedAt, run, startedAt, opening = false, recovered = false }) {
  const failed = targets.filter(target => ['down', 'degraded'].includes(target.status));
  const headline = recovered
    ? '🟢 Доступность всех трёх адресов восстановлена и подтверждена двумя измерениями.'
    : failed.length
      ? `🔴 Подтверждён сбой доступности: ${failed.map(target => `${target.name} — ${statusText[target.status].toLowerCase()}`).join('; ')}.`
      : '⏳ Ранее был подтверждён сбой. Новых подтверждённых отказов нет, но данных для подтверждения полного восстановления пока недостаточно.';
  return `${MARKER}\n${INCIDENT_MARKER}\n<!-- networks:${NETWORK_CONFIG} -->\n${opening ? '\n@KlochkovN\n' : ''}\n${headline}\n\nНачало эпизода: ${startedAt}.\nПроверено: ${checkedAt}. [Запуск](${run}).\n\n${table(targets)}\n\nОдин эпизод — одно уведомление о сбое и одно о подтверждённом восстановлении. Промежуточные результаты обновляются здесь без комментариев и повторных упоминаний. Отсутствие результата проверки не доказывает отказ приложения.\n\nЭто проверка публичных адресов, не базы, расписания или сохранения записей. Сбой из части сетей не означает недоступность для всех пользователей.`;
}

export async function main() {
  // Only repository-owned scheduled/manual runs are authorized, never PR code.
  if (!['schedule', 'workflow_dispatch', 'push'].includes(process.env.GITHUB_EVENT_NAME)) throw new Error('Unsupported event');
  const run = `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const issues = await github('/issues?state=open&per_page=100');
  if (!Array.isArray(issues) || issues.length >= 100) throw new Error('Issue inventory needs review');
  const stateIssue = issues.find(x => owned(x) && x.title === STATE_TITLE);
  const activeIncidents = issues.filter(x => owned(x)
    && (x.body.includes(INCIDENT_MARKER) || /<!-- target:(?:site|edge-api|yc-api) -->/.test(x.body)));
  const checkedAt = new Date().toISOString();
  const targets = await Promise.all(TARGETS.map(async target => {
    let checks = await measure(target);
    // An open grouped incident needs two successful measurements of every
    // target before recovery. Missing results must never close an incident.
    if (classify(checks) !== 'up' || activeIncidents.length) {
      await sleep(10000);
      checks = confirm(checks, await measure(target));
    }
    return { ...target, status: classify(checks), checks };
  }));
  const networkTag = `<!-- networks:${NETWORK_CONFIG} -->`;
  const currentIncidents = activeIncidents.filter(x => x.body.includes(INCIDENT_MARKER) && x.body.includes(networkTag));
  if (currentIncidents.length > 1) throw new Error('Duplicate grouped incidents need review');
  const existing = currentIncidents[0];
  // One-time migration only: retain old reports, don't call a changed policy
  // or removed network "recovered", and don't add another comment email.
  for (const legacy of activeIncidents.filter(x => x !== existing)) {
    await github(`/issues/${legacy.number}`, 'PATCH', {
      body: `${legacy.body}\n\nℹ️ ${checkedAt}: предупреждение архивировано из-за изменения правил оповещения или набора проверок. Это не подтверждение восстановления. [Текущая проверка](${run}).`,
      state: 'closed', state_reason: 'not_planned',
    });
  }
  const context = { checkedAt, run, startedAt: existing?.created_at ?? checkedAt };
  if (!existing && hasConfirmedFailure(targets)) {
    await github('/issues', 'POST', {
      title: '🔴 Мастерская — подтверждён сбой доступности',
      body: incidentBody(targets, { ...context, opening: true }),
    });
  } else if (existing) {
    const recovered = targets.every(target => target.status === 'up');
    await github(`/issues/${existing.number}`, 'PATCH', {
      body: incidentBody(targets, { ...context, recovered }),
      // Closing the issue is the recovery notification. A separate comment
      // would send a second email. No mentions are added to body updates.
      ...(recovered ? { title: '🟢 Мастерская — доступность восстановлена', state: 'closed', state_reason: 'completed' } : {}),
    });
  }
  const snapshot = { version: 1, notificationPolicy: NOTIFICATION_POLICY, networkConfig: NETWORK_CONFIG, checkedAt, completedAt: new Date().toISOString(), staleAfterSeconds: 900, targets };
  const summary = `## Последний результат\n\nПроверено: **${snapshot.completedAt}** (UTC). [Запуск](${run}).\n\n**Если результату больше 15 минут — текущая доступность неизвестна.** Эта страница не обновляет свой статус сама при остановке GitHub.\n\n${table(targets)}\n\nПлан: каждые ${INTERVAL_MINUTES} минут; GitHub может задерживать или пропускать запуски. Проверки из шести российских городов и сетей: дата-центры и сети доступа. Узел в сети МТС или Билайна не гарантирует проверку именно LTE. Основной сайт и edge используют одну VM. API: ожидается HTTP 401 без входа, база и данные клиентов не читаются.\n\n[История инцидентов](https://github.com/${REPO}/issues?q=is%3Aissue) · [Все запуски](https://github.com/${REPO}/actions)\n`;
  const stateBody = `${MARKER}\n${summary}\nОповещения: один общий инцидент только при подтверждённом отказе. Отсутствующие и расходящиеся результаты остаются в журнале, не создавая письма о сбое или восстановлении.\n\n<!-- state:${JSON.stringify(snapshot)} -->`;
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
