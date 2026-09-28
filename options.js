// options.js — единая страница настроек для обеих функций расширения.
// Список полей и значения по умолчанию берутся из defaults.js (PM_CONFIG),
// подключённого в options.html перед этим файлом.
const DEBUG = false; // включить для подробных логов
function dlog() { if (DEBUG) console['log'].apply(console, arguments); }

dlog('⚙️ Страница настроек открыта');

const STORAGE_KEYS = {
  spreadsheetId: 'spreadsheetId',
  sheetName: 'sheetName',
  fieldConfig: 'fieldConfig',
  warehouseDictionary: 'warehouseDictionary',
  typeDictionary: 'typeDictionary',
  labelEnabled: 'labelEnabled',
  labelNames: 'labelNames',
  labelColors: 'labelColors',
  labelTextColors: 'labelTextColors',
  labelOpacity: 'labelOpacity',
  quickDoneStyle: 'quickDoneStyle',
  syncAllStyle: 'syncAllStyle'
};

// Поля и колонки по умолчанию — из единого источника defaults.js.
const DEFAULT_FIELDS = PM_CONFIG.fields.map(f => ({
  key: f.key,
  label: f.label,
  locked: !!f.locked,
  column: f.column
}));
const FIELD_META = {};
DEFAULT_FIELDS.forEach(f => { FIELD_META[f.key] = f; });

// Текущий порядок и состояние полей (в памяти страницы настроек)
let fields = [];

// Словарь "часть метки → склад" (в памяти страницы настроек)
let warehouseDict = [];

// Словарь "часть метки → вид" (в памяти страницы настроек)
let typeDict = [];

// Список меток «как проблемные» — по метке на плашку в почте, порядок = порядок плашек.
let labelNames = [];

// Цвета меток: объект { name.toLowerCase(): '#rrggbb' }
let labelColors = {};
let labelTextColors = {};   // имя метки → '#ffffff' | '#000000'
let labelOpacity = {};      // имя метки → прозрачность фона плашки, 10..100 %

// Палитра дефолтных цветов для новых меток без явно выбранного цвета — по кругу,
// в порядке меток. Та же палитра используется в content-panel.js (модалка «Новые
// метки от коллег»), чтобы поведение было одинаковым везде в расширении.
const LABEL_COLOR_PALETTE = [
  '#ef7f5f', '#5fa8ef', '#7fd77f', '#d77fd7',
  '#efc75f', '#5fd7c7', '#d75f7f', '#a8ef5f'
];

const MAIL_URL_PATTERNS = [
  'https://mail.yandex.ru/*',
  'https://yandex.ru/mail/*',
  'https://mail.yandex.by/*',
  'https://yandex.by/mail/*',
  'https://mail.yandex.com/*',
  'https://yandex.com/mail/*',
  'https://mail.yandex.kz/*',
  'https://yandex.kz/mail/*'
];

function renderDetectedLabels(labels) {
  const container = document.getElementById('detectedLabels');
  container.innerHTML = '';

  // Наполняем общий список подсказок для всех полей меток
  const allLabelOptions = document.getElementById('allLabelOptions');
  if (allLabelOptions) {
    allLabelOptions.innerHTML = '';
  }
  
  // И список подсказок для поля «метка при добавлении».
  const labelOptions = document.getElementById('labelOptions');
  if (labelOptions) {
    labelOptions.innerHTML = '';
  }

  const seen = new Set();
  labels.forEach(label => {
    const val = String(label || '').trim();
    if (val && !seen.has(val.toLowerCase())) {
      seen.add(val.toLowerCase());
      
      // Добавляем в общий datalist
      if (allLabelOptions) {
        const optAll = document.createElement('option');
        optAll.value = val;
        allLabelOptions.appendChild(optAll);
      }
      
      // И в datalist для меток на письме
      if (labelOptions) {
        const opt = document.createElement('option');
        opt.value = val;
        labelOptions.appendChild(opt);
      }
    }
  });

  // Чипы — ТОЛЬКО подсказка, что за метки есть в почте. Ничего никуда не добавляют:
  // «Метки на письме» и «Словарь складов» — отдельные настройки, и клик по чипу раньше
  // молча дублировал метку в «Метки на письме». Названия подтягиваются в подсказки
  // (datalist) полей выше — там их и выбирают. Клик по чипу копирует имя в буфер.
  labels.forEach(label => {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.textContent = label;
    chip.title = 'Название метки из почты — впишите его в нужное поле (подсказки уже подставлены). Клик — скопировать.';
    chip.style.cursor = 'copy';
    chip.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(label);
        const prev = chip.textContent;
        chip.textContent = '✓ скопировано';
        setTimeout(() => { chip.textContent = prev; }, 900);
      } catch (e) { /* буфер недоступен — не критично */ }
    });
    container.appendChild(chip);
  });
}

function detectLabelsOnPage() {
  const status = document.getElementById('status');
  status.textContent = '🔍 Ищем метки на странице почты...';
  status.className = 'status info';

  chrome.tabs.query({ url: MAIL_URL_PATTERNS }, function(tabs) {
    if (!tabs || tabs.length === 0) {
      status.textContent = '⚠️ Не найдена открытая вкладка с Яндекс Почтой. Откройте почту в браузере и повторите.';
      status.className = 'status error';
      return;
    }

    // Если открыто НЕСКОЛЬКО вкладок почты (разные окна, забытая старая вкладка) —
    // раньше брали только «активную» (или первую попавшуюся), и если именно у НЕЁ
    // скрипт отвалился (например, вкладку не перезагрузили после обновления
    // расширения), всё падало с «не удалось получить метки», хотя другая вкладка
    // почты прекрасно отвечала. Теперь пробуем ПО ОЧЕРЕДИ все подходящие вкладки —
    // активную сначала, остальные потом — и берём первый успешный ответ.
    const ordered = tabs.slice().sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0); });

    function tryTab(i) {
      if (i >= ordered.length) {
        status.textContent = '⚠️ Не удалось получить метки ни с одной открытой вкладки почты. Обновите вкладку(и) почты (F5) и повторите.';
        status.className = 'status error';
        return;
      }
      chrome.tabs.sendMessage(ordered[i].id, { action: 'getAllLabels' }, function(response) {
        if (chrome.runtime.lastError || !response || !Array.isArray(response.labels)) {
          tryTab(i + 1);
          return;
        }

        if (response.labels.length === 0) {
          // Не найдено именно на ЭТОЙ вкладке — не сдаёмся, вдруг на следующей есть.
          tryTab(i + 1);
          return;
        }

        renderDetectedLabels(response.labels);
        status.textContent = `✅ Найдено меток: ${response.labels.length}. Их названия подставлены в подсказки полей ниже.`;
        status.className = 'status success';
      });
    }
    tryTab(0);
  });
}

function renderWarehouseDict() {
  const container = document.getElementById('warehouseDictList');
  container.innerHTML = '';

  warehouseDict.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'dict-row';

    const keywordInput = document.createElement('input');
    keywordInput.type = 'text';
    keywordInput.className = 'dict-keyword';
    keywordInput.placeholder = 'Часть метки, напр. Уручье';
    keywordInput.setAttribute('list', 'allLabelOptions');
    keywordInput.autocomplete = 'off';
    keywordInput.value = row.keyword || '';
    keywordInput.addEventListener('input', () => {
      warehouseDict[i].keyword = keywordInput.value;
    });

    const warehouseInput = document.createElement('input');
    warehouseInput.type = 'text';
    warehouseInput.className = 'dict-warehouse';
    warehouseInput.placeholder = 'Склад, напр. Уручье';
    warehouseInput.value = row.warehouse || '';
    warehouseInput.addEventListener('input', () => {
      warehouseDict[i].warehouse = warehouseInput.value;
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dict-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Удалить строку';
    removeBtn.addEventListener('click', () => {
      warehouseDict.splice(i, 1);
      renderWarehouseDict();
    });

    div.appendChild(keywordInput);
    div.appendChild(warehouseInput);
    div.appendChild(removeBtn);
    container.appendChild(div);
  });
}

// Зеркало renderWarehouseDict — для поля "Вид". Раньше у этого словаря не было
// интерфейса вообще (только чтение из storage в content-panel.js/popup.js), поэтому
// случайно попавшая туда запись была невидима и неудаляема из настроек — баг с
// подстановкой чужого значения в «Вид» из-за этого не могли ни увидеть, ни поправить.
function renderTypeDict() {
  const container = document.getElementById('typeDictList');
  if (!container) return;
  container.innerHTML = '';

  typeDict.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'dict-row';

    const keywordInput = document.createElement('input');
    keywordInput.type = 'text';
    keywordInput.className = 'dict-keyword';
    keywordInput.placeholder = 'Часть метки, напр. Брак';
    keywordInput.setAttribute('list', 'allLabelOptions');
    keywordInput.autocomplete = 'off';
    keywordInput.value = row.keyword || '';
    keywordInput.addEventListener('input', () => {
      typeDict[i].keyword = keywordInput.value;
    });

    const typeInput = document.createElement('input');
    typeInput.type = 'text';
    typeInput.className = 'dict-warehouse';
    typeInput.placeholder = 'Вид, напр. Брак';
    typeInput.value = row.type || '';
    typeInput.addEventListener('input', () => {
      typeDict[i].type = typeInput.value;
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dict-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Удалить строку';
    removeBtn.addEventListener('click', () => {
      typeDict.splice(i, 1);
      renderTypeDict();
    });

    div.appendChild(keywordInput);
    div.appendChild(typeInput);
    div.appendChild(removeBtn);
    container.appendChild(div);
  });
}

function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function letterToColumn(letter) {
  const clean = String(letter).toUpperCase().replace(/[^A-Z]/g, '');
  let col = 0;
  for (let i = 0; i < clean.length; i++) {
    col = col * 26 + (clean.charCodeAt(i) - 64);
  }
  return col;
}

// Колонки, которые заняты больше чем одним включённым полем одновременно —
// сохранять такую конфигурацию нельзя, одно поле молча перетрёт другое.
function findDuplicateColumns() {
  const seen = new Map();
  fields.forEach(f => {
    if (!f.enabled || !f.column) return;
    seen.set(f.column, (seen.get(f.column) || 0) + 1);
  });
  const duplicates = new Set();
  seen.forEach((count, col) => { if (count > 1) duplicates.add(col); });
  return duplicates;
}

function moveField(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= fields.length || toIndex >= fields.length) return;
  const [item] = fields.splice(fromIndex, 1);
  fields.splice(toIndex, 0, item);
  renderFieldList();
}

function renderFieldList() {
  const list = document.getElementById('fieldList');
  list.innerHTML = '';

  const duplicates = findDuplicateColumns();
  const warning = document.getElementById('columnWarning');
  if (warning) {
    if (duplicates.size > 0) {
      warning.textContent = `⚠️ Колонка ${[...duplicates].map(columnLetter).join(', ')} назначена нескольким полям одновременно — исправьте перед сохранением, иначе одно поле перетрёт другое.`;
      warning.style.display = 'block';
    } else {
      warning.style.display = 'none';
    }
  }

  fields.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'field-item' + (f.enabled ? '' : ' field-disabled');
    li.draggable = true;
    li.dataset.index = i;

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';
    li.appendChild(handle);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = f.enabled;
    checkbox.disabled = !!f.locked;
    checkbox.title = f.locked ? 'Это поле нельзя отключить' : '';
    checkbox.addEventListener('change', () => {
      fields[i].enabled = checkbox.checked;
      renderFieldList();
    });
    li.appendChild(checkbox);

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = f.label;
    li.appendChild(label);

    const badge = document.createElement('input');
    badge.type = 'text';
    badge.className = 'col-badge';
    badge.maxLength = 3;
    badge.value = f.column ? columnLetter(f.column) : '';
    badge.disabled = !f.enabled;
    badge.title = 'Буква колонки в таблице — можно оставлять пропуски под свои формулы';
    if (duplicates.has(f.column)) badge.classList.add('col-conflict');
    badge.addEventListener('mousedown', (e) => e.stopPropagation());
    badge.addEventListener('change', () => {
      fields[i].column = letterToColumn(badge.value) || fields[i].column;
      renderFieldList();
    });
    li.appendChild(badge);

    const orderButtons = document.createElement('div');
    orderButtons.className = 'order-buttons';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '▲';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => moveField(i, i - 1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '▼';
    downBtn.disabled = i === fields.length - 1;
    downBtn.addEventListener('click', () => moveField(i, i + 1));

    orderButtons.appendChild(upBtn);
    orderButtons.appendChild(downBtn);
    li.appendChild(orderButtons);

    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      moveField(fromIndex, i);
    });

    list.appendChild(li);
  });
}

// ============================================
// СПИСОК МЕТОК
// ============================================
function moveLabel(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 ||
      fromIndex >= labelNames.length || toIndex >= labelNames.length) return;
  const [item] = labelNames.splice(fromIndex, 1);
  labelNames.splice(toIndex, 0, item);
  renderLabelList();
}

function renderLabelList() {
  const list = document.getElementById('labelList');
  if (!list) return;
  list.innerHTML = '';

  if (!labelNames.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Меток пока нет — нажмите «➕ Добавить метку».';
    list.appendChild(empty);
    return;
  }

  labelNames.forEach((name, i) => {
    const li = document.createElement('li');
    li.className = 'field-item';
    li.draggable = true;

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';
    li.appendChild(handle);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'label-name';
    input.setAttribute('list', 'allLabelOptions');
    input.autocomplete = 'off';
    input.placeholder = 'Например: Проблемные';
    input.value = name;
    // Поле внутри перетаскиваемой строки: без этого клик по нему начинает drag.
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('focus', () => { li.draggable = false; });
    input.addEventListener('blur', () => { li.draggable = true; });
    input.addEventListener('input', () => {
      const oldName = labelNames[i];
      labelNames[i] = input.value;
      // Переносим цвет на новое имя, если оно изменилось
      if (oldName && oldName !== input.value) {
        const oldKey = oldName.toLowerCase();
        const newKey = input.value.toLowerCase();
        [labelColors, labelTextColors, labelOpacity].forEach(function (map) {
          if (map[oldKey] !== undefined) {
            map[newKey] = map[oldKey];
            delete map[oldKey];
          }
        });
      }
    });
    li.appendChild(input);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'label-color';
    colorInput.title = 'Цвет метки';
    const colorKey = name.toLowerCase();
    // Разные дефолтные цвета по порядку меток — раньше ВСЕ новые метки без явного
    // выбора получали один и тот же оранжевый (#ef7f5f), и на панели все плашки
    // выглядели одинаково, пока не открыть сюда и не перекрасить каждую вручную.
    // Сразу пишем дефолт и в labelColors (не только в DOM) — иначе он не попал бы
    // в сохранение (saveSettings берёт цвета из labelColors, а не из инпутов) и
    // при следующем сохранении настроек метка снова осталась бы «ничьей», без
    // цвета, — а панель в таком случае рисует свой собственный дефолт (не из этой
    // палитры), и цвета в опциях и на плашке разошлись бы.
    if (!labelColors[colorKey]) labelColors[colorKey] = LABEL_COLOR_PALETTE[i % LABEL_COLOR_PALETTE.length];
    colorInput.value = labelColors[colorKey];
    colorInput.addEventListener('input', () => {
      labelColors[name.toLowerCase()] = colorInput.value;
    });
    li.appendChild(colorInput);

    // Цвет текста на плашке — любой, не только белый или чёрный: у пастельных
    // плашек чёрные буквы выглядят тяжело, а угадать за пользователя нельзя.
    const textColorInput = document.createElement('input');
    textColorInput.type = 'color';
    textColorInput.className = 'label-text-color';
    textColorInput.title = 'Цвет текста на плашке';
    if (!labelTextColors[colorKey]) labelTextColors[colorKey] = '#ffffff';
    textColorInput.value = labelTextColors[colorKey];
    textColorInput.addEventListener('mousedown', (e) => e.stopPropagation());
    textColorInput.addEventListener('input', () => {
      labelTextColors[name.toLowerCase()] = textColorInput.value;
    });
    li.appendChild(textColorInput);

    // Прозрачность фона плашки в процентах: 100 — сплошной цвет, меньше — сквозь
    // плашку просвечивает почта. Ниже 10 % не опускаем, иначе плашку не найти.
    const opacityInput = document.createElement('input');
    opacityInput.type = 'number';
    opacityInput.className = 'label-opacity';
    opacityInput.min = '10';
    opacityInput.max = '100';
    opacityInput.step = '5';
    opacityInput.title = 'Непрозрачность плашки, %';
    if (labelOpacity[colorKey] === undefined) labelOpacity[colorKey] = 100;
    opacityInput.value = String(labelOpacity[colorKey]);
    opacityInput.addEventListener('mousedown', (e) => e.stopPropagation());
    opacityInput.addEventListener('focus', () => { li.draggable = false; });
    opacityInput.addEventListener('blur', () => { li.draggable = true; });
    opacityInput.addEventListener('input', () => {
      const v = Math.max(10, Math.min(100, Number(opacityInput.value) || 100));
      labelOpacity[name.toLowerCase()] = v;
    });
    li.appendChild(opacityInput);

    const orderButtons = document.createElement('div');
    orderButtons.className = 'order-buttons';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '▲';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => moveLabel(i, i - 1));
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '▼';
    downBtn.disabled = i === labelNames.length - 1;
    downBtn.addEventListener('click', () => moveLabel(i, i + 1));
    orderButtons.appendChild(upBtn);
    orderButtons.appendChild(downBtn);
    li.appendChild(orderButtons);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'label-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Удалить метку';
    removeBtn.addEventListener('click', () => {
      const removedName = labelNames[i];
      labelNames.splice(i, 1);
      const removedKey = removedName.toLowerCase();
      delete labelColors[removedKey];
      delete labelTextColors[removedKey];
      delete labelOpacity[removedKey];
      renderLabelList();
    });
    li.appendChild(removeBtn);

    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      moveLabel(parseInt(e.dataTransfer.getData('text/plain'), 10), i);
    });

    list.appendChild(li);
  });
}

// Настройки старого формата хранили одно имя метки — поднимаем его в список.
function labelNamesFromStorage(result) {
  const raw = Array.isArray(result[STORAGE_KEYS.labelNames])
    ? result[STORAGE_KEYS.labelNames]
    : [];
  const out = [];
  const seen = new Set();
  raw.forEach(n => {
    const t = String(n || '').trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
  });
  return out;
}

function loadSettings() {
  chrome.storage.sync.get([
    STORAGE_KEYS.spreadsheetId,
    STORAGE_KEYS.sheetName,
    STORAGE_KEYS.fieldConfig,
    STORAGE_KEYS.warehouseDictionary,
    STORAGE_KEYS.typeDictionary,
    STORAGE_KEYS.labelEnabled,
    STORAGE_KEYS.labelNames,
    STORAGE_KEYS.labelColors,
    STORAGE_KEYS.labelTextColors,
    STORAGE_KEYS.labelOpacity,
    STORAGE_KEYS.quickDoneStyle,
    STORAGE_KEYS.syncAllStyle
  ], function(result) {
    const status = document.getElementById('status');

    document.getElementById('spreadsheetId').value = result[STORAGE_KEYS.spreadsheetId] || PM_CONFIG.spreadsheetId;
    document.getElementById('sheetName').value = result[STORAGE_KEYS.sheetName] || PM_CONFIG.sheetName;

    const labelEnabledEl = document.getElementById('labelEnabled');
    if (labelEnabledEl) labelEnabledEl.checked = !!result[STORAGE_KEYS.labelEnabled];
    labelNames = labelNamesFromStorage(result);
    labelColors = result[STORAGE_KEYS.labelColors] || {};
  labelTextColors = result[STORAGE_KEYS.labelTextColors] || {};
  labelOpacity = result[STORAGE_KEYS.labelOpacity] || {};

  // Вид кнопки «Выполнено». Цвет по умолчанию — тот же зелёный, что был зашит в CSS.
  const qd = result[STORAGE_KEYS.quickDoneStyle] || {};
  const qdColorEl = document.getElementById('quickDoneColor');
  const qdTextEl = document.getElementById('quickDoneTextColor');
  const qdOpacityEl = document.getElementById('quickDoneOpacity');
  if (qdColorEl) qdColorEl.value = qd.color || '#34c759';
  if (qdTextEl) qdTextEl.value = qd.textColor || '#ffffff';
  if (qdOpacityEl) qdOpacityEl.value = String(qd.opacity === undefined ? 100 : qd.opacity);

  // Вид полосы «Обновить метки» в её обычном (некрасном) состоянии.
  const sa = result[STORAGE_KEYS.syncAllStyle] || {};
  const saColorEl = document.getElementById('syncAllColor');
  const saTextEl = document.getElementById('syncAllTextColor');
  const saOpacityEl = document.getElementById('syncAllOpacity');
  if (saColorEl) saColorEl.value = sa.color || '#6b7280';
  if (saTextEl) saTextEl.value = sa.textColor || '#ffffff';
  if (saOpacityEl) saOpacityEl.value = String(sa.opacity === undefined ? 100 : sa.opacity);
    renderLabelList();

    const saved = result[STORAGE_KEYS.fieldConfig];
    if (Array.isArray(saved) && saved.length) {
      fields = saved
        .filter(s => FIELD_META[s.key])
        .map(s => ({
          ...FIELD_META[s.key],
          enabled: FIELD_META[s.key].locked ? true : !!s.enabled,
          column: s.column || null
        }));
      // Поля, которых ещё не было в сохранённой конфигурации, добавляем в конец
      DEFAULT_FIELDS.forEach(def => {
        if (!fields.find(f => f.key === def.key)) {
          fields.push({ ...def, enabled: true });
        }
      });
      // Старый формат настроек хранил только порядок/включение, без номера колонки —
      // при первой загрузке после обновления восстанавливаем те же колонки, что были
      // раньше (подряд по порядку включённых полей), чтобы ничего не сломалось молча.
      if (fields.some(f => !f.column)) {
        let col = 0;
        fields.forEach(f => {
          if (!f.column) f.column = f.enabled ? ++col : null;
          else col = Math.max(col, f.column);
        });
      }
    } else {
      fields = DEFAULT_FIELDS.map(f => ({ ...f, enabled: true }));
    }

    renderFieldList();

    const savedDict = result[STORAGE_KEYS.warehouseDictionary];
    warehouseDict = Array.isArray(savedDict) ? savedDict.map(r => ({ ...r })) : [];
    renderWarehouseDict();

    // Раньше у этого словаря вообще не было интерфейса — если он копился в storage
    // старой версией расширения (или тестовыми записями), сейчас он наконец виден
    // и его можно поправить/удалить прямо здесь.
    const savedTypeDict = result[STORAGE_KEYS.typeDictionary];
    typeDict = Array.isArray(savedTypeDict) ? savedTypeDict.map(r => ({ ...r })) : [];
    renderTypeDict();

    status.textContent = '✅ Настройки загружены';
    status.className = 'status success';
  });
}

function saveSettings() {
  const status = document.getElementById('status');

  const spreadsheetId = document.getElementById('spreadsheetId').value.trim();
  const sheetName = document.getElementById('sheetName').value.trim() || PM_CONFIG.sheetName;

  if (!spreadsheetId) {
    status.textContent = '⚠️ Введите ID таблицы';
    status.className = 'status error';
    return;
  }

  const duplicates = findDuplicateColumns();
  if (duplicates.size > 0) {
    status.textContent = `⚠️ Колонка ${[...duplicates].map(columnLetter).join(', ')} назначена нескольким полям одновременно — исправьте перед сохранением.`;
    status.className = 'status error';
    return;
  }

  // Убираем лишние символы из ID (если вставили полный URL)
  let cleanId = spreadsheetId;
  if (cleanId.includes('/d/')) {
    const match = cleanId.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) cleanId = match[1];
  }

  const fieldConfig = fields.map(f => ({ key: f.key, enabled: f.enabled, column: f.column }));

  // Сохраняем только полностью заполненные строки словаря
  const cleanDict = warehouseDict
    .filter(r => r.keyword && r.keyword.trim() && r.warehouse && r.warehouse.trim())
    .map(r => ({ keyword: r.keyword.trim(), warehouse: r.warehouse.trim() }));

  const cleanTypeDict = typeDict
    .filter(r => r.keyword && r.keyword.trim() && r.type && r.type.trim())
    .map(r => ({ keyword: r.keyword.trim(), type: r.type.trim() }));

  const labelEnabledEl = document.getElementById('labelEnabled');
  const labelEnabled = labelEnabledEl ? !!labelEnabledEl.checked : false;
  // Пустые строки и повторы в список меток не сохраняем.
  const cleanLabels = [];
  const seenLabels = new Set();
  labelNames.forEach(n => {
    const t = String(n || '').trim();
    const key = t.toLowerCase();
    if (t && !seenLabels.has(key)) { seenLabels.add(key); cleanLabels.push(t); }
  });

  // Вид кнопки «Выполнено» — из полей формы.
  function quickDoneStyleFromForm() {
    const c = document.getElementById('quickDoneColor');
    const t = document.getElementById('quickDoneTextColor');
    const o = document.getElementById('quickDoneOpacity');
    return {
      color: (c && c.value) || '#34c759',
      textColor: (t && t.value) || '#ffffff',
      opacity: Math.max(10, Math.min(100, Number(o && o.value) || 100))
    };
  }

  // Вид полосы «Обновить метки» — из полей формы.
  function syncAllStyleFromForm() {
    const c = document.getElementById('syncAllColor');
    const t = document.getElementById('syncAllTextColor');
    const o = document.getElementById('syncAllOpacity');
    return {
      color: (c && c.value) || '#6b7280',
      textColor: (t && t.value) || '#ffffff',
      opacity: Math.max(10, Math.min(100, Number(o && o.value) || 100))
    };
  }

  // Очищаем оформление для удалённых меток, оставляем только для существующих
  const cleanLabelColors = {};
  const cleanLabelTextColors = {};
  const cleanLabelOpacity = {};
  cleanLabels.forEach(name => {
    const k = name.toLowerCase();
    if (labelColors[k]) cleanLabelColors[k] = labelColors[k];
    if (labelTextColors[k]) cleanLabelTextColors[k] = labelTextColors[k];
    if (labelOpacity[k] !== undefined) cleanLabelOpacity[k] = labelOpacity[k];
  });

  chrome.storage.sync.set({
    [STORAGE_KEYS.spreadsheetId]: cleanId,
    [STORAGE_KEYS.sheetName]: sheetName,
    [STORAGE_KEYS.fieldConfig]: fieldConfig,
    [STORAGE_KEYS.warehouseDictionary]: cleanDict,
    [STORAGE_KEYS.typeDictionary]: cleanTypeDict,
    [STORAGE_KEYS.labelEnabled]: labelEnabled,
    [STORAGE_KEYS.labelNames]: cleanLabels,
    [STORAGE_KEYS.labelColors]: cleanLabelColors,
    [STORAGE_KEYS.labelTextColors]: cleanLabelTextColors,
    [STORAGE_KEYS.labelOpacity]: cleanLabelOpacity,
    [STORAGE_KEYS.quickDoneStyle]: quickDoneStyleFromForm(),
    [STORAGE_KEYS.syncAllStyle]: syncAllStyleFromForm()
  }, function() {
    labelNames = cleanLabels.slice();
    labelColors = cleanLabelColors;
    labelTextColors = cleanLabelTextColors;
    labelOpacity = cleanLabelOpacity;
    renderLabelList();
    status.textContent = '✅ Настройки сохранены!';
    status.className = 'status success';
    // Панель проблемных писем читает те же настройки — просим её обновиться.
    chrome.runtime.sendMessage({ type: 'pm-refresh' }, function () { void chrome.runtime.lastError; });
  });
}

// ============================================
// ПРОВЕРКА ПОДКЛЮЧЕНИЯ
// ============================================

async function testConnection() {
  const status = document.getElementById('status');

  const spreadsheetId = document.getElementById('spreadsheetId').value.trim();

  if (!spreadsheetId) {
    status.textContent = '⚠️ Введите ID таблицы';
    status.className = 'status error';
    return;
  }

  let cleanId = spreadsheetId;
  if (cleanId.includes('/d/')) {
    const match = cleanId.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) cleanId = match[1];
  }

  status.textContent = '⏳ Проверка...';
  status.className = 'status info';

  try {
    // Получаем токен
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, function(token) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(token);
      });
    });

    // Проверяем доступ к таблице
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=properties.title,sheets.properties.title`;
    const response = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token
      }
    });

    if (response.ok) {
      const data = await response.json();
      const sheets = data.sheets.map(s => s.properties.title).join(', ');
      status.textContent = `✅ Подключено! Таблица "${data.properties.title}". Листы: ${sheets}`;
      status.className = 'status success';
    } else {
      const error = await response.json();
      status.textContent = `❌ Ошибка: ${error.error?.message || 'Нет доступа'}`;
      status.className = 'status error';
    }
  } catch (error) {
    status.textContent = `❌ Ошибка: ${error.message}`;
    status.className = 'status error';
  }
}

function resetSettings() {
  if (confirm('Сбросить все настройки?')) {
    chrome.storage.sync.remove([
      STORAGE_KEYS.spreadsheetId,
      STORAGE_KEYS.sheetName,
      STORAGE_KEYS.fieldConfig,
      STORAGE_KEYS.warehouseDictionary,
      STORAGE_KEYS.typeDictionary
    ], function() {
      document.getElementById('spreadsheetId').value = PM_CONFIG.spreadsheetId;
      document.getElementById('sheetName').value = PM_CONFIG.sheetName;
      fields = DEFAULT_FIELDS.map(f => ({ ...f, enabled: true }));
      renderFieldList();
      warehouseDict = [];
      renderWarehouseDict();
      typeDict = [];
      renderTypeDict();

      const status = document.getElementById('status');
      status.textContent = '↩️ Настройки сброшены';
      status.className = 'status info';
    });
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Версия расширения — видно сразу, обновилась ли установленная копия после правок.
  const verEl = document.getElementById('extVersion');
  if (verEl) {
    try { verEl.textContent = 'Версия расширения: ' + chrome.runtime.getManifest().version; }
    catch (e) { /* не критично */ }
  }
  loadSettings();
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('testBtn').addEventListener('click', testConnection);
  document.getElementById('resetBtn').addEventListener('click', resetSettings);
  document.getElementById('addWarehouseRow').addEventListener('click', () => {
    warehouseDict.push({ keyword: '', warehouse: '' });
    renderWarehouseDict();
  });
  document.getElementById('addTypeRow').addEventListener('click', () => {
    typeDict.push({ keyword: '', type: '' });
    renderTypeDict();
  });
  document.getElementById('addLabelRow').addEventListener('click', () => {
    labelNames.push('');
    renderLabelList();
    // Сразу ставим курсор в новое поле — метку добавляют, чтобы её вписать.
    const inputs = document.querySelectorAll('#labelList .label-name');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  });
  document.getElementById('detectLabelsBtn').addEventListener('click', detectLabelsOnPage);
});

dlog('✅ options.js загружен');
