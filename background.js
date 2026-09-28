// Service worker объединённого расширения.
// Обслуживает панель «Проблемные письма»: читает/пишет ту же таблицу «Контроль
// почты» через Google Sheets API (OAuth), раз в 15 минут обновляет список,
// рассылает данные во вкладки Яндекс Почты, ставит бейдж на иконке.
// Колонки берутся из ЕДИНОГО fieldConfig (см. defaults.js) — тех же настроек,
// что использует форма захвата письма.

importScripts('defaults.js');

const DEFAULT_SPREADSHEET_ID = PM_CONFIG.spreadsheetId;
const DEFAULT_SHEET_NAME = PM_CONFIG.sheetName;

const POLL_ALARM = 'pm-poll';
const POLL_MINUTES = 5;
const STALE_MS = 5 * 60 * 1000;
const SERIAL_EPOCH_OFFSET_DAYS = 25569;

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

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Номер колонки (1 = A) → индекс в массиве строки (0-based). 0/пусто → -1 (нет).
function colNumberToIndex(n) {
    return (typeof n === 'number' && n > 0) ? n - 1 : -1;
}

// Номер колонки (1 = A) → буква (для диапазонов A1).
function colNumberToLetter(n) {
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function serialToUTCDate(serial) {
    if (typeof serial !== 'number' || isNaN(serial)) return null;
    return new Date(Math.round((serial - SERIAL_EPOCH_OFFSET_DAYS) * 86400000));
}

// Разбирает дату-строку из ячейки. Если таблица (из-за локали листа) не распознала
// введённое как настоящую дату, значение вернётся текстом «дд.мм.гггг» — а new Date()
// такой формат не понимает и раньше давал «дата неизвестна». Поддерживаем ISO
// (гггг-мм-дд) и русский порядок день-месяц-год с разделителями . / -.
function parseSheetDateString(value) {
    const str = String(value).trim();
    if (!str) return null;

    // ISO / год-впереди: гггг-мм-дд (также / и .).
    const ymd = str.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (ymd) {
        const dt = new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]));
        if (!isNaN(dt)) return dt;
    }

    // Русский порядок: дд.мм.гггг (также / и -, год из 2 цифр → 20xx).
    const dmy = str.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
    if (dmy) {
        let d = +dmy[1], mo = +dmy[2], y = +dmy[3];
        if (y < 100) y += 2000;
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
            const dt = new Date(Date.UTC(y, mo - 1, d));
            if (!isNaN(dt)) return dt;
        }
    }

    // Фолбэк на нативный парсер (например, ISO со временем).
    const native = new Date(str);
    return isNaN(native) ? null : native;
}

// Собирает {ключ поля → номер колонки} из сохранённого fieldConfig, а при его
// отсутствии — из значений по умолчанию. Выключенные поля дают 0.
function buildColMap(fieldConfig) {
    const meta = {};
    PM_CONFIG.fields.forEach(function (f) { meta[f.key] = f; });

    let source;
    if (Array.isArray(fieldConfig) && fieldConfig.length) {
        source = fieldConfig.filter(function (s) { return meta[s.key]; }).map(function (s) {
            return {
                key: s.key,
                enabled: meta[s.key].locked ? true : !!s.enabled,
                column: s.column || 0
            };
        });
    } else {
        source = PM_CONFIG.fields.map(function (f) {
            return { key: f.key, enabled: f.enabled, column: f.column };
        });
    }

    // Поля, которых в сохранённой конфигурации ещё нет (появились с обновлением
    // расширения), добираем из defaults — но только если их колонка не занята другим
    // полем, иначе молча затёрли бы чужой столбец.
    const known = {};
    source.forEach(function (f) { known[f.key] = true; });
    const used = {};
    source.forEach(function (f) { if (f.enabled && f.column) used[f.column] = true; });
    PM_CONFIG.fields.forEach(function (f) {
        if (known[f.key]) return;
        source.push({ key: f.key, enabled: !used[f.column], column: f.column });
        if (!used[f.column]) used[f.column] = true;
    });

    const map = {};
    source.forEach(function (f) { map[f.key] = f.enabled ? (f.column || 0) : 0; });
    return map;
}

// Короткий снимок всего листа для кнопки 🏷️ (наполняется в listAllRows ниже).
let listAllCache = null;        // { rows, at }

// Настройки читались из storage.sync на КАЖДОЕ сообщение — по два чтения на одну
// мутацию (сама операция и следующий за ней refresh). Держим разобранный результат
// и сбрасываем его, когда настройки правда поменяли (страница настроек пишет в sync).
let settingsCache = null;

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    if (changes.spreadsheetId || changes.sheetName || changes.fieldConfig) {
        settingsCache = null;
        sheetInfoCacheClear();   // сменили таблицу или лист — sheetId больше не наш
        listAllCache = null;
    }
});

function getSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    return new Promise(function (resolve) {
        chrome.storage.sync.get(
            { spreadsheetId: DEFAULT_SPREADSHEET_ID, sheetName: DEFAULT_SHEET_NAME, fieldConfig: null },
            function (d) {
                settingsCache = {
                    spreadsheetId: d.spreadsheetId || DEFAULT_SPREADSHEET_ID,
                    sheetName: d.sheetName || DEFAULT_SHEET_NAME,
                    colMap: buildColMap(d.fieldConfig)
                };
                resolve(settingsCache);
            }
        );
    });
}

function getCache() {
    return new Promise(function (resolve) {
        chrome.storage.local.get({ cache: { rows: [], updatedAt: 0, error: null } }, function (d) {
            resolve(d.cache);
        });
    });
}

function setCache(cache) {
    return new Promise(function (resolve) {
        chrome.storage.local.set({ cache: cache }, resolve);
    });
}

// === АВТОРИЗАЦИЯ ===

function getAuthTokenRaw(interactive) {
    return new Promise(function (resolve, reject) {
        chrome.identity.getAuthToken({ interactive: interactive }, function (token) {
            if (chrome.runtime.lastError || !token) {
                reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Не удалось получить токен Google'));
            } else {
                resolve(token);
            }
        });
    });
}

// Сначала пытаемся получить токен без всплывающего окна.
// Окно авторизации показываем только если это явно разрешено (действие пользователя).
async function getToken(interactive) {
    try {
        return await getAuthTokenRaw(false);
    } catch (e) {
        if (!interactive) throw e;
        return await getAuthTokenRaw(true);
    }
}

function dropToken(token) {
    return new Promise(function (resolve) {
        chrome.identity.removeCachedAuthToken({ token: token }, resolve);
    });
}

function sheetRange(sheetName, a1) {
    return "'" + sheetName.replace(/'/g, "\\'") + "'!" + a1;
}

async function apiFetch(token, url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
    const res = await fetch(url, Object.assign({}, options, { headers: headers }));
    if (res.status === 401) {
        await dropToken(token);
        throw new Error('auth-expired');
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error('Sheets API ' + res.status + ': ' + text);
    }
    return res.json();
}

// Выполняет запрос с токеном; если токен протух (401) — один раз повторяет с новым.
async function withToken(interactive, fn) {
    let token = await getToken(interactive);
    try {
        return await fn(token);
    } catch (e) {
        if (e.message === 'auth-expired') {
            token = await getToken(interactive);
            return await fn(token);
        }
        throw e;
    }
}

// Последняя колонка, которая реально используется. Раньше читали всегда до Z —
// 26 колонок вместо примерно десяти. Запрос всё равно один, но тянуть лишние
// столбцы (и весь их текст) каждые пять минут незачем.
function lastUsedColumnLetter(colMap) {
    let max = 0;
    Object.keys(colMap || {}).forEach(function (k) {
        const c = colMap[k];
        if (typeof c === 'number' && c > max) max = c;
    });
    return colNumberToLetter(max > 0 ? max : 26);
}

// Что именно вернуло последнее чтение таблицы. «Строк нет» бывает по трём совсем
// разным причинам — не тот диапазон, все строки выполнены, пустая колонка темы, — а
// снаружи они выглядят одинаково: нули на плашках. Держим цифры и отдаём их панели.
let lastReadDiag = null;

async function fetchValues(spreadsheetId, sheetName, interactive, colMap) {
    const lastCol = lastUsedColumnLetter(colMap);
    const range = encodeURIComponent(sheetRange(sheetName, 'A1:' + lastCol));
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + range +
        '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
    const data = await withToken(interactive, function (token) {
        return apiFetch(token, url);
    });
    return data.values || [];
}

async function writeValues(token, spreadsheetId, sheetName, updates, valueInputOption) {
    const body = {
        valueInputOption: valueInputOption || 'USER_ENTERED',
        data: updates.map(function (u) {
            return { range: sheetRange(sheetName, u.a1), values: [[u.value]] };
        })
    };
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values:batchUpdate';
    await apiFetch(token, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// === РАБОТА С ТАБЛИЦЕЙ ===

async function fetchAndProcessRows(interactive) {
    const { spreadsheetId, sheetName, colMap } = await getSettings();

    const topicIdx = colNumberToIndex(colMap.topic);
    const numberIdx = colNumberToIndex(colMap.number);
    const warehouseIdx = colNumberToIndex(colMap.warehouse);
    const typeIdx = colNumberToIndex(colMap.type);
    const dateIdx = colNumberToIndex(colMap.date);
    const commentIdx = colNumberToIndex(colMap.comment);
    const doneIdx = colNumberToIndex(colMap.done);
    const labelIdx = colNumberToIndex(colMap.label);
    const mailIdIdx = colNumberToIndex(colMap.mailId);
    const previewIdx = colNumberToIndex(colMap.preview);

    if (topicIdx === -1 || dateIdx === -1) {
        throw new Error('Не заданы колонки для темы или даты — проверьте Настройки');
    }

    const values = await fetchValues(spreadsheetId, sheetName, interactive, colMap);

    const diag = {
        лист: sheetName,
        диапазон: 'A1:' + lastUsedColumnLetter(colMap),
        'строк получено': values.length,
        'колонка темы': colMap.topic || '(не задана)',
        'колонка выполнено': colMap.done || '(не задана)',
        'пропущено выполненных': 0,
        'пропущено без темы': 0,
        'строк показано': 0
    };
    lastReadDiag = diag;

    if (values.length === 0) return [];

    const rows = values.slice(1);
    const result = [];

    rows.forEach(function (row, i) {
        if (doneIdx !== -1 && row[doneIdx] === true) { diag['пропущено выполненных']++; return; }

        const topic = row[topicIdx];
        if (!topic) { diag['пропущено без темы']++; return; }

        const number = numberIdx !== -1 ? (row[numberIdx] || '') : '';
        const warehouse = warehouseIdx !== -1 ? (row[warehouseIdx] || '') : '';
        const type = typeIdx !== -1 ? (row[typeIdx] || '') : '';
        const comment = commentIdx !== -1 ? (row[commentIdx] || '') : '';
        const label = labelIdx !== -1 ? (row[labelIdx] || '') : '';
        const mailId = mailIdIdx !== -1 ? (row[mailIdIdx] || '') : '';
        const preview = previewIdx !== -1 ? (row[previewIdx] || '') : '';
        let dateAdded = null;
        if (dateIdx !== -1) {
            const dateVal = row[dateIdx];
            if (typeof dateVal === 'number') {
                dateAdded = serialToUTCDate(dateVal);
            } else if (typeof dateVal === 'string') {
                dateAdded = parseSheetDateString(dateVal);
            }
        }

        result.push({
            sheetRow: i + 2,
            rowNumber: i + 2,
            topic: String(topic),
            number: String(number),
            warehouse: String(warehouse),
            type: String(type),
            comment: String(comment),
            label: String(label),
            mailId: String(mailId),
            preview: String(preview),
            dateAdded: dateAdded ? dateAdded.toISOString() : null,
            done: false
        });
    });

    diag['строк показано'] = result.length;
    // Печатаем, только когда показывать нечего: в норме это шум, а вот «строк 0» без
    // объяснения — ровно тот случай, когда приходится гадать.
    if (!result.length) {
        try { console.warn('[Проблемные письма] Таблица прочитана, но показывать нечего:\n' +
                           JSON.stringify(diag, null, 2)); } catch (e) { /* ignore */ }
    }
    return result;
}

// Таблица общая на нескольких пользователей — пока идёт наша операция, кто-то
// другой мог вставить/удалить строку выше и сдвинуть номера. Мы адресуем ячейки
// по номеру строки, полученному заранее, поэтому такой сдвиг тихо пишет не в ту
// строку. Перед записью сверяем тему в ожидаемой строке; если не совпало —
// ищем строку с этой темой заново по всему листу (при однозначном совпадении).
async function resolveCurrentRowNumber(token, spreadsheetId, sheetName, colMap, rowNumber, topic) {
    const topicIdx = colNumberToIndex(colMap.topic);
    if (!topic || topicIdx === -1) return rowNumber; // нечего сверять — доверяем как раньше
    const enc = encodeURIComponent(sheetName);
    const topicLetter = colNumberToLetter(colMap.topic);
    const expected = String(topic).trim();

    const cur = await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
        '/values/' + enc + '!' + topicLetter + rowNumber);
    const curTopic = String((cur.values && cur.values[0] && cur.values[0][0]) || '').trim();
    if (curTopic === expected) return rowNumber;

    // Строка сдвинулась (кто-то ещё редактирует таблицу) — ищем по всему столбцу темы.
    const whole = await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
        '/values/' + enc + '!' + topicLetter + ':' + topicLetter);
    const rows = whole.values || [];
    const candidates = [];
    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0] || '').trim() === expected) candidates.push(i + 1);
    }
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) {
        throw new Error('Строка сдвинулась (её кто-то удалил или переместил, пока вы работали) — обновите список и повторите');
    }
    throw new Error('Строка сдвинулась, а тема встречается в нескольких строках — не удалось однозначно найти нужную. Обновите список и повторите');
}

// value=true — «Выполнено» (галка), value=false — снять галку (отмена по кнопке
// «Отмена» в тосте, без повторного подтверждения от пользователя). topic — тема
// строки на момент, когда пользователь нажал кнопку: используется, чтобы перед
// записью проверить, что строка не сдвинулась (см. resolveCurrentRowNumber).
async function setDoneValue(rowNumber, value, topic) {
    const { spreadsheetId, sheetName, colMap } = await getSettings();
    const doneIdx = colNumberToIndex(colMap.done);
    if (doneIdx === -1) throw new Error('Не задана колонка "Выполнено" — проверьте Настройки');

    await withToken(true, async function (token) {
        const row = await resolveCurrentRowNumber(token, spreadsheetId, sheetName, colMap, rowNumber, topic);
        // Ставим именно ГАЛКУ: делаем ячейку чекбоксом (data validation BOOLEAN) и
        // отмечаем её одним repeatCell. Так чекбокс не «затирается» текстом TRUE/FALSE,
        // а если его в колонке ещё нет — он создаётся. Нужен sheetId.
        let sheetId = null;
        try { sheetId = await getSheetIdCached(token, spreadsheetId, sheetName); } catch (e) { sheetId = null; }
        if (sheetId != null) {
            await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        repeatCell: {
                            range: {
                                sheetId: sheetId,
                                startRowIndex: row - 1, endRowIndex: row,
                                startColumnIndex: doneIdx, endColumnIndex: doneIdx + 1
                            },
                            cell: {
                                userEnteredValue: { boolValue: !!value },
                                dataValidation: { condition: { type: 'BOOLEAN' }, strict: true }
                            },
                            fields: 'userEnteredValue,dataValidation'
                        }
                    }]
                })
            });
            return;
        }
        // sheetId не получили — запасной путь: пишем булево значение как раньше.
        const letter = colNumberToLetter(colMap.done);
        return writeValues(token, spreadsheetId, sheetName, [{ a1: letter + row, value: !!value }]);
    });
    scheduleRefresh();
    return true;
}

async function markDone(rowNumber, topic) {
    return setDoneValue(rowNumber, true, topic);
}

async function unmarkDone(rowNumber, topic) {
    return setDoneValue(rowNumber, false, topic);
}

async function editComment(rowNumber, topic, comment) {
    const { spreadsheetId, sheetName, colMap } = await getSettings();
    if (colNumberToIndex(colMap.comment) === -1) throw new Error('Не задана колонка "Комментарий" — проверьте Настройки');

    const letter = colNumberToLetter(colMap.comment);
    await withToken(true, async function (token) {
        const row = await resolveCurrentRowNumber(token, spreadsheetId, sheetName, colMap, rowNumber, topic);
        return writeValues(token, spreadsheetId, sheetName, [{ a1: letter + row, value: comment }], 'RAW');
    });
    scheduleRefresh();
    return true;
}

// Пакетная запись дозаполненных полей. items: [{ rowNumber, fields: { date?, number?,
// warehouse?, type? } }]. Дату пишем USER_ENTERED (Sheets распознаёт ISO как дату),
// остальное — RAW (сохраняем ведущие нули и не переинтерпретируем текст). Пустые/
// выключенные колонки пропускаем. Возвращает { written, byField } — сколько ячеек
// записано всего и по каждому полю (для честного отчёта в панели: поля с выключенной
// колонкой в счётчик не попадают).
async function backfillWrite(items) {
    const empty = { written: 0, byField: {} };
    if (!Array.isArray(items) || !items.length) return empty;
    const { spreadsheetId, sheetName, colMap } = await getSettings();

    const dateUpdates = [];
    const textUpdates = [];
    const byField = {};
    items.forEach(function (it) {
        const row = it && it.rowNumber;
        if (!row || !it.fields) return;
        Object.keys(it.fields).forEach(function (field) {
            const colNum = colMap[field];
            const value = it.fields[field];
            if (!colNum || value === undefined || value === null || value === '') return;
            const upd = { a1: colNumberToLetter(colNum) + row, value: value };
            if (field === 'date') dateUpdates.push(upd);
            else textUpdates.push(upd);
            byField[field] = (byField[field] || 0) + 1;
        });
    });

    if (!dateUpdates.length && !textUpdates.length) return empty;

    await withToken(true, async function (token) {
        if (textUpdates.length) await writeValues(token, spreadsheetId, sheetName, textUpdates, 'RAW');
        if (dateUpdates.length) await writeValues(token, spreadsheetId, sheetName, dateUpdates, 'USER_ENTERED');
    });
    scheduleRefresh();
    return { written: dateUpdates.length + textUpdates.length, byField: byField };
}

// === ОСНОВНЫЕ ФУНКЦИИ ===

// Подпись списка строк. Нужна, чтобы не рассылать во вкладки то, что уже там есть:
// каждая рассылка заставляет панель перерисовать список целиком и переискать письма
// по всей таблице в почте. Раньше это происходило на КАЖДОМ тике будильника, то есть
// раз в пять минут независимо от того, менялось ли в таблице хоть что-нибудь.
let lastRowsSig = null;

function rowsSignature(rows) {
    try {
        return JSON.stringify((rows || []).map(function (r) {
            return [r.sheetRow, r.topic, r.number, r.warehouse, r.type, r.comment,
                    r.label, r.mailId, r.preview, r.dateAdded];
        }));
    } catch (e) {
        return null;   // не смогли посчитать — разошлём, как раньше
    }
}

async function refresh(interactive) {
    try {
        const rows = await fetchAndProcessRows(interactive);
        const cache = { rows: rows, updatedAt: Date.now(), error: null };
        await setCache(cache);
        updateBadge(rows);
        const sig = rowsSignature(rows);
        if (sig === null || sig !== lastRowsSig) {
            lastRowsSig = sig;
            broadcast(rows);
        }
        return cache;
    } catch (err) {
        // Неудачное чтение НЕ стирает то, что уже было прочитано. Раньше сюда клался
        // пустой список, бейдж обнулялся, и одна осечка сети или токена превращалась
        // в «письма пропали»: панель показывала нули, а восстановиться могла только
        // после следующего удачного чтения — которого при постоянной ошибке нет.
        // Держим последние хорошие строки и время их получения, а ошибку записываем
        // рядом. Свежесть при этом не завышается: updatedAt остаётся временем
        // последнего УСПЕШНОГО чтения, поэтому обновиться попробуем снова.
        const prev = await getCache();
        const cache = {
            rows: (prev && prev.rows) || [],
            updatedAt: (prev && prev.updatedAt) || 0,
            error: err.message,
            errorAt: Date.now()
        };
        await setCache(cache);
        updateBadge(cache.rows);
        lastRowsSig = null;   // после ошибки следующий удачный список разошлём точно
        throw err;
    }
}

// Перечитывание таблицы после записи. Раньше каждая мутация ЖДАЛА полного чтения
// листа: одна отметка «Выполнено» — это сверка строки, сама запись и ещё чтение всей
// таблицы, три последовательных запроса. Десять отметок подряд — тридцать. Панель к
// этому моменту уже сама убрала карточку и поправила счётчики, так что перечитывание
// нужно только чтобы догнать чужие правки — его можно и не ждать, и склеить.
//
// Склейка держится на будильнике, а НЕ на setTimeout. Этот файл сам пишет ниже, что
// в Manifest V3 service worker выгружается после простоя и таймеры здесь ненадёжны, —
// но scheduleRefresh жил именно на setTimeout. Запись в таблицу как раз и есть тот
// момент, когда воркер отработал своё и может быть выгружен: таймер умирал вместе с
// ним, и перечитывание просто не случалось. Панель оставалась на своих данных до
// следующего опроса, то есть до пяти минут, — и чужие правки «не приезжали».
//
// Минимальный период у chrome.alarms — одна минута; для догона чужих правок этого
// достаточно, ждать перечитывания всё равно никто не должен.
const REFRESH_ALARM = 'pm-refresh-after-write';

function scheduleRefresh() {
    listAllCache = null;   // мы только что писали — прежний снимок листа устарел
    // Пересоздание сдвигает срок — это и есть склейка: десять отметок подряд дадут
    // одно перечитывание, а не десять.
    chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 1 });
}

function updateBadge(rows) {
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    chrome.action.setBadgeText({ text: rows.length ? String(rows.length) : '' });
}

function broadcast(rows) {
    chrome.tabs.query({ url: MAIL_URL_PATTERNS }, function (tabs) {
        tabs.forEach(function (t) {
            chrome.tabs.sendMessage(t.id, { type: 'pm-rows', rows: rows }).catch(function () {});
        });
    });
}

// === ДОБАВЛЕНИЕ СТРОКИ (перетаскивание письма на панель) ===
// Логика перенесена из popup.js (addRowToSheet), чтобы панель могла добавлять
// строку сама, без открытия попапа. Дату пишем USER_ENTERED (ISO), остальное RAW.

// Нормализация номера для сравнения (та же логика, что в форме захвата).
function normalizeNumber(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
}

// Ищет НЕвыполненные строки с таким же номером ЗП/перемещения. Возвращает массив
// человекочитаемых номеров строк-дублей. token можно передать снаружи, чтобы не
// брать его повторно (быстрее — все чтения при добавлении идут одним токеном).
// Нормализация темы для сравнения: регистр, ё/е, префиксы Re/Fwd, любые
// разделители. Та же логика, что в панели (normForMatch) — чтобы «дубль» понимался
// одинаково и формой Alt+Y, и перетаскиванием.
function normalizeTopic(v) {
    return String(v == null ? '' : v)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/^\s*(re|fwd|fw)\s*:\s*/i, '')
        .replace(/[\s\-–—_.,:;!?()"'«»\/\\]+/g, ' ')
        .trim();
}

// Разбирает колонку «ID письма» на id писем и время (ts:). Тот же формат, что
// пишет панель: «t193…,193…,ts:1788…,u:113…».
function parseRowMailId(raw) {
    const ids = new Set();
    let ts = 0;
    let owner = '';
    String(raw || '').split(',').forEach(function (part) {
        const v = String(part || '').trim();
        const m = v.match(/^ts:(\d{10,})$/);
        if (m) { ts = Number(m[1]) || 0; return; }
        // u:<uid ящика> — ЧЕЙ ящик выдал эти id. Без него сравнивать id нельзя:
        // у каждого ящика они свои, и непересечение чужих id ничего не доказывает.
        const u = v.match(/^u:(\d{3,})$/);
        if (u) { owner = u[1]; return; }
        const bare = v.replace(/^t/, '');
        if (/^\d{6,}$/.test(bare)) ids.add(bare);
    });
    return { ids: ids, ts: ts, owner: owner };
}

// Начало текста письма для сравнения: та же нормализация, что у темы, обрезанная
// до общего префикса — почта и список показывают разную длину сниппета.
function normalizePreview(v) {
    return normalizeTopic(v).slice(0, 60);
}

// Совпадение по ТЕМЕ — слабое: у одного склада десятки переписок с одинаковой темой
// («Перемещение Королёв Стан — Могилев»), и это РАЗНЫЕ ветки, а не одно письмо.
// Поэтому такое совпадение отбрасывается, как только видно, что письма разные.
// Смотрим то, что письмо отличает: id письма, время письма и начало текста.
// Отбрасываем ТОЛЬКО при доказательстве различия: нечем сравнить — считаем дублем,
// как и раньше, чтобы одно и то же письмо не легло в таблицу дважды.
//
// Возвращает: true — это точно ДРУГОЕ письмо, дублем не считать.
function looksLikeDifferentMail(rowMailId, rowPreview, want) {
    if (!want) return false;
    const row = parseRowMailId(rowMailId);

    // 1) id. У каждого ящика id свои, поэтому сверяем, только если обе стороны из
    //    ОДНОГО ящика (иначе непересечение ничего не доказывает).
    if (want.ids && want.ids.size && row.ids.size &&
        (!want.owner || !row.owner || want.owner === row.owner)) {
        let common = false;
        row.ids.forEach(function (x) { if (want.ids.has(x)) common = true; });
        if (common) return false;          // тот же самый разговор — дубль
        // id есть у обоих и не пересеклись. Это разные письма — но добить решение
        // даём времени ниже: id могли устареть (письмо перенесли, ветку почистили).
        if (want.ts && row.ts) return Math.abs(want.ts - row.ts) > 120000;
        return true;
    }

    // 2) Время письма. Оно одинаково во всех ящиках — самая надёжная примета, когда
    //    id сравнить нельзя. Две минуты допуска: у разных писем разница больше.
    if (want.ts && row.ts) return Math.abs(want.ts - row.ts) > 120000;

    // 3) Начало текста. Последняя примета: у разных писем одной темы тела разные.
    const wantPre = normalizePreview(want.preview);
    const rowPre = normalizePreview(rowPreview);
    if (wantPre.length >= 12 && rowPre.length >= 12) {
        const n = Math.min(wantPre.length, rowPre.length);
        return wantPre.slice(0, n) !== rowPre.slice(0, n);
    }

    return false;   // сравнить нечем — пусть решает тема, как раньше
}

// Ищет НЕвыполненные строки-дубли: по номеру ЗП/перемещения ИЛИ по теме письма.
// Раньше сверялся только номер — и одно и то же письмо, добавленное формой и
// перетаскиванием, попадало в таблицу дважды (например, когда в теме два номера и
// каждый способ вытаскивал свой). Возвращает человекочитаемые номера строк.
// extra — приметы добавляемого письма { mailId, preview }: по ним слабое совпадение
// «та же тема» отсеивается, когда письма заведомо разные.
async function findDuplicateRows(spreadsheetId, sheetName, colMap, number, topic, token, extra) {
    const targetNumber = normalizeNumber(number);
    const targetTopic = normalizeTopic(topic);
    const useNumber = !!(targetNumber && colMap.number);
    const useTopic = !!(targetTopic && colMap.topic);
    if (!useNumber && !useTopic) return [];

    const enc = encodeURIComponent(sheetName);
    const ranges = [];
    const idx = {};
    function addRange(col) {
        const letter = colNumberToLetter(col);
        idx[col] = ranges.length;
        ranges.push('ranges=' + enc + '!' + letter + ':' + letter);
    }
    if (useNumber) addRange(colMap.number);
    if (useTopic) addRange(colMap.topic);
    if (colMap.done) addRange(colMap.done);
    // Приметы письма — по ним слабое совпадение «та же тема» отсеивается.
    if (colMap.mailId) addRange(colMap.mailId);
    if (colMap.preview) addRange(colMap.preview);

    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
        '/values:batchGet?' + ranges.join('&') + '&valueRenderOption=UNFORMATTED_VALUE';

    const json = token
        ? await apiFetch(token, url)
        : await withToken(true, function (t) { return apiFetch(t, url); });
    const valueRanges = json.valueRanges || [];
    function colValues(col) {
        const i = idx[col];
        return (i == null ? null : (valueRanges[i] && valueRanges[i].values)) || [];
    }
    const numbers = useNumber ? colValues(colMap.number) : [];
    const topics = useTopic ? colValues(colMap.topic) : [];
    const dones = colMap.done ? colValues(colMap.done) : [];
    const mailIds = colMap.mailId ? colValues(colMap.mailId) : [];
    const previews = colMap.preview ? colValues(colMap.preview) : [];

    // Приметы добавляемого письма.
    const wantMail = parseRowMailId(extra && extra.mailId);
    const want = {
        ids: wantMail.ids,
        ts: wantMail.ts,
        owner: wantMail.owner,
        preview: (extra && extra.preview) || ''
    };

    const dups = [];
    const rowCount = Math.max(numbers.length, topics.length);
    for (let i = 1; i < rowCount; i++) { // строка 1 — заголовок
        const doneCell = dones[i] && dones[i][0];
        if (doneCell === true) continue; // выполненные не считаем дублями
        const numberCell = numbers[i] && numbers[i][0];
        const topicCell = topics[i] && topics[i][0];
        const sameNumber = useNumber && normalizeNumber(numberCell) === targetNumber;
        let sameTopic = useTopic && !!topicCell && normalizeTopic(topicCell) === targetTopic;
        // Одна тема — ещё не одно письмо. «Перемещение Королёв Стан — Могилев» носят
        // десятки РАЗНЫХ веток; если видно, что письма разные, дублем это не считаем.
        if (sameTopic && !sameNumber) {
            const rowMailId = mailIds[i] && mailIds[i][0];
            const rowPreview = previews[i] && previews[i][0];
            if (looksLikeDifferentMail(rowMailId, rowPreview, want)) sameTopic = false;
        }
        // Помечаем, ЧТО совпало. Раньше наружу уходил только список строк, и панель
        // всегда писала «Номер «…» уже есть» — даже когда номера нет вовсе и совпала
        // одна тема. Человек читал «номер «»» и не понимал, о чём речь.
        if (sameNumber || sameTopic) dups.push({ row: i + 1, byNumber: !!sameNumber });
    }
    return dups;
}

// sheetId + сколько всего строк на листе. Число строк нужно, чтобы понять, есть ли
// уже готовая (пустая, но заранее оформленная) строка, — и не вставлять новую.
async function getSheetInfo(token, spreadsheetId, sheetName) {
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=sheets.properties';
    const meta = await apiFetch(token, url);
    const sheet = (meta.sheets || []).find(function (s) { return s.properties.title === sheetName; });
    if (!sheet) return null;
    const grid = sheet.properties.gridProperties || {};
    return { sheetId: sheet.properties.sheetId, rowCount: Number(grid.rowCount) || 0 };
}

// Кэш sheetId (лист меняется редко) — чтобы не запрашивать метаданные на каждое
// добавление. Ключ — таблица+лист.
const sheetIdCache = {};
function sheetInfoCacheClear() {
    Object.keys(sheetIdCache).forEach(function (k) { delete sheetIdCache[k]; });
}
async function getSheetIdCached(token, spreadsheetId, sheetName) {
    const info = await getSheetInfoCached(token, spreadsheetId, sheetName);
    return info ? info.sheetId : null;
}
async function getSheetInfoCached(token, spreadsheetId, sheetName) {
    const key = spreadsheetId + '\u0000' + sheetName;
    if (sheetIdCache[key]) return sheetIdCache[key];
    const info = await getSheetInfo(token, spreadsheetId, sheetName);
    if (info) sheetIdCache[key] = info;
    return info;
}

// Добавляет письмо новой строкой. data: { topic, number, warehouse, type,
// comment, supplier, document, date(ISO гггг-мм-дд) }. Возвращает:
//   { ok:true, inserted:true, rowNumber }           — добавлено;
//   { ok:true, duplicate:true, dupRows:[...] }       — найден дубль (не добавлено);
//   { ok:false, error }                              — ошибка/нет темы/нет таблицы.
async function appendRow(data, opts) {
    opts = opts || {};
    if (!data || !data.topic || !String(data.topic).trim()) return { ok: false, error: 'no-topic' };

    const { spreadsheetId, sheetName, colMap } = await getSettings();
    if (!spreadsheetId) return { ok: false, error: 'no-spreadsheet' };

    // Готовим массив значений строки по карте колонок (выключенные поля пропускаем).
    // Дату в rowData не кладём: её пишем отдельным запросом с USER_ENTERED, чтобы
    // таблица сохранила её как дату, а не как текст. Порядок при этом важен — сначала
    // строка, потом дата (см. ниже).
    const usedCols = Object.keys(colMap).map(function (k) { return colMap[k]; }).filter(function (c) { return c > 0; });
    const maxCol = usedCols.length ? Math.max.apply(null, usedCols) : 0;
    const rowData = [];
    for (let i = 0; i < maxCol; i++) rowData[i] = '';
    function put(field, value) {
        if (value && colMap[field] > 0) rowData[colMap[field] - 1] = value;
    }
    put('topic', data.topic);
    put('number', data.number);
    put('warehouse', data.warehouse);
    put('type', data.type);
    put('supplier', data.supplier);
    put('document', data.document);
    put('comment', data.comment);
    put('label', data.label);
    put('mailId', data.mailId);
    put('preview', data.preview);

    let isoDate = '';
    if (data.date && colMap.date > 0) {
        const parts = String(data.date).split('-');
        if (parts.length === 3) isoDate = parts[0] + '-' + parts[1] + '-' + parts[2];
    }

    const enc = encodeURIComponent(sheetName);
    // Дубль ищем и по номеру, и по теме — достаточно любого из полей.
    const wantDup = !opts.skipDupCheck &&
        ((data.number && String(data.number).trim() && colMap.number > 0) ||
         (data.topic && String(data.topic).trim() && colMap.topic > 0));

    const result = await withToken(true, async function (token) {
        const topicLetter = colNumberToLetter(colMap.topic || 1);
        // Параллельно и одним токеном: проверка дублей + поиск свободной строки + sheetId.
        const reads = await Promise.all([
            wantDup
                ? findDuplicateRows(spreadsheetId, sheetName, colMap, data.number, data.topic, token,
                                    { mailId: data.mailId, preview: data.preview }).catch(function () { return []; })
                : Promise.resolve([]),
            apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
                '/values/' + enc + '!' + topicLetter + ':' + topicLetter),
            getSheetInfoCached(token, spreadsheetId, sheetName)
        ]);
        const dupRows = reads[0];
        const lookup = reads[1];
        const sheetInfo = reads[2];
        const sheetId = sheetInfo && sheetInfo.sheetId;

        if (dupRows && dupRows.length) {
            return {
                duplicate: true,
                dupRows: dupRows.map(function (d) { return d.row; }),
                dupByNumber: dupRows.some(function (d) { return d.byNumber; })
            };
        }
        if (sheetId == null) throw new Error('Лист "' + sheetName + '" не найден');
        const nextRow = (lookup.values || []).length + 1;

        // Вставлять строку нужно ТОЛЬКО когда свободных строк на листе не осталось.
        // Раньше вставляли всегда — и оформление, заранее наведённое в таблице
        // (заливка, рамки, форматы, чекбоксы), затиралось: новая строка приходила с
        // форматом соседней сверху, а всё, что было ниже, сдвигалось. Если пустая
        // строка на листе уже есть, просто пишем в неё значения: Values API формат
        // ячеек не трогает вообще.
        const needInsert = !sheetInfo.rowCount || nextRow > sheetInfo.rowCount;
        if (needInsert) {
            await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        insertDimension: {
                            range: { sheetId: sheetId, dimension: 'ROWS', startIndex: nextRow - 1, endIndex: nextRow },
                            inheritFromBefore: nextRow > 1
                        }
                    }]
                })
            });
            // Лист вырос — запомненное число строк устарело.
            sheetInfo.rowCount = nextRow;
        }

        // Значения строки (RAW), затем дата (USER_ENTERED) — СТРОГО по очереди.
        //
        // Раньше эти два запроса шли параллельно «потому что диапазоны не
        // пересекаются». Они пересекаются: первый пишет с A<строка> массив длиной во
        // все используемые колонки, и в позиции даты там пустая строка (в rowData дату
        // не кладём). Второй пишет дату в ту же ячейку. Кто из них ляжет последним,
        // решал Google — и когда последней оказывалась запись строки, дата затиралась
        // пустотой. Отсюда «иногда дата не проставляется, и от способа добавления это
        // не зависит»: гонка, а не путь добавления.
        await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
            '/values/' + enc + '!A' + nextRow + '?valueInputOption=RAW', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [rowData] })
        });
        if (isoDate && colMap.date > 0) {
            const dateLetter = colNumberToLetter(colMap.date);
            await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId +
                '/values/' + enc + '!' + dateLetter + nextRow + '?valueInputOption=USER_ENTERED', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ values: [[isoDate]] })
            }).catch(function () { /* дата останется текстом — панель распарсит */ });
        }
        return { rowNumber: nextRow };
    });

    if (result.duplicate) {
        return { ok: true, duplicate: true, dupRows: result.dupRows,
                 dupByNumber: !!result.dupByNumber };
    }

    // Список обновляем в фоне — не держим ответ (панель всё равно дёрнет обновление).
    scheduleRefresh();
    return { ok: true, inserted: true, rowNumber: result.rowNumber };
}

// Удаляет строку целиком — для кнопки «Отменить» сразу после перетаскивания.
// Перед удалением сверяем тему в строке (если передана), чтобы из-за возможного
// сдвига строк не удалить чужую. Возвращает { ok } или { ok:false, error }.
async function deleteRow(rowNumber, topic) {
    if (!rowNumber || rowNumber < 2) return { ok: false, error: 'bad-row' };
    const { spreadsheetId, sheetName, colMap } = await getSettings();
    const enc = encodeURIComponent(sheetName);

    return await withToken(true, async function (token) {
        if (topic) {
            const topicLetter = colNumberToLetter(colMap.topic || 1);
            const cell = await apiFetch(token,
                'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + enc + '!' + topicLetter + rowNumber);
            const val = cell.values && cell.values[0] && cell.values[0][0];
            if (String(val || '').trim() !== String(topic).trim()) {
                return { ok: false, error: 'row-mismatch' };
            }
        }
        const sheetId = await getSheetIdCached(token, spreadsheetId, sheetName);
        if (sheetId == null) return { ok: false, error: 'no-sheet' };

        await apiFetch(token, 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [{
                    deleteDimension: {
                        range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
                    }
                }]
            })
        });
        scheduleRefresh();
        return { ok: true };
    });
}

// Возвращает ВСЕ строки листа (включая выполненные) с флагом done — для кнопки меток,
// которой нужно и проставить метку невыполненным, и снять её с выполненных. Обычный
// список панели (fetchAndProcessRows) выполненные отфильтровывает, поэтому нужен
// отдельный проход.
async function fetchAllRowsRaw(interactive) {
    const { spreadsheetId, sheetName, colMap } = await getSettings();
    const topicIdx = colNumberToIndex(colMap.topic);
    const numberIdx = colNumberToIndex(colMap.number);
    const doneIdx = colNumberToIndex(colMap.done);
    const dateIdx = colNumberToIndex(colMap.date);
    const labelIdx = colNumberToIndex(colMap.label);
    const mailIdIdx = colNumberToIndex(colMap.mailId);
    const previewIdx = colNumberToIndex(colMap.preview);
    if (topicIdx === -1) throw new Error('Не задана колонка темы — проверьте Настройки');

    const values = await fetchValues(spreadsheetId, sheetName, interactive, colMap);
    if (!values.length) return [];

    const out = [];
    values.slice(1).forEach(function (row, i) {
        const topic = row[topicIdx];
        if (!topic) return;

        // Дата строки — как в fetchAndProcessRows: нужна поиску письма, чтобы
        // подтвердить нужную ветку (иначе слабые совпадения по номеру отбрасываются).
        let dateAdded = null;
        if (dateIdx !== -1) {
            const dateVal = row[dateIdx];
            if (typeof dateVal === 'number') dateAdded = serialToUTCDate(dateVal);
            else if (typeof dateVal === 'string') dateAdded = parseSheetDateString(dateVal);
        }

        out.push({
            sheetRow: i + 2,
            topic: String(topic),
            number: numberIdx !== -1 ? String(row[numberIdx] || '') : '',
            label: labelIdx !== -1 ? String(row[labelIdx] || '') : '',
            mailId: mailIdIdx !== -1 ? String(row[mailIdIdx] || '') : '',
            preview: previewIdx !== -1 ? String(row[previewIdx] || '') : '',
            dateAdded: dateAdded ? dateAdded.toISOString() : null,
            done: doneIdx !== -1 ? (row[doneIdx] === true) : false
        });
    });
    return out;
}

// Снимок всего листа для кнопки 🏷️. Каждая плашка запрашивает его сама, а «Обновить
// метки» гоняет плашки параллельно — за один прогон на семи плашках лист читался семь
// раз подряд, и все семь раз возвращали одно и то же. Держим короткий снимок и
// склеиваем одновременные запросы в один (как LABELS_INFLIGHT в панели). Любая наша
// запись в таблицу снимок сбрасывает — см. scheduleRefresh.
let listAllInflight = null;
const LIST_ALL_TTL = 12000;

async function listAllRows() {
    if (listAllCache && Date.now() - listAllCache.at < LIST_ALL_TTL) return listAllCache.rows;
    if (listAllInflight) return listAllInflight;
    listAllInflight = (async function () {
        try {
            const rows = await fetchAllRowsRaw(false);
            listAllCache = { rows: rows, at: Date.now() };
            return rows;
        } finally {
            listAllInflight = null;
        }
    })();
    return listAllInflight;
}

// Ждать сеть без потолка нельзя: chrome.identity.getAuthToken при молчаливом входе
// может не вызвать колбэк вообще, и тогда ответа не будет никогда.
const PM_GET_TIMEOUT_MS = 12000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('Таблица не ответила вовремя — попробуйте ⟳')); }, ms);
        })
    ]);
}

// === ОБРАБОТЧИКИ СООБЩЕНИЙ ===

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // Сообщения формы захвата (getEmailData/getAllLabels) обрабатывают content-скрипты
    // и popup напрямую — сюда приходят только pm-* от панели/попапа.
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('pm-') !== 0) return;

    (async function () {
        try {
            switch (msg.type) {
                case 'pm-get': {
                    const cache = await getCache();
                    const stale = !cache.updatedAt || Date.now() - cache.updatedAt > STALE_MS;

                    // Есть что показать — показываем НЕМЕДЛЕННО, а обновляемся следом,
                    // не держа ответ. Иначе панель зависит от сети и от молчаливого
                    // получения токена: chrome.identity умеет не вызвать колбэк вовсе,
                    // когда для входа нужно окно. Тогда обещание не разрешается никогда,
                    // ответа нет, и панель с попапом навсегда остаются в «загрузка…»,
                    // хотя в кэше лежат нормальные строки. Свежесть от этого не теряется:
                    // обновление придёт рассылкой, когда данные действительно изменятся.
                    if (cache.rows.length) {
                        // Строки есть — показываем их, а если прошлое чтение сорвалось,
                        // говорим об этом рядом со списком, а не вместо него.
                        sendResponse({ ok: true, rows: cache.rows, updatedAt: cache.updatedAt,
                                       warning: cache.error || null, diag: lastReadDiag });
                        if (stale) refresh(false).catch(function () {});
                        break;
                    }

                    // Показывать нечего — пробуем обновиться, но с потолком по времени
                    // и с честной ошибкой, а не бесконечным ожиданием.
                    try {
                        const fresh = await withTimeout(refresh(false), PM_GET_TIMEOUT_MS);
                        sendResponse({ ok: true, rows: fresh.rows, updatedAt: fresh.updatedAt,
                                       diag: lastReadDiag });
                    } catch (err) {
                        // Пустой кэш с ошибкой раньше отдавался как «ok, писем нет» —
                        // и выглядело это как «письма пропали», хотя причина была в
                        // чтении таблицы. Показываем причину.
                        sendResponse({ ok: false,
                                       error: cache.error || (err && err.message) || 'не удалось загрузить' });
                    }
                    break;
                }
                case 'pm-refresh': {
                    // Кнопка «Обновить» — можно показать окно входа, если нужно.
                    const fresh = await refresh(true);
                    sendResponse({ ok: true, rows: fresh.rows, updatedAt: fresh.updatedAt });
                    break;
                }
                case 'pm-refresh-silent': {
                    // Тихое автообновление (открытие панели, возврат на вкладку) —
                    // без всплывающего окна входа. Если токен протух, просто вернём
                    // ошибку, панель останется на прежних данных.
                    const fresh = await refresh(false);
                    sendResponse({ ok: true, rows: fresh.rows, updatedAt: fresh.updatedAt });
                    break;
                }
                case 'pm-markDone': {
                    sendResponse({ ok: await markDone(msg.rowNumber, msg.topic) });
                    break;
                }
                case 'pm-unmarkDone': {
                    sendResponse({ ok: await unmarkDone(msg.rowNumber, msg.topic) });
                    break;
                }
                case 'pm-editComment': {
                    sendResponse({ ok: await editComment(msg.rowNumber, msg.topic, msg.comment) });
                    break;
                }
                case 'pm-backfill-write': {
                    const bf = await backfillWrite(msg.items);
                    sendResponse({ ok: true, written: bf.written, byField: bf.byField });
                    break;
                }
                case 'pm-list-all': {
                    // Все строки (включая выполненные) — для простановки/снятия меток.
                    const rows = await listAllRows();
                    // Заодно говорим, какие колонки включены. Без этого панель не могла
                    // отличить «колонка «ID письма» выключена в настройках» от «колонка
                    // есть, но пустая», а на первом всё опознание переписки падает в
                    // догадку по теме и дате — и метки начинают уезжать на соседние
                    // письма, причём молча.
                    const { colMap } = await getSettings();
                    sendResponse({ ok: true, rows: rows, columns: {
                        mailId: !!colMap.mailId,
                        preview: !!colMap.preview,
                        label: !!colMap.label
                    } });
                    break;
                }
                case 'pm-append': {
                    // Перетащили письмо на панель → добавить строкой. При дубле по
                    // номеру возвращаем { duplicate:true, dupRows } — панель спросит.
                    sendResponse(await appendRow(msg.data, { skipDupCheck: !!msg.skipDupCheck }));
                    break;
                }
                case 'pm-delete-row': {
                    // «Отменить» после добавления перетаскиванием.
                    sendResponse(await deleteRow(msg.rowNumber, msg.topic));
                    break;
                }
                case 'pm-login': {
                    const token = await getToken(true);
                    sendResponse({ ok: !!token });
                    break;
                }
                default:
                    sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
            }
        } catch (err) {
            console.error('Ошибка обработки сообщения:', err);
            sendResponse({ ok: false, error: err.message });
        }
    })();
    return true;
});

// === ПЛАНИРОВЩИК ===
// В Manifest V3 service worker выгружается после простоя, поэтому периодические
// задачи держим только на chrome.alarms — setInterval/setTimeout здесь ненадёжны.

function ensureAlarm() {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === POLL_ALARM) {
        refresh(false).catch(function () {});
        return;
    }
    // Догон после нашей же записи (см. scheduleRefresh). Будильник одноразовый:
    // созданный без periodInMinutes, он срабатывает один раз и исчезает сам.
    if (alarm.name === REFRESH_ALARM) {
        refresh(false).catch(function () {});
    }
});

chrome.runtime.onInstalled.addListener(function () {
    ensureAlarm();
    refresh(false).catch(function () {});
});

chrome.runtime.onStartup.addListener(function () {
    ensureAlarm();
    refresh(false).catch(function () {});
});

// Горячая клавиша Ctrl+Shift+Y открывает попап (обрабатывается Chrome автоматически
// через commands._execute_action; слушатель оставлен на будущее).
if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(function () { /* _execute_action */ });
}