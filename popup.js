// popup.js — попап иконки. Совмещает две функции:
//   • форму «Взять на контроль» (добавление письма новой строкой в таблицу);
//   • компактный блок панели проблемных писем (счётчик, «Обновить», «Войти»).
// Список полей/колонок берётся из defaults.js (PM_CONFIG), общий с настройками
// и с панелью (background.js).
const DEBUG = false; // включить для подробных логов
function dlog() { if (DEBUG) console['log'].apply(console, arguments); }

dlog('📋 popup.js загружен');

const STORAGE_KEYS = {
  spreadsheetId: 'spreadsheetId',
  sheetName: 'sheetName',
  fieldConfig: 'fieldConfig',
  warehouseDictionary: 'warehouseDictionary',
  typeDictionary: 'typeDictionary'
};

// Значения по умолчанию — из единого источника defaults.js.
const DEFAULT_FIELD_CONFIG = (typeof PM_DEFAULT_FIELD_CONFIG !== 'undefined')
  ? PM_DEFAULT_FIELD_CONFIG
  : [];

// Колонка каждого поля задаётся явно в настройках (можно оставлять пропуски
// под личные формулы/пометки в таблице) — просто читаем её, ничего не вычисляем.
function columnsFromFieldConfig(fieldConfig) {
  const colMap = {};
  const used = {};
  fieldConfig.forEach(f => {
    colMap[f.key] = f.enabled ? (f.column || 0) : 0;
    if (f.enabled && f.column) used[f.column] = true;
  });
  // Поля, появившиеся с обновлением расширения, добираем из defaults — но только
  // если их колонка свободна (иначе затёрли бы чужой столбец).
  DEFAULT_FIELD_CONFIG.forEach(f => {
    if (colMap[f.key] !== undefined) return;
    colMap[f.key] = used[f.column] ? 0 : (f.column || 0);
    if (colMap[f.key]) used[f.column] = true;
  });
  return colMap;
}


function getFieldConfig(callback) {
  chrome.storage.sync.get([STORAGE_KEYS.fieldConfig], function(result) {
    const saved = result[STORAGE_KEYS.fieldConfig];
    callback(Array.isArray(saved) && saved.length ? saved : DEFAULT_FIELD_CONFIG);
  });
}

// Собирает ВСЕ значения (склады/виды), совпавшие хоть с одной меткой письма —
// без повторов, в порядке появления. Раньше бралось только ПЕРВОЕ совпадение по
// первой метке, поэтому при 2+ метках пользователь не мог выбрать нужное значение.
function collectMatches(labels, dictionary, field) {
  const out = [];
  if (!Array.isArray(labels) || !labels.length || !Array.isArray(dictionary) || !dictionary.length) {
    return out;
  }
  const seen = new Set();
  for (const label of labels) {
    const lower = String(label).toLowerCase();
    for (const entry of dictionary) {
      if (entry.keyword && lower.includes(entry.keyword.toLowerCase())) {
        const val = entry[field];
        if (val && !seen.has(val)) {
          seen.add(val);
          out.push(val);
        }
      }
    }
  }
  return out;
}

function matchAllWarehouses(labels, dictionary) {
  return collectMatches(labels, dictionary, 'warehouse');
}

function matchAllTypes(labels, dictionary) {
  return collectMatches(labels, dictionary, 'type');
}

// Показывает чипсы-варианты под полем, когда меток совпало несколько. Мультивыбор:
// по умолчанию активны ВСЕ совпавшие варианты — их значения склеиваются в поле через
// ", " (письмо с двумя складскими метками получает оба склада сразу, а не только
// первый, как было раньше). Клик по чипсу переключает его; выбрать 0 нельзя — хотя бы
// один вариант остаётся, чтобы поле не опустело само по себе. При одном/нуле
// совпадений блок скрыт — как раньше, просто автоподстановка без чипсов.
function renderPickChips(containerId, inputId, candidates) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  if (!Array.isArray(candidates) || candidates.length < 2) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';

  const hint = document.createElement('span');
  hint.className = 'pick-hint';
  hint.textContent = 'по меткам (можно оставить несколько):';
  box.appendChild(hint);

  const active = new Set(candidates.map((_, i) => i)); // по умолчанию — все

  function apply() {
    const input = document.getElementById(inputId);
    if (!input) return;
    const vals = candidates.filter((_, i) => active.has(i));
    input.value = vals.join(', ');
  }

  candidates.forEach((val, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pick-chip active';
    chip.textContent = val;
    chip.addEventListener('click', function () {
      if (active.has(i)) {
        if (active.size > 1) active.delete(i); // не даём снять последний активный
      } else {
        active.add(i);
      }
      chip.classList.toggle('active', active.has(i));
      apply();
    });
    box.appendChild(chip);
  });

  apply();
}

// === ВЫБОР МЕТКИ ===
// В настройках можно задать несколько меток (по метке на плашку в почте). Форма
// ставит одну — по умолчанию первую из списка; если меток больше одной, показываем
// чипсы выбора, чтобы можно было отправить письмо под нужной меткой.
let LABEL_NAMES = [];
let selectedLabel = '';
// id открытого письма — уходит в колонку «ID письма», чтобы строку потом можно было
// однозначно связать с этой перепиской (а не искать по теме, которая повторяется).
let capturedMailId = '';
let capturedPreview = '';   // начало текста открытого письма — примета переписки

function renderLabelPicks(enabled) {
  const field = document.getElementById('labelPickField');
  const box = document.getElementById('labelPicks');
  if (!field || !box) return;
  box.innerHTML = '';
  if (!enabled || LABEL_NAMES.length < 2) {
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  LABEL_NAMES.forEach((name, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pick-chip' + (i === 0 ? ' active' : '');
    chip.textContent = name;
    chip.addEventListener('click', function () {
      selectedLabel = name;
      box.querySelectorAll('.pick-chip').forEach(c => c.classList.toggle('active', c === chip));
    });
    box.appendChild(chip);
  });
}

function loadLabelChoices() {
  chrome.storage.sync.get(['labelEnabled', 'labelName', 'labelNames'], function (r) {
    const raw = Array.isArray(r.labelNames) ? r.labelNames : (r.labelName ? [r.labelName] : []);
    const seen = new Set();
    LABEL_NAMES = [];
    raw.forEach(n => {
      const t = String(n || '').trim();
      const key = t.toLowerCase();
      if (t && !seen.has(key)) { seen.add(key); LABEL_NAMES.push(t); }
    });
    selectedLabel = LABEL_NAMES[0] || '';
    renderLabelPicks(!!r.labelEnabled);
  });
}

// Наполняет выпадающие подсказки поля «Вид» уникальными значениями из словаря видов.
function fillTypeOptions(dictionary) {
  const datalist = document.getElementById('typeOptions');
  if (!datalist) return;
  datalist.innerHTML = '';
  const seen = new Set();
  (Array.isArray(dictionary) ? dictionary : []).forEach(entry => {
    const val = entry && entry.type ? String(entry.type).trim() : '';
    if (val && !seen.has(val.toLowerCase())) {
      seen.add(val.toLowerCase());
      const opt = document.createElement('option');
      opt.value = val;
      datalist.appendChild(opt);
    }
  });
}



// Показывает блок подтверждения и ждёт выбора пользователя. «Всё равно добавить»
// повторно вызывает addRowToSheet с флагом пропуска проверки.
function showDuplicateConfirm(data, dupRows, byNumber) {
  const statusDiv = document.getElementById('status');
  const box = document.getElementById('dupConfirm');
  const msg = document.getElementById('dupMsg');
  const proceed = document.getElementById('dupProceed');
  const cancel = document.getElementById('dupCancel');
  if (!box || !msg || !proceed || !cancel) return;

  statusDiv.textContent = '';
  statusDiv.className = '';

  const rowsText = dupRows.length === 1
    ? `строка ${dupRows[0]}`
    : `строки ${dupRows.join(', ')}`;
  // Что именно совпало, говорит сама проверка: по номеру или только по теме.
  // Раньше это решалось по наличию номера у добавляемого письма — и при совпадении
  // по теме сообщение всё равно ссылалось на номер.
  const num = String(data.number || '').trim();
  msg.textContent = (byNumber && num)
    ? `⚠️ Номер «${num}» уже есть в таблице (${rowsText}) и не выполнен. Точно добавить ещё раз?`
    : `⚠️ Письмо с такой же темой уже есть в таблице (${rowsText}) и не выполнено. Если это другое письмо той же переписки — добавляйте. Точно добавить?`;

  box.style.display = 'block';

  proceed.onclick = function () {
    box.style.display = 'none';
    addRowToSheet(data, { skipDupCheck: true });
  };
  cancel.onclick = function () {
    box.style.display = 'none';
    statusDiv.textContent = 'Отменено — строка не добавлена.';
    statusDiv.className = '';
  };
}

// ============================================
// ДОБАВЛЕНИЕ СТРОКИ В ТАБЛИЦУ
// ============================================

// Добавление строки. ОДИН путь для обоих способов: и форма Alt+Y, и перетаскивание
// письма на язычок шлют pm-append в background.js. Раньше попап писал в таблицу сам —
// со своей проверкой дублей, своим порядком колонок и своим извлечением номера, и
// два способа расходились: одно и то же письмо попадало в таблицу дважды.
async function addRowToSheet(data, opts) {
  opts = opts || {};
  const statusDiv = document.getElementById('status');
  const dupBox = document.getElementById('dupConfirm');
  if (dupBox) dupBox.style.display = 'none';

  if (!data.topic || data.topic.trim() === '') {
    statusDiv.textContent = '⚠️ Введите тему письма';
    statusDiv.className = 'error';
    return;
  }

  statusDiv.textContent = '⏳ Добавление в таблицу...';
  statusDiv.className = '';

  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'pm-append', data: data, skipDupCheck: !!opts.skipDupCheck },
      function (r) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(r || { ok: false, error: 'нет ответа от расширения' });
      }
    );
  });

  if (res && res.ok && res.duplicate) {
    showDuplicateConfirm(data, res.dupRows || [], !!res.dupByNumber);
    return;
  }

  if (!res || !res.ok || !res.inserted) {
    const err = (res && res.error) || 'Неизвестная ошибка';
    statusDiv.textContent = '❌ Ошибка: ' + (err === 'no-spreadsheet' ? 'не указана таблица, настройте расширение' : err);
    statusDiv.className = 'error';
    return;
  }

  dlog('✅ Строка добавлена:', res.rowNumber);
  statusDiv.textContent = '✅ Добавлено в таблицу!';
  statusDiv.className = 'success';

  // Очищаем поля
  document.getElementById('number').value = '';
  document.getElementById('warehouse').value = '';
  document.getElementById('type').value = '';
  document.getElementById('supplier').value = '';
  document.getElementById('document').value = '';
  document.getElementById('comment').value = '';
  renderPickChips('warehousePicks', 'warehouse', []);
  renderPickChips('typePicks', 'type', []);

  // Панель проблемных писем читает ту же таблицу — просим её обновиться.
  chrome.runtime.sendMessage({ type: 'pm-refresh' }, function () { void chrome.runtime.lastError; });

  // Просим вкладку почты повесить метку на ветку этого письма и пометить прочитанным
  // (метка ставится, если авто-метка включена в настройках — это проверяет панель).
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'pm-apply-label',
        topic: data.topic,
        number: data.number || '',
        labelName: selectedLabel || ''
      }, function () { void chrome.runtime.lastError; });
    }
  });

  setTimeout(() => window.close(), 1600);
}

// ============================================
// ПАНЕЛЬ ПРОБЛЕМНЫХ ПИСЕМ (компактный блок)
// ============================================

function renderPanelStatus(res) {
  const el = document.getElementById('panelStatus');
  if (!el) return;
  if (!res || !res.ok) {
    el.textContent = '🛎 Панель: ' + ((res && res.error) || 'не удалось загрузить');
    el.className = 'panel-status error';
    return;
  }
  const n = res.rows.length;
  el.textContent = n ? `🛎 Проблемных писем: ${n}` : '🛎 Проблемных писем нет';
  el.className = 'panel-status' + (n ? ' has-items' : '');
}

function loadPanelStatus() {
  // Ответа может не быть вовсе (служебный процесс расширения выгрузился, порт закрылся
  // молча) — тогда попап навсегда оставался в «загрузка…». Ждём с потолком по времени.
  let answered = false;
  setTimeout(function () {
    if (!answered) renderPanelStatus({ ok: false, error: 'таблица не ответила — нажмите ⟳' });
  }, 20000);
  chrome.runtime.sendMessage({ type: 'pm-get' }, function(res) {
    answered = true;
    if (chrome.runtime.lastError) { renderPanelStatus(null); return; }
    renderPanelStatus(res);
  });
}

function setupPanelControls() {
  const refreshBtn = document.getElementById('panelRefresh');
  const loginBtn = document.getElementById('panelLogin');
  const statusEl = document.getElementById('panelStatus');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      if (statusEl) { statusEl.textContent = '🛎 Обновляю…'; statusEl.className = 'panel-status'; }
      chrome.runtime.sendMessage({ type: 'pm-refresh' }, function(res) {
        if (chrome.runtime.lastError) { renderPanelStatus(null); return; }
        renderPanelStatus(res);
      });
    });
  }

  if (loginBtn) {
    loginBtn.addEventListener('click', function() {
      if (statusEl) { statusEl.textContent = '🛎 Вход…'; statusEl.className = 'panel-status'; }
      chrome.runtime.sendMessage({ type: 'pm-login' }, function(res) {
        if (chrome.runtime.lastError || !res || !res.ok) {
          renderPanelStatus({ ok: false, error: (res && res.error) || 'не удалось войти' });
          return;
        }
        chrome.runtime.sendMessage({ type: 'pm-refresh' }, function(r) {
          if (chrome.runtime.lastError) { renderPanelStatus(null); return; }
          renderPanelStatus(r);
        });
      });
    });
  }
}

// ============================================
// ЗАГРУЗКА ДАННЫХ ИЗ ПИСЬМА
// ============================================

function openOptionsPage(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}

function applyFieldVisibility() {
  getFieldConfig(function(fieldConfig) {
    const colMap = columnsFromFieldConfig(fieldConfig);
    const setVisible = (id, visible) => {
      const el = document.getElementById(id);
      if (el) {
        if (visible) {
          el.classList.remove('field-hidden');
        } else {
          el.classList.add('field-hidden');
        }
      }
    };
    setVisible('numberField', colMap.number > 0);
    setVisible('warehouseField', colMap.warehouse > 0);
    setVisible('typeField', colMap.type > 0);
    setVisible('supplierField', colMap.supplier > 0);
    setVisible('documentField', colMap.document > 0);
    setVisible('commentField', colMap.comment > 0);
    setVisible('dateField', colMap.date > 0);
  });
}

function updateConfigStatus() {
  const configStatus = document.getElementById('configStatus');
  chrome.storage.sync.get([STORAGE_KEYS.spreadsheetId], function(result) {
    if (result[STORAGE_KEYS.spreadsheetId]) {
      configStatus.textContent = '✅ Таблица подключена';
      configStatus.className = 'config-status active';
    } else {
      configStatus.textContent = '⚠️ Таблица не настроена — откройте настройки';
      configStatus.className = 'config-status';
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  // Версия расширения — видно сразу в попапе, обновилась ли установленная копия.
  const verEl = document.getElementById('extVersion');
  if (verEl) {
    try { verEl.textContent = 'v' + chrome.runtime.getManifest().version; }
    catch (e) { /* не критично */ }
  }
  updateConfigStatus();
  applyFieldVisibility();
  loadPanelStatus();
  setupPanelControls();
  loadLabelChoices();

  document.getElementById('settingsLink').addEventListener('click', openOptionsPage);
  document.getElementById('settingsLink2').addEventListener('click', openOptionsPage);

  // «изменить» рядом с хоткеем → страница настройки горячих клавиш Chrome.
  // Расширение не может переназначить шорткат из кода, но может открыть эту страницу.
  const shortcutLink = document.getElementById('shortcutLink');
  if (shortcutLink) {
    shortcutLink.addEventListener('click', function(e) {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  // Загружаем данные из письма
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    const topicInput = document.getElementById('topic');
    if (tabs.length === 0) return;

    chrome.tabs.sendMessage(tabs[0].id, { action: "getEmailData" }, function(response) {
      if (chrome.runtime.lastError || !response) {
        topicInput.placeholder = 'Откройте письмо в Яндекс Почте';
        document.getElementById('date').value = new Date().toISOString().split('T')[0];
        return;
      }
      // Тема теперь редактируемая
      topicInput.value = response.subject || '';
      topicInput.placeholder = 'Введите тему письма';
      document.getElementById('date').value = response.date || new Date().toISOString().split('T')[0];

      // Автоподстановка номера ЗП/Перемещения (можно поправить вручную)
      const numberInput = document.getElementById('number');
      if (response.number && numberInput && !numberInput.value) {
        numberInput.value = response.number;
      }

      capturedMailId = response.mailId || '';
      capturedPreview = response.preview || '';
      dlog('🆔 id письма для таблицы:', capturedMailId);

      // Подставляем склад и вид по словарям меток. Одно совпадение — подставляем его
      // сразу. Несколько совпадений (2+ метки склада/вида на письме) — чипсы (мультивыбор,
      // по умолчанию ВСЕ активны) сами склеят значения через ", "; предзаполнение здесь
      // нужно только на случай ровно одного совпадения (тогда чипсы не рисуются).
      chrome.storage.sync.get([STORAGE_KEYS.warehouseDictionary, STORAGE_KEYS.typeDictionary], function(dictResult) {
        const warehouseDictionary = dictResult[STORAGE_KEYS.warehouseDictionary];
        const whCandidates = matchAllWarehouses(response.labels, warehouseDictionary);
        if (whCandidates.length === 1) {
          document.getElementById('warehouse').value = whCandidates[0];
        }
        renderPickChips('warehousePicks', 'warehouse', whCandidates);

        const typeDictionary = dictResult[STORAGE_KEYS.typeDictionary];
        fillTypeOptions(typeDictionary);
        const typeCandidates = matchAllTypes(response.labels, typeDictionary);
        if (typeCandidates.length === 1) {
          document.getElementById('type').value = typeCandidates[0];
        }
        renderPickChips('typePicks', 'type', typeCandidates);
      });
    });
  });

  // Кнопка "Взять на контроль"
  document.getElementById('saveBtn').addEventListener('click', function() {
    const data = {
      topic: document.getElementById('topic').value,
      number: document.getElementById('number').value,
      warehouse: document.getElementById('warehouse').value,
      type: document.getElementById('type').value,
      supplier: document.getElementById('supplier').value,
      document: document.getElementById('document').value,
      comment: document.getElementById('comment').value,
      date: document.getElementById('date').value,
      label: selectedLabel || '',
      mailId: capturedMailId || '',
      preview: capturedPreview || ''
    };
    addRowToSheet(data);
  });

  // Enter из любого поля сохраняет — кроме комментария, там Enter должен переносить строку
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('saveBtn').click();
    }
  });
});
