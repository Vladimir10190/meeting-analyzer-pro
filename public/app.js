'use strict';
const pick = document.querySelector('#choose');
const fileInput = document.querySelector('#file');
const cloudForm = document.querySelector('#cloud-form');
const cloudInput = document.querySelector('#cloud-url');
const cloudAdd = document.querySelector('#cloud-add');
const limits = document.querySelector('#video-limits');
const hostingNote = document.querySelector('#hosting-note');
const sharedHistory = document.querySelector('#shared-history');
const ownerSignIn = document.querySelector('#owner-sign-in');
const items = document.querySelector('#meetings');
const empty = document.querySelector('#empty');
const detail = document.querySelector('#detail');
const status = document.querySelector('#status');
const alert = document.querySelector('#request-error');
const labels = {
  processing: 'Обрабатывается', download: 'Получение файла', transcription: 'Распознавание речи',
  analysis: 'AI-анализ', ready: 'Готово', error: 'Ошибка', duplicate: 'Запись уже обработана',
};
const sourceLabel = source => source === 'cloud' ? 'Из облака' : 'Загружено вручную';
const statusLabel = meeting => labels[meeting.stage ?? meeting.status];
const recordKey = meeting => `${meeting.id}:${meeting.status}:${meeting.stage ?? ''}`;
const formatter = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });
let history = [];
let active = null;
let rendered = null;
let busy = false;
let pending = false;
let advancing = false;
let configurationIssue = null;
let message = '';
let listVersion = '';
let detailRequest = 0;

function create(tag, text = '', css = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (css) element.className = css;
  return element;
}

function updateUpload() {
  const disabled = pending || busy || Boolean(configurationIssue);
  pick.disabled = fileInput.disabled = cloudInput.disabled = cloudAdd.disabled = disabled;
  const retry = detail.querySelector('.retry');
  if (retry) retry.disabled = disabled;
  const running = history.find(meeting => meeting.status === 'processing');
  status.textContent = pending ? 'Добавляем запись…' : busy ? statusLabel(running ?? { status: 'processing' }) : '';
  status.hidden = !status.textContent;
  alert.textContent = message || configurationIssue || '';
  alert.hidden = !alert.textContent;
}

async function api(route, options) {
  let response;
  try {
    response = await fetch('/api/meetings' + route, options);
  } catch {
    throw new Error('Нет связи с локальным сервером. Проверьте, что он запущен.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Сервер не смог выполнить запрос.');
  return body;
}

function meetingMeta(meeting) {
  const meta = create('span', '', 'meta');
  const time = create('time', formatter.format(new Date(meeting.created_at)));
  time.dateTime = meeting.created_at;
  meta.append(time, create('span', sourceLabel(meeting.source)), create('span', statusLabel(meeting), meeting.status));
  return meta;
}

function renderHistory() {
  const version = JSON.stringify([history, active]);
  if (version === listVersion) return;
  listVersion = version;
  empty.textContent = 'Здесь появятся загруженные встречи.';
  empty.hidden = history.length > 0;
  items.replaceChildren();
  for (const meeting of history) {
    const button = create('button', '', 'meeting');
    button.type = 'button';
    if (meeting.id === active) button.setAttribute('aria-current', 'true');
    button.append(create('strong', meeting.filename), meetingMeta(meeting));
    if (meeting.preview) button.append(create('span', meeting.preview, 'preview'));
    button.addEventListener('click', () => select(meeting.id));
    const item = create('li');
    item.append(button);
    items.append(item);
  }
}

function section(title, initiallyOpen) {
  const block = create('details', '', 'details-block');
  block.open = initiallyOpen;
  block.append(create('summary', title));
  detail.append(block);
  return block;
}

function appendList(parent, title, values, emptyText) {
  parent.append(create('h3', title));
  if (!values.length) {
    parent.append(create('p', emptyText, 'muted'));
    return;
  }
  const list = create('ul');
  for (const value of values) list.append(create('li', value));
  parent.append(list);
}

function renderDetail(meeting) {
  const key = recordKey(meeting);
  if (rendered === key) return;
  rendered = key;
  detail.hidden = false;
  detail.replaceChildren(create('h2', meeting.filename), meetingMeta(meeting));
  if (meeting.status === 'duplicate') {
    const open = create('button', 'Открыть готовый результат', 'open-result');
    open.type = 'button';
    open.onclick = () => select(meeting.duplicate_of);
    detail.append(open);
  }
  if (meeting.error) {
    const retry = create('button', meeting.source === 'cloud' ? 'Загрузить файл вручную' : 'Загрузить снова', 'retry');
    retry.type = 'button';
    retry.onclick = () => fileInput.click();
    detail.append(create('p', meeting.error, 'error'), retry);
  }
  if (meeting.summary) {
    const report = section('Конспект', true);
    const { summary, decisions, tasks, open_questions: openQuestions } = meeting.summary;
    report.append(create('h3', 'Краткое содержание'), create('p', summary));
    appendList(report, 'Решения', decisions, 'Решений нет.');
    appendList(report, 'Задачи', tasks.map(({ action, assignee, due }) =>
      [action, assignee ? 'Исполнитель — ' + assignee : 'Исполнитель не указан',
        due ? 'Срок — ' + due : 'Срок не указан'].join(' · ')), 'Задач нет.');
    appendList(report, 'Открытые вопросы', openQuestions, 'Открытых вопросов нет.');
  }
  if (meeting.transcript) section('Расшифровка', false).append(create('p', meeting.transcript, 'transcript'));
  updateUpload();
}

async function select(id) {
  active = id;
  const request = ++detailRequest;
  renderHistory();
  try {
    const result = await api('/' + id);
    if (request === detailRequest && active === id) renderDetail(result);
  } catch (error) {
    if (request !== detailRequest) return;
    message = error.message;
    updateUpload();
  }
}

async function refresh() {
  const snapshot = await api('');
  history = snapshot.meetings;
  busy = snapshot.busy;
  configurationIssue = snapshot.configuration_issue;
  sharedHistory.hidden = !snapshot.hosted;
  ownerSignIn.hidden = snapshot.signed_in === true;
  if (snapshot.max_file_mib) limits.textContent = `MP4 или WebM · до 5 минут · до ${snapshot.max_file_mib} МиБ`;
  hostingNote.hidden = !snapshot.hosted;
  if (!active && history.length) active = history[0].id;
  renderHistory();
  updateUpload();
  const selected = history.find(meeting => meeting.id === active);
  if (active && (selected ? rendered !== recordKey(selected) : rendered !== `${active}:duplicate:`)) {
    await select(active);
  }
  const running = history.find(meeting => meeting.status === 'processing');
  if (snapshot.hosted && running && !configurationIssue && !advancing) void advanceHosted(running.id);
}

async function advanceHosted(id) {
  advancing = true;
  try {
    await api(`/${id}/advance`, { method: 'POST' });
  } catch {
    // The next poll retries after the server releases the stage lease.
  } finally {
    advancing = false;
  }
}

async function submit(route, options) {
  if (pending || busy) return;
  pending = true;
  message = '';
  updateUpload();
  try {
    const result = await api(route, { method: 'POST', ...options });
    busy = true;
    await select(result.id);
    await refresh();
  } catch (error) {
    message = error.message;
  } finally {
    pending = false;
    updateUpload();
  }
}

pick.onclick = () => fileInput.click();
fileInput.onchange = () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const form = new FormData();
  form.set('file', file);
  void submit('', { body: form });
};

cloudForm.onsubmit = event => {
  event.preventDefault();
  void submit('/cloud', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: cloudInput.value.trim() }),
  });
};

async function poll() {
  try {
    if (!pending) await refresh();
  } catch (error) {
    configurationIssue = error.message;
    if (!history.length && !empty.hidden) empty.textContent = 'История сейчас недоступна.';
    updateUpload();
  } finally {
    setTimeout(poll, 2000);
  }
}
void poll();
