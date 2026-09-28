// Панель "Проблемные письма" внутри Яндекс Почты
// Версия с мгновенным отображением из кэша и фоновым обновлением

(function () {
    const HOST_ID = 'pm-ext-host';

    // Отладочные логи. Включить: localStorage.setItem('pm-debug', '1') в консоли почты.
    const DEBUG = (function () {
        try { return localStorage.getItem('pm-debug') === '1'; } catch (e) { return false; }
    })();
    function dlog() {
        if (DEBUG) console.log.apply(console, arguments);
    }

    // Версия расширения — печатаем в консоль ВСЕГДА, не только в отладке.
    // Иначе непонятно, какая сборка сейчас загружена в браузере: после замены
    // файлов расширение нужно ещё и перезагрузить на chrome://extensions.
    const PM_VERSION = (function () {
        try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
    })();
    try { console.log('[Проблемные письма] панель версии ' + PM_VERSION); } catch (e) { /* ignore */ }

    // Строки таблицы (по sheetRow), для которых поиск честно ответил «письма в этом
    // ящике нет». Нужно, чтобы отличать «ещё не искали» от «искали и не нашли»:
    // у второго кружок карточки красный, а клик по теме не лезет в поиск почты.
    const NOT_FOUND_ROWS = new Set();

    // === КЭШ ===
    const MEMORY_CACHE = {
        results: new Map(),
        updatedAt: new Map(),
        ttl: 300000 // 5 минут
    };

    const STORAGE_KEY = 'pm_email_cache';

    let latestRows = [];
    // Причина последней неудачи чтения таблицы. Пока она есть и строк нет, счётчики на
    // плашках показывают «—», а не «0»: ноль читается как «в таблице пусто», хотя на
    // самом деле данные просто не пришли.
    let latestLoadError = null;
    // Пока первый ответ от таблицы не пришёл, счётчики показывают «…», а не «0»:
    // ноль читается как «в таблице пусто» и врёт ровно в тот момент, когда данных
    // ещё просто нет.
    let rowsEverLoaded = false;

    // === ХЛЕБНЫЕ КРОШКИ ===
    // Когда вкладка перезагружается, консоль очищается — и разбираться становится не по
    // чему: строки, напечатанные секундой раньше, исчезают вместе со всем остальным.
    // Именно поэтому «письмо закрылось, а в консоли пусто» три круга подряд ничего не
    // говорило. Поэтому важные шаги пишем ещё и в хранилище, а на старте печатаем, что
    // происходило перед прошлой выгрузкой страницы.
    const TRACE_KEY = 'pm_trace';
    const TRACE_MAX = 40;
    let traceBuf = [];
    let traceSaveTimer = null;

    // Как выглядит элемент, по которому панель собирается кликнуть. Синтетический клик
    // по чужой разметке — самое вероятное объяснение «письмо закрылось само», поэтому
    // каждый такой клик называем поимённо.
    function describeEl(el) {
        if (!el) return 'null';
        const tag = String(el.tagName || '?').toLowerCase();
        const cls = String(el.className && el.className.baseVal !== undefined
            ? el.className.baseVal : (el.className || '')).slice(0, 80);
        const label = String(el.getAttribute && (el.getAttribute('aria-label') ||
            el.getAttribute('title') || el.getAttribute('data-testid')) || '').slice(0, 60);
        const text = String(el.textContent || '').trim().slice(0, 40);
        return tag + (cls ? '.' + cls.replace(/\s+/g, '.') : '') +
               (label ? ' [' + label + ']' : '') + (text ? ' «' + text + '»' : '');
    }

    function saveTrace() {
        traceSaveTimer = null;
        try { chrome.storage.local.set({ [TRACE_KEY]: traceBuf }); } catch (e) { /* ignore */ }
    }

    function trace(what, detail) {
        try {
            const item = { t: Date.now(), что: String(what),
                           адрес: String(location.hash || '').slice(0, 140) };
            if (detail != null) item.подробности = String(detail).slice(0, 200);
            // Печатаем сразу. Хранилище нужно на случай перезагрузки, но если её нет —
            // ждать следующей загрузки, чтобы увидеть, что делала панель, бессмысленно.
            console.log('[Проблемные письма] ⟐ ' + item.что +
                (item.подробности ? ' (' + item.подробности + ')' : '') +
                '   адрес: ' + (item.адрес || '—'));
            traceBuf.push(item);
            if (traceBuf.length > TRACE_MAX) traceBuf = traceBuf.slice(-TRACE_MAX);
            if (traceSaveTimer) clearTimeout(traceSaveTimer);
            traceSaveTimer = setTimeout(saveTrace, 300);
        } catch (e) { /* диагностика не должна ничего ломать */ }
    }

    function printPreviousTrace() {
        try {
            chrome.storage.local.get(TRACE_KEY, function (v) {
                const arr = (v && v[TRACE_KEY]) || [];
                if (!arr.length) return;
                const last = arr[arr.length - 1].t;
                const lines = arr.map(function (e) {
                    return '  −' + ((last - e.t) / 1000).toFixed(1) + ' с  ' + e.что +
                        (e.подробности ? ' (' + e.подробности + ')' : '') +
                        '   адрес: ' + (e.адрес || '—');
                });
                console.log('[Проблемные письма] Что делала панель перед прошлой выгрузкой ' +
                    'вкладки (последнее — внизу):\n' + lines.join('\n'));
                traceBuf = [];
                saveTrace();
            });
        } catch (e) { /* ignore */ }
    }

    // Наблюдатель за открытым письмом. В раскладке «список слева, письмо справа» письмо
    // закрывается БЕЗ смены адреса, поэтому по hashchange этот момент не поймать. Раз в
    // секунду смотрим, какое письмо открыто, и отмечаем сам момент закрытия — тогда в
    // журнале сразу видно, что панель делала за секунду до него (и делала ли вообще).
    let watchedOpenMsg = null;
    function startOpenMessageWatch() {
        setInterval(function () {
            // Освободилось — догоняем отложенное нажатие кнопки почты.
            flushPendingMailRefresh();
            let now = null;
            try { now = getOpenMessageId(); } catch (e) { return; }
            if (now === watchedOpenMsg) return;
            if (watchedOpenMsg && !now) trace('открытое письмо закрылось', 'было: ' + watchedOpenMsg);
            else if (now) trace('открыто письмо', now);
            watchedOpenMsg = now;
        }, 1000);
    }

    window.addEventListener('hashchange', function () {
        const h = String(location.hash || '');
        trace('адрес сменился', panelSetHash === h ? 'это сделали мы' : 'это сделали не мы');
        // Человек ушёл в обычный список (папка, метка, входящие) — значит с поиском,
        // куда его уводила панель, покончено. Иначе «Выполнено» на письме, открытом
        // потом из папки, вернуло бы его в старую выдачу.
        if (!/#\/?(message|thread)\//.test(h) && !/#\/?search\?/.test(h)) {
            lastPanelSearchHash = '';
        }
    });
    window.addEventListener('pagehide', function () {
        trace('страница выгружается');
        saveTrace();
    });
    window.addEventListener('beforeunload', function () {
        trace('страница перезагружается или закрывается');
        saveTrace();
    });
    let isUpdating = false;
    let observer = null;
    let updateTimeout = null;
    let isPanelOpen = false;

    // === МОСТ К API ЯНДЕКС ПОЧТЫ (через inject.js в MAIN-мире) ===
    // inject.js перехватывает «конверт» запросов почты и по нашему запросу
    // выполняет поиск письма по теме. Здесь — только отправка/приём сообщений.
    const API_BRIDGE = {
        seq: 0,
        pending: new Map(),
        ready: false
    };

    // Все сообщения мосту — строго в СВОЙ origin, а не в '*'. С '*' ответ почты
    // (письма, их темы и авторы) слышал любой фрейм на странице, включая чужие.
    // Возвращает false, если отправить не удалось: зовущий тогда не ждёт таймаут
    // впустую, а сразу сворачивается.
    function postToBridge(payload) {
        try { window.postMessage(payload, location.origin); return true; }
        catch (e) { return false; }
    }

    window.addEventListener('message', function (e) {
        // Только своё окно и свой origin: чужой фрейм не должен ни отвечать за мост,
        // ни подсовывать нам ответы почты.
        if (e.source !== window || e.origin !== location.origin || !e.data) return;
        const d = e.data;
        if (d.source === 'pm-envelope-ready') {
            API_BRIDGE.ready = true;
            dlog('🔌 API-мост готов');
            return;
        }
        // Почта сама поставила/сняла метку — печатаем, КАК она это делает. По этому
        // запросу расширение научится помечать переписку целиком, а не перечислять
        // письма поимённо (из-за чего новые ответы в ветке остаются без метки).
        if (d.source === 'pm-label-op-seen') {
            try {
                console.log('[Проблемные письма] Почта сама выполнила «' + d.op + '». ' +
                    'Её параметры: ' + JSON.stringify(d.params));
            } catch (e) { /* ignore */ }
            return;
        }
        if (d.source === 'pm-messages-params-response') {
            const p = API_BRIDGE.pending.get(d.id);
            if (p) { API_BRIDGE.pending.delete(d.id); p(d); }
            return;
        }
        if (d.source === 'pm-search-response' || d.source === 'pm-api-response') {
            const p = API_BRIDGE.pending.get(d.id);
            if (p) {
                API_BRIDGE.pending.delete(d.id);
                p(d);
            }
        }
    });

    // Общий вызов моделей web-api (do-label/do-unlabel/labels и т.п.) через inject.js.
    // models — массив [{name, params, meta}], m — значение параметра _m в URL.
    function apiRequestRaw(models, m, timeoutMs) {
        return new Promise(function (resolve, reject) {
            const id = 'pa' + (++API_BRIDGE.seq);
            const timer = setTimeout(function () {
                API_BRIDGE.pending.delete(id);
                reject(new Error('api-timeout'));
            }, timeoutMs || 15000);
            API_BRIDGE.pending.set(id, function (d) {
                clearTimeout(timer);
                if (d.ok) resolve(d.data);
                else reject(new Error(d.error || 'api-error'));
            });
            postToBridge({ source: 'pm-api-request', id: id, models: models, m: m });
        });
    }

    // Почта отклонила запрос: наш «конверт» (тело с _ckey + заголовки) протух.
    function responseHasAuthError(data) {
        try { return JSON.stringify(data).indexOf('AUTH_NO_AUTH') !== -1; }
        catch (e) { return false; }
    }

    // Просим inject.js забыть протухший конверт и подталкиваем почту сделать свежий
    // запрос («Проверить новые письма»), чтобы конверт переснялся. Ждём готовности.
    let envelopeRefreshAt = 0;
    // Почта продолжает отклонять запросы даже после переснятия конверта — значит
    // помочь может только перезагрузка страницы почты. Показываем это в подсказках.
    let AUTH_TROUBLE = false;

    // Итог авторизации ПОСЛЕ КАЖДОГО ответа, а не только после сбоя.
    //
    // Раньше флаг присваивался лишь внутри ветки «конверт протух», то есть перейти
    // из true обратно в false он мог только при следующем таком же сбое, который
    // потом починился. На практике он вставал один раз в начале смены и держался до
    // перезагрузки вкладки. А от него зависит runIncomplete в прогоне меток — значит
    // уборка «хвостов» была выключена весь день, каждая строка считалась
    // неразобранной, и authHint() бесконечно советовал F5, когда всё давно в порядке.
    function noteAuthResult(data) {
        AUTH_TROUBLE = responseHasAuthError(data);
        return AUTH_TROUBLE;
    }

    async function refreshEnvelope() {
        const now = Date.now();
        if (now - envelopeRefreshAt < 3000) {
            // Уже обновляли только что — просто дождёмся результата, не дёргая почту
            // по разу на каждый параллельный запрос.
            await waitForBridge(8000);
            return;
        }
        envelopeRefreshAt = now;
        API_BRIDGE.ready = false;
        postToBridge({ source: 'pm-envelope-invalidate' });
        // Конверт переснимается с любого НАСТОЯЩЕГО запроса почты — поэтому просто
        // просим её сходить за новыми письмами. Сторож здесь общий (см.
        // requestMailRefresh): посреди перехода панели к письму жать кнопку нельзя,
        // а прогон меток делает по пять запросов разом, и при протухшем конверте это
        // било бы по кнопке раз в три секунды всё время прогона.
        requestMailRefresh('переснимаю конверт почты');
        await waitForBridge(8000);
    }

    // Вызов модели с ожиданием моста и повторами: конверт почты мог ещё не быть
    // пойман (no-template), запрос — не успеть за таймаут, а сам конверт — протухнуть
    // (AUTH_NO_AUTH). В последнем случае пересниманием конверта лечимся на месте:
    // раньше это выглядело как «метка ставится через раз».
    async function apiRequest(models, m, timeoutMs) {
        await waitForBridge();
        let data;
        try {
            data = await apiRequestRaw(models, m, timeoutMs);
        } catch (e) {
            const msg = (e && e.message) || '';
            if (msg !== 'no-template' && msg !== 'api-timeout') throw e;
            await new Promise(function (r) { setTimeout(r, 600); });
            data = await apiRequestRaw(models, m, timeoutMs);
        }
        if (noteAuthResult(data)) {
            await refreshEnvelope();
            data = await apiRequestRaw(models, m, timeoutMs);
            noteAuthResult(data);
        }
        return data;
    }

    // Какими параметрами сама почта просит список писем. Когда открыт вид метки
    // (#/label/<lid>), это ровно тот запрос, который нам и нужен, — берём написание
    // фильтра из него, а не перебираем варианты наугад.
    function mailMessagesParams(timeoutMs) {
        return mailMessagesParamsRaw(timeoutMs).then(function (d) { return (d && d.params) || null; });
    }

    function mailMessagesParamsRaw(timeoutMs) {
        return new Promise(function (resolve) {
            const id = 'mp' + (++API_BRIDGE.seq);
            const timer = setTimeout(function () {
                API_BRIDGE.pending.delete(id);
                resolve(null);
            }, timeoutMs || 3000);
            API_BRIDGE.pending.set(id, function (d) {
                clearTimeout(timer);
                resolve(d || null);
            });
            if (!postToBridge({ source: 'pm-messages-params-request', id: id })) {
                clearTimeout(timer);
                API_BRIDGE.pending.delete(id);
                resolve(null);
            }
        });
    }

    // Строит форму запроса «письма с меткой» из настоящего запроса почты: берём её
    // params и подменяем в них значение поля, где лежит идентификатор метки. Какое это
    // поле — определяем по самому lid: он уже стоит в запросе, если открыт вид метки.
    function shapeFromMailParams(mailParams, lidStr) {
        if (!mailParams || typeof mailParams !== 'object') return null;
        const out = Object.assign({}, mailParams);
        let found = false;
        Object.keys(out).forEach(function (k) {
            const v = out[k];
            if (typeof v === 'string' && /^\d+$/.test(v) && v !== lidStr && /lid|label/i.test(k)) {
                out[k] = lidStr; found = true;
            } else if (Array.isArray(v) && v.length === 1 && /lid|label/i.test(k)) {
                out[k] = [lidStr]; found = true;
            } else if (typeof v === 'string' && v === lidStr) {
                found = true;   // уже наша метка — форма подходит как есть
            } else if (Array.isArray(v) && v.indexOf(lidStr) !== -1) {
                found = true;
            }
        });
        if (!found) return null;
        out.count = LABEL_PAGE;
        out.first = 0;
        return out;
    }

    // Поиск письма с теми же повторами и лечением конверта.
    // folderId — опционально, ограничивает поиск конкретной папкой.
    // params — необязательные ГОТОВЫЕ параметры запроса (форма, подсмотренная у самой
    // почты). Не заданы — inject соберёт запрос прежним, проверенным способом.
    async function apiSearch(topic, folderId, timeoutMs, params) {
        await waitForBridge();
        let data;
        try {
            data = await apiSearchRaw(topic, folderId, timeoutMs, params);
        } catch (e) {
            const msg = (e && e.message) || '';
            if (msg !== 'no-template' && msg !== 'api-timeout') throw e;
            await new Promise(function (r) { setTimeout(r, 800); });
            data = await apiSearchRaw(topic, folderId, timeoutMs, params);
        }
        if (noteAuthResult(data)) {
            await refreshEnvelope();
            data = await apiSearchRaw(topic, folderId, timeoutMs, params);
            noteAuthResult(data);
        }
        return data;
    }

    // Хвост для сообщений: когда почта отклоняет запросы, «письмо не найдено» вводит
    // в заблуждение — на самом деле нужен F5 на вкладке почты.
    function authHint() {
        return AUTH_TROUBLE ? ' (почта отклоняет запросы — обновите страницу почты, F5)' : '';
    }

    // Ждём готовности моста к почте (inject.js поймал «конверт»). Иначе первые
    // запросы падают в DOM-режим: дата без времени (00:00) и ветка из видимого списка.
    function pingBridge() {
        postToBridge({ source: 'pm-envelope-ping' });
    }

    function waitForBridge(timeoutMs) {
        if (API_BRIDGE.ready) return Promise.resolve(true);
        pingBridge();
        return new Promise(function (resolve) {
            const start = Date.now();
            const iv = setInterval(function () {
                if (API_BRIDGE.ready || Date.now() - start > (timeoutMs || 6000)) {
                    clearInterval(iv);
                    resolve(API_BRIDGE.ready);
                    return;
                }
                pingBridge(); // конверт мог появиться уже после единственного анонса
            }, 150);
        });
    }

    function apiSearchRaw(topic, folderId, timeoutMs, params) {
        return new Promise(function (resolve, reject) {
            const id = 'pm' + (++API_BRIDGE.seq);
            const timer = setTimeout(function () {
                API_BRIDGE.pending.delete(id);
                reject(new Error('api-timeout'));
            }, timeoutMs || 15000);

            API_BRIDGE.pending.set(id, function (d) {
                clearTimeout(timer);
                if (d.ok) resolve(d.data);
                else reject(new Error(d.error || 'api-error'));
            });

            postToBridge({ source: 'pm-search-request', id: id, topic: topic,
                           folderId: folderId, params: params || null });
        });
    }

    // Приводим таймстемп письма из web-api к миллисекундам. Яндекс отдаёт время в
    // секундах (а порой строкой) — из-за чего new Date() раньше получал Invalid Date
    // и карточка «последнего найденного» показывала «дата неизвестна».
    function apiTsToMs(value) {
        let t = Number(value);
        if (!isFinite(t) || t <= 0) return 0;
        // 10-значное значение — секунды, 13-значное — уже миллисекунды.
        return t < 1e12 ? Math.round(t * 1000) : t;
    }

    // Достаёт дату письма из ответа web-api в миллисекундах, устойчиво к формату:
    // date.timestamp (число/строка), date.iso ("2026-08-10T12:01:57"), либо число/
    // строка прямо в date. Поиск и обычная выдача кладут дату по-разному — раньше из-за
    // этого было «дата неизвестна» и выбор ветки шёл не по дате, а по порядку выдачи.
    // Тема письма из ответа web-api. Формы ответа у разных моделей и сборок почты
    // разные: у поиска тема лежит в subject строкой, а выборка по метке в части сборок
    // отдаёт её объектом ({ text: … }) или под другим именем. Пустая тема здесь стоит
    // дорого: по ней опознаётся ветка строки, добавленной в чужом ящике (id там
    // не наши), и без неё пропуск «метка уже стоит» не срабатывает ни на одной строке.
    function msgSubject(m) {
        if (!m) return '';
        const candidates = [m.subject, m.subjText, m.subjectText, m.subj, m.title];
        for (const c of candidates) {
            if (typeof c === 'string' && c.trim()) return c;
            if (c && typeof c === 'object') {
                const inner = c.text || c.value || c.subject;
                if (typeof inner === 'string' && inner.trim()) return inner;
            }
        }
        return '';
    }

    function msgDateMs(m) {
        if (!m) return 0;
        const d = m.date;
        if (d && typeof d === 'object') {
            const t = apiTsToMs(d.timestamp);
            if (t) return t;
            if (d.iso) { const p = Date.parse(d.iso); if (!isNaN(p)) return p; }
        } else if (d != null) {
            const t = apiTsToMs(d);
            if (t) return t;
            const p = Date.parse(String(d));
            if (!isNaN(p)) return p;
        }
        return apiTsToMs(m.utcTimestamp || m.utc_timestamp || m.timestamp ||
                         m.receiveDate || m.receive_date) || 0;
    }

    function formatApiDate(timestamp) {
        const ms = apiTsToMs(timestamp);
        if (!ms) return 'дата неизвестна';
        const d = new Date(ms);
        if (isNaN(d)) return 'дата неизвестна';
        // Собираем «ДД.ММ.ГГГГ, ЧЧ:ММ» вручную — надёжнее, чем полагаться на опции
        // времени в toLocaleDateString (в части окружений время отбрасывается).
        const p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
            ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // Нормализация для сопоставления: регистр, ё/е, разделители (дефис/пробел/скобки),
    // префикс "Re:". Делает совпадение устойчивым к разнице в оформлении темы.
    function normForMatch(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/^\s*(re|fwd|fw)\s*:\s*/i, '')
            .replace(/[\s\-–—_.,:;!?()"'«»\/\\]+/g, ' ')
            .trim();
    }

    // Запасное извлечение номера из самой темы (0000-0342359), если в таблице
    // отдельная колонка номера не заполнена. Берём ПЕРВОЕ вхождение — ровно то же
    // правило, что в форме захвата (content-capture.js: extractOrderNumber). Раньше
    // здесь бралось последнее, и на теме с двумя номерами («ЗП 0000-0736759 и
    // 0000-0736765…») форма и перетаскивание записывали РАЗНЫЕ номера — из-за чего
    // проверка дублей их не связывала и письмо добавлялось дважды.
    function extractNumberFromTopic(topic) {
        const m = String(topic).match(/\d{3,}[-–]\d{3,}/);
        return m ? m[0].replace(/–/g, '-') : null;
    }

    // Похоже ли значение колонки «Номер» на настоящий номер ЗП/Перемещения.
    // В эту колонку иногда пишут произвольный текст (например, название поставщика
    // «Бринекс») — по нему нельзя искать как по номеру, иначе подцепим чужую ветку,
    // где это слово встречается в теме. Считаем номером только строку с цифрами.
    function looksLikeOrderNumber(s) {
        if (!s) return false;
        const str = String(s);
        return /\d{3,}[-–]\d{3,}/.test(str) || /\d{4,}/.test(str);
    }

    // Достаёт id меток (lid) из объекта письма web-api. Разные модели/версии кладут их
    // по-разному: массив строк в labels, одиночное значение, массив объектов с полем lid,
    // либо поле lid. Собираем из всех вариантов — лишние (системные) метки потом просто не
    // совпадут со словарями. Служебные lid вида "FAKE_*"/"seen" отсекать не нужно: их имена
    // не встречаются в пользовательских словарях складов/видов.
    // Какие метки висят на письме в ответе web-api. От этого разбора зависит гораздо
    // больше, чем кажется: выборка «кто носит эту метку» принимается, только если
    // почта действительно вернула письма С меткой (иначе фильтр lid не сработал, и
    // принять такой ответ — значит счесть помеченным ВЕСЬ ящик). Не разобрали метки —
    // выборка отвергается целиком, а без неё прогон разбирает всю таблицу подряд.
    //
    // Поэтому поддерживаем все формы, в которых почта отдаёт метки:
    //   labels / label / lid / labelIds / label_ids,
    //   массивом строк, массивом объектов {lid}, КАРТОЙ lid→{...} и одиночным значением.
    // Карта раньше не разбиралась вовсе: ветка для объекта проверяла только `lid`
    // у самого поля, а `typeof {} === 'object'` уводил одиночное значение в никуда.
    function collectMsgLabelIds(m) {
        const out = [];
        if (!m) return out;
        function push(v) {
            if (v == null) return;
            if (typeof v === 'object') {
                if (v.lid != null) out.push(String(v.lid));
                else if (v.id != null) out.push(String(v.id));
                return;
            }
            const s = String(v).trim();
            if (s) out.push(s);
        }
        function take(field) {
            if (field == null) return;
            if (Array.isArray(field)) { field.forEach(push); return; }
            if (typeof field === 'object') {
                // Карта lid→{...}: идентификаторы лежат в ключах, а не в значениях.
                Object.keys(field).forEach(function (k) {
                    if (/^\d+$/.test(k)) out.push(String(k));
                    else push(field[k]);
                });
                return;
            }
            push(field);
        }
        take(m.labels);
        take(m.label);
        take(m.lid);
        take(m.labelIds);
        take(m.label_ids);
        return out;
    }

    // id письма/ветки без служебного префикса t — почта отдаёт tid то с ним, то без.
    function stripThreadPrefix(v) {
        return String(v == null ? '' : v).replace(/^t/, '');
    }

    // Разбирает колонку «ID письма» в набор идентификаторов для сопоставления.
    function parseStoredIds(raw) {
        const all = new Set();
        const tids = new Set();
        let ts = 0;
        let owner = '';
        String(raw || '').split(',').forEach(function (part) {
            const id = String(part || '').trim();
            // ts:<миллисекунды> — время письма. Идентификаторы писем у КАЖДОГО почтового
            // ящика свои, поэтому id, сохранённый одним сотрудником, во второй почте
            // ничего не значит. Время письма одинаково у всех — по нему и опознаём
            // нужную переписку, когда id чужой.
            const m = id.match(/^ts:(\d{10,})$/);
            if (m) { ts = Number(m[1]) || 0; return; }
            // u:<uid ящика> — ЧЕЙ ящик выдал эти id. Идентификаторы писем у каждого
            // сотрудника свои, поэтому проверять чужие в почте бессмысленно: запрос
            // уйдёт, ответ придёт пустой (или, хуже, укажет на другое письмо).
            const u = id.match(/^u:(\d{3,})$/);
            if (u) { owner = u[1]; return; }
            const bare = stripThreadPrefix(id);
            if (!/^\d{6,}$/.test(bare)) return;
            all.add(bare);
            // Запись с префиксом «t» — это id ВЕТКИ. Отличать его от id письма важно:
            // выборка писем по id письма в некоторых сборках почты не работает вовсе
            // («почта письмо не вернула» на каждой строке), а выборка по id ветки
            // работает всегда — её и надо звать, когда id ветки известен.
            if (/^t/.test(id)) tids.add(bare);
        });
        return { all: all, any: all.size > 0, ts: ts, owner: owner, tids: tids };
    }

    // Дописывает колонку «ID письма», НИЧЕГО НЕ ТЕРЯЯ.
    //
    // Раньше здесь стояла обычная запись: значение собиралось из того, что вернул
    // поиск ПРЯМО СЕЙЧАС, и клалось в ячейку поверх прежнего. А поиск возвращает не
    // всегда одно и то же — часть писем ветки может не попасть в выдачу, — и тогда
    // из строки пропадали id, которые уже были. Переписка от этого не уменьшается,
    // значит и список id уменьшаться не должен: только дополняться.
    //
    // Чужую строку не трогаем вовсе. Если ячейку заполнял ДРУГОЙ ящик (пометка
    // u:<uid>), его id для нас всё равно бесполезны, а перезаписать их своими —
    // значит отобрать их у сменщицы: у неё перестанет работать опознание по id.
    // Возвращает новое значение ячейки или '' — если писать нечего.
    function mergeMailIdValue(rawExisting, ids, ts, tid) {
        const old = parseStoredIds(rawExisting);
        // Свой ящик ещё не опознан — не пишем НИЧЕГО.
        //
        // Раньше здесь было только условие ниже, и оно при пустом MAILBOX_UID не
        // срабатывало: наши id дописывались в строку сменщицы и оставались под ЕЁ
        // пометкой u:. После этого строка врала обоим — её id считались нашими, наши
        // считались её, и storedIdsAreForeign отвечал неправильно в обе стороны.
        // Пустая колонка честнее испорченной: опознание переписки по теме, дате и
        // началу текста работает и без неё, а следующий прогон допишет id заново,
        // когда ящик будет известен.
        if (!MAILBOX_UID) return '';
        if (old.owner && old.owner !== MAILBOX_UID) return '';

        const plain = [];
        const seen = new Set();
        function add(v) {
            const bare = stripThreadPrefix(String(v == null ? '' : v).trim());
            if (!/^\d{6,}$/.test(bare) || seen.has(bare)) return;
            seen.add(bare);
            plain.push(bare);
        }
        // Сначала то, что уже записано, потом найденное сейчас.
        old.all.forEach(add);
        (Array.isArray(ids) ? ids : []).forEach(add);

        // id ветки — первым и с префиксом «t». Из списка обычных id его убираем:
        // раньше он попадал в строку дважды («t194…609,194…609»).
        const tidBare = stripThreadPrefix(String(tid || '')) ||
                        (old.tids.size ? Array.from(old.tids)[0] : '');
        const parts = [];
        if (tidBare && /^\d{6,}$/.test(tidBare)) parts.push('t' + tidBare);
        plain.forEach(function (x) { if (x !== tidBare) parts.push(x); });

        // Время письма не переписываем: оно опознаёт письмо, и своё у строки точнее.
        const keepTs = old.ts || ts || 0;
        if (keepTs) parts.push('ts:' + Math.round(keepTs));
        if (MAILBOX_UID) parts.push('u:' + MAILBOX_UID);
        else if (old.owner) parts.push('u:' + old.owner);

        const next = parts.join(',');
        // Ничего не изменилось — не пишем: незачем плодить правки в истории таблицы.
        return next === String(rawExisting || '').trim() ? '' : next;
    }

    // Идентификатор нашего ящика (из настоящего запроса почты, через inject.js).
    //
    // Спрашивать его ОДИН раз на старте было нельзя. inject.js узнаёт uid только из
    // настоящего запроса почты, а первый такой запрос может случиться и позже, чем
    // через три секунды после загрузки панели. Не успел — MAILBOX_UID оставался
    // пустым НА ВСЮ СЕССИЮ, и вместе с ним молча выключались оба предохранителя
    // «чей ящик»: чужие id сменщицы подставлялись ориентиром в поиск (метка уезжала
    // на соседнюю переписку), а колонка «ID письма» писалась без пометки владельца.
    // Заметить это было нельзя — никакой диагностики на этот случай не было.
    //
    // Поэтому: переспрашиваем, пока не узнаем, с растущей паузой и без предела по
    // числу попыток — ящик не меняется, узнать его надо один раз, но обязательно.
    let MAILBOX_UID = '';
    let mailboxUidInflight = null;

    async function loadMailboxUid() {
        if (MAILBOX_UID) return MAILBOX_UID;
        if (mailboxUidInflight) return mailboxUidInflight;
        mailboxUidInflight = (async function () {
            try {
                // Паузы: полсекунды, секунда, две… до минуты. Первая попытка — сразу.
                let waitMs = 500;
                let attempts = 0;
                for (;;) {
                    try {
                        const res = await mailMessagesParamsRaw();
                        if (res && res.uid) {
                            MAILBOX_UID = String(res.uid);
                            if (attempts) {
                                console.log('[Проблемные письма] Свой почтовый ящик опознан ' +
                                    '(' + MAILBOX_UID + '), с попытки ' + (attempts + 1) +
                                    '. Проверки «чей ящик выдал id» снова работают.');
                            } else {
                                dlog('Свой почтовый ящик опознан: ' + MAILBOX_UID);
                            }
                            return MAILBOX_UID;
                        }
                    } catch (e) { /* пробуем ещё */ }
                    attempts++;
                    // Говорим об этом ОДИН раз, но говорим: пока ящик не опознан, в
                    // колонку «ID письма» ничего не пишется, а чужие id не отсеиваются.
                    if (attempts === 6) {
                        try {
                            console.warn('[Проблемные письма] Свой почтовый ящик пока не опознан: ' +
                                'почта ещё не сделала ни одного запроса, из которого берётся её ' +
                                'идентификатор. Пока так — колонку «ID письма» не заполняю и не ' +
                                'отличаю свои id от чужих (переписки опознаются по теме, дате и ' +
                                'началу текста). Продолжаю спрашивать.');
                        } catch (e) { /* ignore */ }
                    }
                    await new Promise(function (r) { setTimeout(r, waitMs); });
                    waitMs = Math.min(waitMs * 2, 60000);
                }
            } finally {
                mailboxUidInflight = null;
            }
        })();
        return mailboxUidInflight;
    }

    // Сохранённые id заведомо чужие? Тогда проверять их в почте нечего.
    function storedIdsAreForeign(prefer) {
        return !!(prefer && prefer.owner && MAILBOX_UID && prefer.owner !== MAILBOX_UID);
    }

    // Это письмо из той самой переписки, id которой сохранён в таблице?
    function msgMatchesPrefer(m, prefer) {
        if (!m || !prefer || !prefer.any) return false;
        return [m.tid, m.mid, m.last_mid].some(function (x) {
            const s = stripThreadPrefix(x);
            return s && prefer.all.has(s);
        });
    }

    // Совпадает ли начало текста письма с сохранённым в таблице. Сравниваем по
    // префиксу: в списке почта обрезает превью по ширине колонки, а в ответе API
    // приходит своя длина — совпадать целиком они не обязаны.
    function previewMatches(msg, wantedNorm) {
        if (!wantedNorm) return false;
        const got = normForMatch(msg && msg.firstline);
        if (!got) return false;
        // Сравниваем ВЕСЬ доступный общий префикс, а не первые 40 символов.
        // Сорок было мало: письма приходят по шаблону, и «Доброй ночи. Водитель прибыл
        // на загрузку» — это ровно сорок символов. Два разных письма одного дня
        // («…03:35» и «…в 04:05») выглядели одинаковыми, и карточка показывала не то.
        const n = Math.min(wantedNorm.length, got.length, 200);
        if (n < 8) return false;   // слишком коротко — совпадение ни о чём не говорит
        return wantedNorm.slice(0, n) === got.slice(0, n);
    }

    // Ответ API -> объект info для карточки. Берём самое свежее письмо ИМЕННО этой ветки.
    // Порядок отбора: по теме письма -> по номеру в теме -> (если искали по номеру и
    // он только в теле) все результаты. Дальше среди подходящих веток выбираем ту, чьё
    // письмо ближе всего к дате строки из таблицы (rowDate). Для слабых совпадений
    // (номер только в теле) близость по дате обязательна — иначе null, чтобы не
    // подставить чужую свежую ветку. Если ничего не подошло — тоже null.
    function apiResponseToInfo(resp, topic, num, searchedByNumber, rowDate, prefer, preview) {
        const model = resp && resp.models && resp.models[0];
        const data = model && model.data;
        let msgs = (data && data.message) || [];
        if (!msgs.length) return null;

        // Точное попадание по сохранённому id письма (колонка «ID письма»): берём
        // ИМЕННО эту переписку и не гадаем по теме. Одинаковые темы у разных писем —
        // обычное дело («0000-0728699, ООО ТК Зелёная Русь-исправить ЗП» встречается
        // дважды разными переписками), и раньше метка уходила на чужую ветку, а отчёт
        // считал это успехом: проверка смотрела на ту же чужую ветку.
        let forcedConfident = false;
        if (prefer && prefer.any) {
            const hit = msgs.find(function (m) {
                if (!msgMatchesPrefer(m, prefer)) return false;
                // Совпадение по id принимаем, только если письмо ещё и по времени
                // похоже на нужное: id чужого ящика может случайно совпасть с чужой
                // перепиской, а время письма одинаково у всех.
                if (prefer.ts) {
                    const t = msgDateMs(m);
                    if (t && Math.abs(t - prefer.ts) > 12 * 3600000) return false;
                }
                return true;
            });
            if (hit) {
                const tid = hit.tid != null ? String(hit.tid) : '';
                msgs = tid ? msgs.filter(function (m) { return String(m.tid) === tid; }) : [hit];
                forcedConfident = true;
            }
        }

        const DAY = 86400000;
        const nt = normForMatch(topic);
        const nnum = num ? normForMatch(num) : '';
        const npre = normForMatch(preview);
        // Якорь по времени. Дата из таблицы знает только ДЕНЬ, а сохранённое время
        // письма (ts: в колонке «ID письма») — минуты. Когда в один день пришли два
        // письма с одинаковой темой, различить их может только оно.
        const rowDateTs = rowDate ? new Date(rowDate).getTime() : null;
        const preferTs = (prefer && prefer.ts) ? prefer.ts : null;
        const rowTs = preferTs != null ? preferTs : rowDateTs;

        // 1) Надёжнее всего — по теме (тема в таблице = тема письма). Если переписка
        // уже выбрана точно по id — сверять тему не нужно.
        let matched = forcedConfident
            ? msgs.slice()
            : msgs.filter(function (m) { return normForMatch(m.subject) === nt; });
        if (!matched.length) {
            matched = msgs.filter(function (m) { return nt && normForMatch(m.subject).indexOf(nt) !== -1; });
        }
        // Совпадение по теме считаем «уверенным» — такой ветке доверяем даже без
        // подтверждения датой.
        let confident = matched.length > 0;
        const subjectMatched = confident;

        // 2) По началу текста письма — РАНЬШЕ номера. Спасает там, где темы не хватает:
        //    письмо без темы («(Без темы)») или несколько разных переписок с одинаковой
        //    темой от одного поставщика — начало текста у них разное.
        const hasTopic = nt.length >= 4;
        const hasPreview = npre.length >= 8;
        let previewMatched = false;
        if (npre) {
            previewMatched = msgs.some(function (m) { return previewMatches(m, npre); });
            if (!matched.length && previewMatched) {
                matched = msgs.filter(function (m) { return previewMatches(m, npre); });
                confident = true;
            }
        }

        // Знаем и тему, и начало текста — и НИ ОДНО не совпало ни с одним письмом?
        // Значит этой переписки в ящике нет. Честно отвечаем «не найдено», а не ищем
        // дальше по номеру: номер ЗП стоит в темах десятка разных писем, и раньше на
        // этом месте метка уходила на чужую ветку — «у меня такого письма нет, а
        // расширение всё равно что-то пометило».
        if (!matched.length && hasTopic && !subjectMatched && hasPreview && !previewMatched) {
            return null;
        }

        // 3) По номеру, если он присутствует в теме письма. Когда тема в таблице есть,
        //    но НЕ совпала, это лишь догадка (номер общий у разных писем) — такую
        //    ветку ниже придётся подтверждать близкой датой.
        if (!matched.length && nnum) {
            matched = msgs.filter(function (m) { return normForMatch(m.subject).indexOf(nnum) !== -1; });
            confident = matched.length > 0 && !hasTopic;
        }

        // 4) Номер введён вручную и есть только в теле (в теме его нет). Раз поиск шёл
        //    по номеру — все результаты его содержат, но полнотекстовый поиск легко
        //    отдаёт и чужие свежие ветки, поэтому нужную подтвердим по дате ниже.
        if (!matched.length && searchedByNumber) {
            matched = msgs.slice();
            confident = false;
        }

        if (!matched.length) return null;

        // Группируем совпадения по ветке (tid). Для каждой ветки — самое свежее письмо
        // и минимальное расстояние по дате до даты письма из таблицы (rowDate).
        function msgTs(m) { return msgDateMs(m); }
        const groups = new Map();
        matched.forEach(function (m) {
            const key = m.tid || ('mid:' + m.mid);
            let g = groups.get(key);
            if (!g) { g = { msgs: [] }; groups.set(key, g); }
            g.msgs.push(m);
        });
        const candidates = [];
        groups.forEach(function (g) {
            const latest = g.msgs.slice().sort(function (a, b) { return msgTs(b) - msgTs(a); })[0];
            let dist = Infinity;
            if (rowTs != null) {
                g.msgs.forEach(function (mm) {
                    const t = msgTs(mm);
                    if (t) dist = Math.min(dist, Math.abs(t - rowTs));
                });
            }
            candidates.push({ msgs: g.msgs, latest: latest, dist: dist });
        });

        // Если веток-кандидатов несколько, а начало текста письма мы сохранили —
        // оставляем только те, где оно встречается. Это ровно тот случай, когда тема
        // одинаковая («перемещение - таборы» от одного склада), а переписки разные.
        if (candidates.length > 1 && npre) {
            const byPreview = candidates.filter(function (c) {
                return c.msgs.some(function (m) { return previewMatches(m, npre); });
            });
            if (byPreview.length && byPreview.length < candidates.length) {
                candidates.length = 0;
                byPreview.forEach(function (c) { candidates.push(c); });
                confident = true;
            }
        }

        // Выбор ветки: знаем дату строки — берём ветку, чьё письмо ближе всего к ней;
        // не знаем — берём ветку с самым свежим письмом.
        let chosen;
        if (rowTs != null) {
            chosen = candidates.slice().sort(function (a, b) { return a.dist - b.dist; })[0];
        } else {
            chosen = candidates.slice().sort(function (a, b) { return msgTs(b.latest) - msgTs(a.latest); })[0];
        }
        if (!chosen) return null;

        // Слабое совпадение (номер только в теле, тему не подтвердили): требуем, чтобы
        // письмо ветки было близко к дате строки. Нет даты строки или нет близкого
        // письма — честно «не найдено», чтобы не подставить чужую ветку.
        if (!confident) {
            const TOLERANCE = 4 * DAY;
            if (rowTs == null || chosen.dist > TOLERANCE) return null;
        }

        // Счётчик — размер именно этой ветки (по tid), а не всех совпадений: одну и ту
        // же тему/номер могут носить несколько разных переписок.
        const sameThread = chosen.msgs;

        // Какое письмо показывать в карточке.
        //
        // По умолчанию — последнее письмо ветки: по нему видно, когда по вопросу были
        // движения. Но если в строке записан id КОНКРЕТНОГО письма (а не только id
        // ветки), показывать надо именно его: человек добавил на контроль это письмо,
        // с этим текстом и этой датой. Иначе выходило так: в таблице письмо от 29.08 с
        // его текстом, а в карточке — письмо от 05.09 с другим текстом, и понять, одна
        // это переписка или разные, было невозможно.
        // «Перейти к последнему письму» рядом остаётся — последнее письмо доступно.
        const m = chosen.latest;
        // shown — письмо, которое ВИДНО в карточке. Всё остальное (дата для таблицы,
        // id для простановки метки, переход к последнему письму) по-прежнему считается
        // от последнего письма ветки: менять эти смыслы здесь нельзя.
        let shown = m;
        if (prefer && prefer.any) {
            // Ищем среди писем ветки то, чей id записан в строке.
            //
            // Раньше здесь из сохранённых id вычитались «id веток», чтобы не принять
            // ветку за письмо. Это ломалось на самом частом случае: у переписки из
            // ОДНОГО письма id ветки совпадает с id письма («t193936258954442575» и
            // «193936258954442575» — одно число), вычиталось всё, список нужных писем
            // оказывался пустым, и карточка снова брала последнее письмо ветки.
            //
            // Вычитать не нужно вовсе: сверяем только с id ПИСЬМА (mid/last_mid). Если
            // сохранён чистый id ветки, он просто ни с одним письмом не совпадёт — и мы
            // покажем последнее письмо, как и задумано.
            const exactMsg = sameThread.find(function (mm) {
                return [mm.mid, mm.last_mid].some(function (x) {
                    const k = stripThreadPrefix(x);
                    return k && prefer.all.has(k);
                });
            });
            if (exactMsg) shown = exactMsg;
        }

        // Самое раннее письмо ветки — для дозаполнения «Даты письма» (возраст на
        // контроле не должен сбрасываться на каждый новый ответ в переписке).
        let firstTs = 0;
        sameThread.forEach(function (mm) {
            const t = msgTs(mm);
            if (t && (!firstTs || t < firstTs)) firstTs = t;
        });

        // Автор — того письма, которое показываем в карточке.
        let author = 'неизвестный';
        if (shown.recipients && shown.recipients.from && shown.recipients.from.displayName) {
            author = shown.recipients.from.displayName;
        } else if (Array.isArray(shown.field)) {
            const from = shown.field.find(function (f) { return f.type === 'from'; });
            if (from && from.name) author = from.name;
        }

        // Все id писем ветки (в поиске письма приходят по одному с общим tid) — чтобы
        // метка легла на ВСЮ переписку: do-label принимает список ids через запятую.
        const mids = sameThread
            .map(function (mm) { return mm.mid; })
            .filter(function (x) { return x && !/^t/.test(String(x)); });

        // Все id меток, висящих на письмах ветки — для дозаполнения склада/вида по метке.
        const labelIdSet = new Set();
        sameThread.forEach(function (mm) {
            collectMsgLabelIds(mm).forEach(function (id) { labelIdSet.add(id); });
        });

        return {
            count: sameThread.length,
            // Показываем письмо строки (если оно опознано), а не самое свежее.
            lastDate: formatApiDate(msgDateMs(shown)),
            // Дата самого свежего письма ветки — её и пишем в таблицу.
            lastTs: msgDateMs(m),
            lastAuthor: author,
            // Пусто, если почта не вернула начало текста. Заглушку сюда класть
            // нельзя: lastPreview — это ДАННЫЕ (по ним опознаётся строка списка),
            // и подпись для человека в них не место. См. PREVIEW_MISSING_TEXT.
            lastPreview: shown.firstline || '',
            firstTs: firstTs,
            tid: m.tid || null,
            mid: m.mid || null,
            // Настоящий id письма (без префикса t) — для do-label/do-unlabel.
            lastMid: m.last_mid || (m.mid ? String(m.mid).replace(/^t/, '') : null),
            mids: mids,
            labelIds: Array.from(labelIdSet),
            // Какое письмо ветки реально показано в карточке (см. shown выше).
            shownMid: shown.mid ? String(shown.mid) : null,
            // true — переписку выбрали точно по сохранённому id, а не угадали по теме.
            exact: forcedConfident,
            fid: m.fid || null,
            // Номер, по которому нашли ветку — переход к письму добавляет его
            // в поисковый запрос, когда приходится падать на фолбэк-поиск.
            number: num || null
        };
    }

    // Приводит запись папки к { fid, name, symbolicName } независимо от формы ответа.
    // У папок Яндекса идентификатор — fid (у меток — lid), символьное имя системной
    // папки — symbolicName (inbox/sent/trash/spam/drafts/outbox/archive).
    function normFolderEntry(f) {
        if (!f || typeof f !== 'object') return null;
        const fid = f.fid != null ? String(f.fid)
            : (f.id != null ? String(f.id)
            : (f.lid != null ? String(f.lid) : null));
        const name = f.name || f.title || f.displayName || f.symbolicName;
        if (fid == null || !name) return null;
        return { fid: fid, name: String(name), symbolicName: String(f.symbolicName || f.type || '') };
    }

    function looksLikeFolder(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const hasId = v.fid != null || v.id != null;
        const hasName = !!(v.name || v.title || v.displayName || v.symbolicName);
        return hasId && hasName;
    }

    // Достаёт массив папок из data модели folders: data.folder / data.folders — массив;
    // сам data — массив; либо карта fid→{...}.
    function extractFolderArray(d) {
        if (!d) return [];
        if (Array.isArray(d.folder)) return d.folder;
        if (Array.isArray(d.folders)) return d.folders;
        if (Array.isArray(d)) return d;
        const src = (d.folder && typeof d.folder === 'object') ? d.folder
            : (d.folders && typeof d.folders === 'object') ? d.folders
            : (typeof d === 'object' ? d : null);
        if (src) {
            const mapped = Object.keys(src).map(function (k) {
                const v = src[k];
                if (v && typeof v === 'object' && v.fid == null && v.id == null) v.fid = k; // ключ карты = fid
                return (v && typeof v === 'object') ? v : null;
            }).filter(Boolean);
            if (mapped.length) return mapped;
        }
        return [];
    }

    // Обходит ответ целиком и ищет любые объекты, похожие на папки (fid+name) — на
    // случай незнакомой формы (папки бывают вложенным деревом).
    function deepFindFolders(node, depth) {
        if (!node || typeof node !== 'object' || (depth || 0) > 6) return [];
        if (Array.isArray(node)) {
            const hits = node.filter(looksLikeFolder);
            if (hits.length) return hits;
            for (const item of node) {
                const found = deepFindFolders(item, (depth || 0) + 1);
                if (found.length) return found;
            }
            return [];
        }
        const values = Object.keys(node).map(function (k) { return node[k]; });
        const direct = values.filter(looksLikeFolder);
        if (direct.length) return direct;
        for (const v of values) {
            const found = deepFindFolders(v, (depth || 0) + 1);
            if (found.length) return found;
        }
        return [];
    }

    // Получение списка ПАПОК почты. Папки — это модель `folders` (не `labels`: там метки,
    // их lid ≠ fid папки). fid папки нужен как параметр поиска для приоритета папок
    // («Отправленные» проверяем последними). Не разобрали ответ — фолбэк на прежний путь
    // через labels, а если и он пуст — вернём пусто (поиск уйдёт в глобальный фолбэк).
    let FOLDERS_CACHE = null;      // список папок кэшируем — меняются редко
    let FOLDERS_INFLIGHT = null;   // общий промис загрузки для параллельных топиков
    // null — ещё не знаем, работает ли поиск с фильтром папки (fid) в этой сборке;
    // true — работает (staging что-то находил); false — не работает (переходим на
    // глобальный поиск, чтобы не гонять запросы по всем папкам зря).
    let FOLDER_SCOPING_WORKS = null;
    let FOLDER_SCOPING_FAILS = 0;
    async function apiGetFolders() {
        if (FOLDERS_CACHE) return FOLDERS_CACHE;
        if (FOLDERS_INFLIGHT) return FOLDERS_INFLIGHT;
        const p = apiGetFoldersRaw();
        FOLDERS_INFLIGHT = p;
        try {
            const res = await p;
            // Кэшируем только непустой результат — пустой мог быть из-за временной
            // ошибки моста; тогда в следующий раз попробуем снова.
            if (res && res.length) FOLDERS_CACHE = res;
            return res;
        } finally {
            if (FOLDERS_INFLIGHT === p) FOLDERS_INFLIGHT = null;
        }
    }

    async function apiGetFoldersRaw() {
        let arr = [];
        try {
            const resp = await apiRequest([{ name: 'folders', params: { mailboxUid: 'null' }, meta: { requestAttempt: 1 } }], 'folders', 10000);
            const model = resp && resp.models && resp.models.find(function (m) { return m.name === 'folders'; });
            arr = extractFolderArray(model && model.data);
            if (!arr.length && resp) arr = deepFindFolders(resp, 0);
        } catch (e) {
            dlog('Модель folders не ответила:', (e && e.message) || e);
        }
        const out = [];
        const seen = new Set();
        arr.forEach(function (f) {
            const item = normFolderEntry(f);
            if (!item) return;
            const key = item.fid;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(item);
        });
        if (out.length) {
            dlog('[Проблемные письма] Папки (модель folders):', out);
            return out;
        }
        // Фолбэк: старый путь через labels (некоторые сборки кладут папки туда).
        try {
            const resp = await apiRequest([{ name: 'labels', params: { mailboxUid: 'null' }, meta: { requestAttempt: 1 } }], 'labels', 10000);
            const model = resp && resp.models && resp.models.find(function (m) { return m.name === 'labels'; });
            let la = extractLabelArray(model && model.data);
            if (!la.length && resp) la = deepFindLabels(resp, 0);
            la.forEach(function (l) {
                const n = normLabelEntry(l);
                if (n) out.push({ fid: n.lid, name: n.name, symbolicName: String((l && l.symbolicName) || '') });
            });
        } catch (e) {
            dlog('Фолбэк labels для папок не сработал:', (e && e.message) || e);
        }
        return out;
    }

    // Определяет приоритет папок для поиска: Входящие -> Пользовательские -> Отправленные
    function getFolderPriority(folders) {
        const inbox = [];
        const sent = [];
        const custom = [];
        
        folders.forEach(function (f) {
            // id папки/метки и символьное имя системной папки (inbox/sent/...) —
            // в разных сборках почты идентификатор лежит в fid, lid или id.
            const idStr = String(f.fid || f.lid || f.id || '').toLowerCase();
            const sym = normLabelName(f.symbolicName || '');
            const name = normLabelName(f.name || '');

            // Определяем тип папки
            if (name === 'входящие' || name === 'inbox' || sym === 'inbox' || idStr.indexOf('inbox') !== -1) {
                inbox.push(f);
            } else if (name === 'отправленные' || name === 'sent' || sym === 'sent' || idStr.indexOf('sent') !== -1) {
                sent.push(f);
            } else {
                // Пользовательские папки и остальные системные (кроме входящих/отправленных)
                custom.push(f);
            }
        });
        
        // Возвращаем массив в порядке приоритета
        return [].concat(inbox, custom, sent);
    }

    // ==== Поиск ВНУТРИ папки ====
    // Раньше сюда уходил параметр с жёстко зашитым именем `fid`. В сборке, где поле
    // называется иначе, почта молча игнорировала его и отвечала результатами по ВСЕМУ
    // ящику — то есть «поиск по папке» был поиском по всему ящику, а приоритет
    // «Отправленные последними» не действовал. Теперь имя поля берём у самой почты
    // (её собственный запрос поиска/открытия папки) и ПРОВЕРЯЕМ по ответу: все ли
    // письма действительно из запрошенной папки. Не все — поле подобрано неверно,
    // пробуем следующее написание.
    const FOLDER_KEY_CANDIDATES = ['fid', 'folder_id', 'folderId'];
    const FOLDER_KEY_STORE = 'pm_folder_key';
    let FOLDER_KEY_CONFIRMED = null;   // подтверждённое ответом имя поля
    let FOLDER_KEY_QUEUE = null;       // непроверенные написания
    let SEARCH_SPY = null;             // { tpl, textKey, folderKey } — форма поиска почты
    let searchSpyAskedAt = 0;      // когда последний раз спрашивали форму у почты

    // Форма поискового запроса, подсмотренная у самой почты. Нужна только для поиска
    // по папке: глобальный поиск работает проверенной формой, и её мы не трогаем.
    async function spiedSearchShape() {
        // Настоящий поиск почта делает только когда человек ищет сам, и случиться это
        // может позже нашего первого вопроса. Поэтому не «спросили один раз и всё», а
        // переспрашиваем — но не чаще раза в минуту, чтобы не дёргать мост зря.
        if (SEARCH_SPY) return SEARCH_SPY;
        if (Date.now() - searchSpyAskedAt < 60000) return null;
        searchSpyAskedAt = Date.now();
        try {
            const res = await mailMessagesParamsRaw();
            const p = res && res.searchParams;
            if (!p) return null;
            let textKey = null;
            Object.keys(p).forEach(function (k) {
                if (!textKey && /^(request|query|text|search_request|searchRequest)$/.test(k)
                    && typeof p[k] === 'string') textKey = k;
            });
            if (!textKey) return null;
            SEARCH_SPY = { tpl: p, textKey: textKey, folderKey: (res && res.folderKey) || null };
            try {
                console.log('[Проблемные письма] Форма поиска взята у самой почты: поле запроса «' +
                    textKey + '»' + (SEARCH_SPY.folderKey ? ', поле папки «' + SEARCH_SPY.folderKey + '»' : ''));
            } catch (e) { /* ignore */ }
        } catch (e) { /* останемся на проверенной форме */ }
        return SEARCH_SPY;
    }

    async function folderKeyOrder() {
        if (FOLDER_KEY_CONFIRMED) return [FOLDER_KEY_CONFIRMED];
        const spy = await spiedSearchShape();
        if (!FOLDER_KEY_QUEUE) {
            const seen = new Set();
            FOLDER_KEY_QUEUE = [];
            [spy && spy.folderKey].concat(FOLDER_KEY_CANDIDATES).forEach(function (k) {
                if (k && !seen.has(k)) { seen.add(k); FOLDER_KEY_QUEUE.push(k); }
            });
        } else if (spy && spy.folderKey && FOLDER_KEY_QUEUE.indexOf(spy.folderKey) === -1) {
            // Почта поискала уже после того, как мы составили список написаний, —
            // подсмотренное у неё поле пробуем первым.
            FOLDER_KEY_QUEUE.unshift(spy.folderKey);
        }
        return FOLDER_KEY_QUEUE.slice();
    }

    function rememberFolderKey(key) {
        FOLDER_KEY_CONFIRMED = key;
        FOLDER_SCOPING_WORKS = true;
        FOLDER_SCOPING_FAILS = 0;
        try { chrome.storage.local.set({ [FOLDER_KEY_STORE]: key }); } catch (e) { /* ignore */ }
        try { console.log('[Проблемные письма] Поиск по папке работает, поле — «' + key + '».'); } catch (e) { /* ignore */ }
    }

    function forgetFolderKey(key) {
        if (FOLDER_KEY_CONFIRMED === key) {
            FOLDER_KEY_CONFIRMED = null;
            try { chrome.storage.local.remove(FOLDER_KEY_STORE); } catch (e) { /* ignore */ }
        }
        if (FOLDER_KEY_QUEUE) {
            FOLDER_KEY_QUEUE = FOLDER_KEY_QUEUE.filter(function (k) { return k !== key; });
            if (!FOLDER_KEY_QUEUE.length && FOLDER_SCOPING_WORKS !== true) {
                FOLDER_SCOPING_WORKS = false;
                try {
                    console.warn('[Проблемные письма] Ни одно написание поля папки (' +
                        FOLDER_KEY_CANDIDATES.join(', ') + ') почта не учитывает — ' +
                        'перехожу на глобальный поиск. Чтобы починить, один раз найдите ' +
                        'что-нибудь через поиск почты, НАХОДЯСЬ В ПАПКЕ: расширение ' +
                        'подсмотрит нужное поле у самой почты.');
                } catch (e) { /* ignore */ }
            }
        }
    }

    // Восстанавливаем подтверждённое ранее имя поля: перебор стоит запросов.
    try {
        chrome.storage.local.get(FOLDER_KEY_STORE, function (v) {
            const k = v && v[FOLDER_KEY_STORE];
            if (k && !FOLDER_KEY_CONFIRMED) FOLDER_KEY_CONFIRMED = String(k);
        });
    } catch (e) { /* ignore */ }

    function respMessages(resp) {
        const model = resp && resp.models && resp.models[0];
        return (model && model.data && model.data.message) || [];
    }

    // Улика того, что фильтр папки сработал: у КАЖДОГО письма ответа папка запрошенная.
    // null — проверить нечем (в ответе нет папки письма), это не улика ни за, ни против.
    function messagesInFolder(msgs, folderId) {
        const want = String(folderId);
        let known = 0;
        for (const m of msgs) {
            const fid = m && (m.fid != null ? m.fid : m.folderId);
            if (fid == null || fid === '') continue;
            known++;
            if (String(fid) !== want) return false;
        }
        return known ? true : null;
    }

    async function buildFolderSearchParams(topic, folderId, folderKey) {
        const spy = await spiedSearchShape();
        let params;
        if (spy) {
            params = {};
            Object.keys(spy.tpl).forEach(function (k) { params[k] = spy.tpl[k]; });
            params[spy.textKey] = topic;
            // Чужие фильтры прошлого поиска почты (папка, метка, вложения) нам не нужны —
            // иначе унаследуем ровно ту беду, от которой лечимся.
            Object.keys(params).forEach(function (k) {
                if (/^(fid|fids|folder_id|folderId|folder|lid|label)$/.test(k)) delete params[k];
            });
            if ('first' in params) params.first = 0;
        } else {
            params = { mailboxUid: null, sort_type: 'date', request: topic,
                       search: 'search', usePublicName: '' };
        }
        params[folderKey] = String(folderId);
        return params;
    }

    // Один поиск в одной папке — с подбором и проверкой имени поля папки.
    async function apiSearchFolder(topic, folderId, timeoutMs) {
        const keys = await folderKeyOrder();
        let last = null;
        for (const key of keys) {
            const params = await buildFolderSearchParams(topic, folderId, key);
            const resp = await apiSearch(topic, folderId, timeoutMs, params);
            last = resp;
            const msgs = respMessages(resp);
            // Пусто — письма в этой папке просто нет. Улики против поля это не даёт,
            // лишние запросы другими написаниями тут ничего не выяснят.
            if (!msgs.length) return resp;
            const ok = messagesInFolder(msgs, folderId);
            if (ok === true) {
                if (FOLDER_KEY_CONFIRMED !== key) rememberFolderKey(key);
                return resp;
            }
            if (ok === false) {
                // Почта вернула письма из ДРУГИХ папок — поле проигнорировано.
                dlog('Поле папки «' + key + '» почта не учитывает, пробую следующее');
                forgetFolderKey(key);
                continue;
            }
            return resp;   // папку письма проверить нечем — принимаем ответ как есть
        }
        return last || { models: [{ data: { message: [] } }] };
    }

    // Поиск письма с приоритетом папок: Входящие -> Пользовательские -> Отправленные
    // Особенность Яндекс Почты: отправленные письма дублируются в "Отправленные" и в ветке.
    // Поэтому сначала ищем везде КРОМЕ "Отправленных", и только если не найдено — проверяем "Отправленные".
    // validate(resp) — необязательная проверка «в ответе действительно нужная ветка».
    // Без неё поиск останавливался на ПЕРВОЙ папке, где нашлись хоть какие-то письма
    // по запросу: чужая переписка со случайным совпадением обрывала перебор, а нужная
    // ветка в другой папке так и не находилась. Со стороны это выглядело как «метки
    // ставятся выборочно».
    async function apiSearchWithPriority(topic, timeoutMs, validate) {
        function accepts(resp) {
            const model = resp && resp.models && resp.models[0];
            const msgs = (model && model.data && model.data.message) || [];
            if (!msgs.length) return false;
            if (!validate) return true;
            try { return !!validate(resp); } catch (e) { return false; }
        }

        // Адаптивная защита: если постадийный поиск по папкам в этой сборке почты
        // не работает (fid игнорируется/иная семантика) — не гоняем поиск по всем
        // папкам на каждый топик, а сразу идём в глобальный. Флаг выясняется на первых
        // топиках (staging нашёл → работает; staging пуст, а глобальный нашёл → не работает).
        if (FOLDER_SCOPING_WORKS === false) {
            const resp = await apiSearch(topic, null, timeoutMs);
            return resp || { models: [{ data: { message: [] } }] };
        }

        // СНАЧАЛА один обычный поиск по всему ящику. Постадийный обход папок нужен был
        // как страховка от «нашли однотемное письмо не в той папке», но эту работу
        // теперь делает строгий отбор в apiResponseToInfo (id → тема → тело). А стоил
        // обход дорого: по запросу НА КАЖДУЮ папку и на КАЖДУЮ строку таблицы — при
        // десятке папок и трёх десятках строк это сотни последовательных запросов к
        // почте. Отсюда и «тормозит», и «поиск срабатывает с четвёртого раза»
        // (запросы упирались в таймаут). Глобальный поиск подтверждается той же
        // проверкой validate, так что точность не страдает: не подтвердился — идём
        // по папкам, как раньше.
        let globalResp = null;
        try {
            globalResp = await apiSearch(topic, null, timeoutMs);
            if (accepts(globalResp)) {
                dlog('Найдено обычным поиском по всему ящику — обход папок не нужен');
                return globalResp;
            }
        } catch (e) {
            dlog('Ошибка обычного поиска, пробуем по папкам:', e);
        }

        let folders;
        try {
            folders = await apiGetFolders();
        } catch (e) {
            dlog('Не удалось получить список папок:', e);
            folders = [];
        }

        const orderedFolders = getFolderPriority(folders);

        // Признак папки «Отправленные» — по имени или символьному имени (sent).
        // Та же логика, что в getFolderPriority, чтобы классификация не разъезжалась.
        function isSentFolder(f) {
            const name = normLabelName(f && f.name || '');
            const sym = normLabelName(f && f.symbolicName || '');
            return name === 'отправленные' || name === 'sent' || sym === 'sent';
        }
        // id папки для параметра поиска fid: в разных сборках это fid, lid или id.
        function folderIdOf(f) { return (f && (f.fid || f.lid || f.id)) || null; }

        // Разделяем папки на две группы: основные (входящие + пользовательские) и "Отправленные"
        const mainFolders = orderedFolders.filter(function(f) { return !isSentFolder(f); });
        const sentFolders = orderedFolders.filter(function(f) { return isSentFolder(f); });

        let stagedAttempted = false; // была ли хоть одна попытка поиска по папке (с fid)

        // Этап 1: Ищем в основных папках (Входящие + пользовательские)
        for (let i = 0; i < mainFolders.length; i++) {
            const folder = mainFolders[i];
            const folderId = folderIdOf(folder);
            // Нет id папки — пропускаем: поиск без fid глобальный и вернул бы письма
            // из ЛЮБОЙ папки (в т.ч. «Отправленных»), сорвав приоритет. Не нашли по
            // папкам — сработает глобальный фолбэк в конце.
            if (!folderId) { dlog('Пропуск папки без id (этап 1):', folder.name); continue; }
            stagedAttempted = true;
            dlog('Поиск в папке (этап 1):', folder.name, 'ID:', folderId);

            try {
                const resp = await apiSearchFolder(topic, folderId, timeoutMs);
                if (accepts(resp)) {
                    dlog('Письмо найдено в основной папке:', folder.name);
                    FOLDER_SCOPING_WORKS = true; FOLDER_SCOPING_FAILS = 0;
                    return resp;
                }
            } catch (e) {
                dlog('Ошибка поиска в папке:', folder.name, e);
            }
        }

        // Этап 2: Если не найдено в основных папках, ищем в "Отправленных"
        for (let i = 0; i < sentFolders.length; i++) {
            const folder = sentFolders[i];
            const folderId = folderIdOf(folder);
            if (!folderId) { dlog('Пропуск папки без id (этап 2):', folder.name); continue; }
            stagedAttempted = true;
            dlog('Поиск в папке (этап 2, отправленные):', folder.name, 'ID:', folderId);

            try {
                const resp = await apiSearchFolder(topic, folderId, timeoutMs);
                if (accepts(resp)) {
                    dlog('Письмо найдено в отправленных:', folder.name);
                    FOLDER_SCOPING_WORKS = true; FOLDER_SCOPING_FAILS = 0;
                    return resp;
                }
            } catch (e) {
                dlog('Ошибка поиска в папке:', folder.name, e);
            }
        }

        // Фолбэк: постадийный поиск по папкам ничего не дал (список папок пуст,
        // ветка в неучтённой папке, либо почта проигнорировала параметр fid) —
        // делаем один обычный глобальный поиск, чтобы не потерять письмо.
        // Так поведение никогда не хуже прежнего «одного поиска по всем папкам».
        dlog('Постадийный поиск пуст — берём результат обычного поиска');
        try {
            // Обычный поиск уже сделан в начале — второй раз почту не дёргаем.
            const resp = globalResp || await apiSearch(topic, null, timeoutMs);
            const model = resp && resp.models && resp.models[0];
            const msgs = (model && model.data && model.data.message) || [];
            // Глобальный ответ отдаём, даже если проверка его не подтвердила: решение
            // «та ли это ветка» принимает вызывающий (apiResponseToInfo), а нам важно
            // не потерять письмо.
            if (msgs.length > 0) {
                // Мы искали по папкам, ничего не нашли, а глобальный поиск письмо нашёл —
                // значит фильтр папок (fid) в этой сборке не работает. После нескольких
                // таких случаев отключаем постадийный поиск, чтобы не бить по API зря.
                // Косвенная улика: по папкам не нашли, а глобально нашли. Теперь она
                // нужна только пока поле папки не подтверждено ответом почты (это
                // делает apiSearchFolder — прямо и с первого раза). Подтверждённое
                // поле такой «уликой» не отменяем: письмо могло лежать в папке,
                // которой нет в списке (архив, спам, вложенная).
                if (stagedAttempted && FOLDER_SCOPING_WORKS !== true && !FOLDER_KEY_CONFIRMED) {
                    FOLDER_SCOPING_FAILS++;
                    if (FOLDER_SCOPING_FAILS >= 2) {
                        FOLDER_SCOPING_WORKS = false;
                        try { console.warn('[Проблемные письма] Поиск с фильтром папки не работает в этой сборке — перехожу на глобальный поиск. Приоритет «Отправленные последними» не действует. Чтобы починить, один раз найдите что-нибудь через поиск почты, находясь в папке: расширение подсмотрит нужное поле у самой почты.'); } catch (e) {}
                    }
                }
                return resp;
            }
        } catch (e) {
            dlog('Ошибка глобального фолбэк-поиска:', e);
        }

        // Если ничего не найдено, возвращаем пустой результат
        dlog('Письмо не найдено ни в одной папке');
        return { models: [{ data: { message: [] } }] };
    }

    // topic — тема письма (колонка темы), number — номер ЗП/Перемещения из таблицы.
    // Ищем по номеру (он находит письмо даже если номер только в теле), а тему
    // используем для подтверждения нужной ветки.
    // Письмо по СОХРАНЁННОМУ id — спросив почту напрямую, без текстового поиска.
    //
    // Раньше карточка любой строки строилась только поиском по теме. Для писем с
    // повторяющейся темой («Перемещение Королёв Стан -Борисов» приходит каждую ночь)
    // это гарантированная ошибка: поиск отдаёт свежие письма, и нужной ветки от 29.08
    // в его ответе может не быть вовсе — тогда сохранённому id не с чем совпасть, и
    // карточка показывает соседнюю переписку с той же темой. Сохранённый id — самое
    // точное, что у нас есть; по нему и спрашиваем.
    async function infoFromStoredIds(prefer, topic, num, dateAdded, preview) {
        if (!prefer || !prefer.any) return null;
        const ids = Array.from(prefer.all);
        if (!ids.length) return null;
        let msgs = null;

        // 1) id ВЕТКИ — самый надёжный путь: запрос «письма переписки» работает во всех
        //    сборках почты (его форму мы подсматриваем у неё самой). Выборка по id
        //    ПИСЬМА, наоборот, в части сборок не работает вовсе — в консоли это было
        //    видно как «почта письмо не вернула» на каждой строке подряд.
        const knownTids = Array.from((prefer.tids && prefer.tids.size) ? prefer.tids : []);
        for (const tid of knownTids) {
            try { msgs = await findMessagesByTid(tid); } catch (e) { msgs = null; }
            if (msgs && msgs.length) break;
        }

        // 2) Нет id ветки — пробуем по id письма, а найдя его, дотягиваем всю переписку.
        if (!msgs || !msgs.length) {
            try { msgs = await findMessagesByMids(ids); } catch (e) { msgs = null; }
            if (msgs && msgs.length) {
                const tid = msgs[0] && msgs[0].tid;
                if (tid) {
                    try {
                        const full = await findMessagesByTid(tid);
                        if (full && full.length) msgs = full;
                    } catch (e) { /* хватит и найденных писем */ }
                }
            }
        }

        // Шага «а вдруг сохранённый id — это id ветки» здесь БОЛЬШЕ НЕТ, и вот почему.
        //
        // Он перебирал все сохранённые id как id ветки. Для обычных id письма такой
        // запрос закономерно ничего не возвращает — но каждая неудача считается
        // отказом самой выборки писем переписки, и после второй она отключается НА
        // ВЕСЬ СЕАНС. В консоли это выглядело так:
        //   «Выборка писем переписки (tid) не работает в этой сборке»
        // Дальше ломалось всё, что на ней держится: точный поиск письма по id и
        // простановка метки на всю ветку — то есть механизм, который до этого работал,
        // выключался сам собой. Спекулятивные запросы к почте так делать нельзя.
        if (!msgs || !msgs.length) {
            try {
                console.warn('[Проблемные письма] По сохранённому id (' + ids.join(', ') +
                    ') почта письмо не вернула — придётся искать по теме «' + topic + '».');
            } catch (e) { /* ignore */ }
            return null;
        }
        const fake = { models: [{ name: 'messages', data: { message: msgs } }] };
        const out = apiResponseToInfo(fake, topic, num, false, dateAdded, prefer, preview);
        // Ветку нашли — её id теперь известен. Отдаём наружу, чтобы дописать в таблицу:
        // со следующего раза строка находится одним точным запросом.
        if (out && !out.tid) {
            const tid = msgs[0] && msgs[0].tid;
            if (tid) out.tid = String(tid);
        }
        // Печатаем ЧТО именно вернула почта на сохранённый id. Это единственное место,
        // где видно, одна переписка эти письма или разные: если по id письма от 29.08
        // почта отдаёт ещё и письмо от 05.09 — значит для неё это ОДНА ветка, и
        // карточка показывает её последнее письмо совершенно правильно.
        try {
            console.log('[Проблемные письма] Письмо по сохранённому id (' + ids.join(', ') + '):\n' +
                JSON.stringify({
                    'писем в ветке': msgs.length,
                    'ветка (tid)': Array.from(new Set(msgs.map(function (m) { return String(m.tid || '—'); }))),
                    'письма': msgs.slice(0, 10).map(function (m) {
                        return {
                            id: String(m.mid),
                            дата: msgDateMs(m) ? new Date(msgDateMs(m)).toLocaleString('ru-RU') : '—',
                            начало: String(m.firstline || '').slice(0, 60)
                        };
                    }),
                    'опознано точно по id': !!(out && out.exact),
                    'показано в карточке': out ? {
                        дата: out.lastDate || '—',
                        начало: String(out.preview || out.firstline || '').slice(0, 60)
                    } : null
                }, null, 2));
        } catch (e) { /* ignore */ }
        return out;
    }

    async function apiGetInfo(topicRaw, number, dateAdded, prefer, preview) {
        // Строки, записанные до починки, содержат в теме хвост вида «, 10:41» — по
        // такой теме письмо не находилось вообще. Чистим её и здесь, чтобы старые
        // строки заработали без ручной правки таблицы.
        const topic = stripRowSubjectTail(topicRaw);
        const manualRaw = number ? String(number).trim() : '';
        // Текст без цифр («Бринекс» и т.п.) номером не считаем — ищем тогда по теме.
        const manual = looksLikeOrderNumber(manualRaw) ? manualRaw : '';
        const num = manual || extractNumberFromTopic(topic);
        // Искать нечего, если темы нет (письмо «(Без темы)»): берём начало текста
        // письма — по нему полнотекстовый поиск почты находит ту же переписку.
        const previewQuery = String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const query = num || String(topic).trim() || previewQuery;
        if (!query) return null;
        // Нет даты строки, но есть сохранённое время письма — используем его: оно
        // одинаково во всех почтовых ящиках и различает письма с одинаковой темой,
        // пришедшие в один день (13:31 и 13:34 — разные переписки).
        if (!dateAdded && prefer && prefer.ts) dateAdded = new Date(prefer.ts).toISOString();

        // Сначала — по сохранённому id, напрямую у почты. Это и точнее поиска, и
        // дешевле: один-два запроса вместо поиска с перебором папок. Не получилось
        // (id устарел, письмо удалили, строку завёл другой ящик) — работаем как раньше.
        if (prefer && prefer.any && !storedIdsAreForeign(prefer)) {
            let direct = null;
            try { direct = await infoFromStoredIds(prefer, topic, num, dateAdded, preview); }
            catch (e) { direct = null; }
            if (direct && direct.exact) return direct;
        }

        // Папку принимаем, только если в её ответе действительно нашлась наша ветка.
        const resp = await apiSearchWithPriority(query, undefined, function (r) {
            const i = apiResponseToInfo(r, topic, num, !!num, dateAdded, prefer, preview);
            if (!i) return null;
            // Знаем точный id переписки — папка подходит, только если нужная ветка
            // реально в ней. Иначе перебор идёт дальше, а не останавливается на папке
            // с однотемным чужим письмом.
            if (prefer && prefer.any && !i.exact) return null;
            return i;
        });
        return apiResponseToInfo(resp, topic, num, !!num, dateAdded, prefer, preview);
    }

    // === МЕТКИ ПОЧТЫ (do-label / do-unlabel) ===
    // Кэш меток: имя(в нижнем регистре) → lid. lid у каждого аккаунта свой, поэтому
    // метку всегда ищем по имени — тогда работает и у тебя, и у сменщицы.
    let LABELS_CACHE = null;
    let LABELS_LAST_ERROR = '';   // текст последней ошибки загрузки меток — для тоста
    let LABELS_INFLIGHT = null; // общий промис загрузки — чтобы параллельные воркеры
                                // дозаполнения не дёргали список меток по нескольку раз.

    // Нормализуем имя метки для сопоставления: без крайних пробелов, схлопнутые
    // внутренние пробелы, нижний регистр, ё→е — чтобы «Проблемные » и «проблемные»
    // совпали с реальной меткой почты.
    // Эмодзи в имени метки — ЗНАЧАЩАЯ часть названия, а не украшение: «⁉️Барановичи»
    // (метка «на контроле», ставится вручную) и «Барановичи» (её вешает правило
    // обработки почты) — РАЗНЫЕ метки, и путать их нельзя: иначе расширение сняло бы
    // автоматическую метку почты как «хвост».
    //
    // Убираем только НЕВИДИМОЕ, от чего строки различаются на глаз одинаково:
    //   • селекторы начертания (U+FE0E/U+FE0F) — «⁉» и «⁉️» это один и тот же символ
    //     с необязательным «показать как эмодзи», и почта отдаёт его то так, то так;
    //   • нулевой ширины (U+200B–U+200D, U+FEFF);
    //   • разные формы записи одного символа — приводим через NFC.
    function normLabelName(s) {
        let out = String(s || '');
        try { out = out.normalize('NFC'); } catch (e) { /* без нормализации */ }
        return out
            .replace(/[\uFE0E\uFE0F\u200B-\u200D\uFEFF]/g, '')
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    // Приводит одну запись метки к { lid, name, user } независимо от того, как её
    // назвала конкретная версия почты (name/title/symbolicName; lid/id; ключ карты).
    function normLabelEntry(l, keyFallback) {
        if (!l || typeof l !== 'object') return null;
        const lid = l.lid != null ? String(l.lid)
            : (l.id != null ? String(l.id)
            : (keyFallback != null ? String(keyFallback) : null));
        const name = l.name || l.title || l.symbolicName || l.displayName;
        if (lid == null || !name) return null;
        return { lid: lid, name: String(name), user: !!l.user };
    }

    // Достаёт массив меток из data модели, поддерживая разные формы:
    // data.label / data.labels — массив; сам data — массив; либо карта lid→{...}.
    function extractLabelArray(d) {
        if (!d) return [];
        if (Array.isArray(d.label)) return d.label;
        if (Array.isArray(d.labels)) return d.labels;
        if (Array.isArray(d)) return d;
        const src = (d.label && typeof d.label === 'object') ? d.label
            : (d.labels && typeof d.labels === 'object') ? d.labels
            : (typeof d === 'object' ? d : null);
        if (src) {
            const mapped = Object.keys(src).map(function (k) {
                const v = src[k];
                return (v && typeof v === 'object') ? normLabelEntry(v, k) : null;
            }).filter(Boolean);
            if (mapped.length) return mapped;
        }
        return [];
    }

    // Похож ли объект на запись метки: есть id и есть имя.
    function looksLikeLabel(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const hasId = v.lid != null || v.id != null;
        const hasName = !!(v.name || v.title || v.symbolicName || v.displayName);
        return hasId && hasName;
    }

    // Обходит ответ целиком и ищет ЛЮБОЙ массив/карту записей, похожих на метки.
    // Жёсткий разбор (data.label / data.labels) на части сборок почты давал пустой
    // список — тогда не резолвился ни один lid, и все метки «не находились в почте».
    function deepFindLabels(node, depth) {
        if (!node || typeof node !== 'object' || (depth || 0) > 6) return [];
        if (Array.isArray(node)) {
            const hits = node.filter(looksLikeLabel);
            if (hits.length) return hits;
            for (const item of node) {
                const found = deepFindLabels(item, (depth || 0) + 1);
                if (found.length) return found;
            }
            return [];
        }
        const values = Object.keys(node).map(function (k) { return node[k]; });
        const direct = values.filter(looksLikeLabel);
        if (direct.length) return direct;
        for (const v of values) {
            const found = deepFindLabels(v, (depth || 0) + 1);
            if (found.length) return found;
        }
        return [];
    }

    // Метки из самой страницы почты: в боковом меню каждая метка — ссылка вида
    // #/label/<lid>, а её название — текст ссылки. Это запасной источник lid, если
    // модель labels ответила в незнакомом формате: без lid не работает ни
    // простановка, ни снятие метки.
    function labelsFromDom() {
        const out = [];
        const seen = new Set();
        let links;
        try { links = document.querySelectorAll('a[href*="label"], [role="link"][href*="label"]'); }
        catch (e) { return out; }
        links.forEach(function (a) {
            const href = String(a.getAttribute('href') || '');
            const m = href.match(/label\/(\d+)/);
            if (!m) return;
            let name = (a.getAttribute('title') || a.innerText || a.textContent || '').trim();
            // В меню рядом с названием стоит счётчик непрочитанных — отрезаем его.
            name = name.replace(/\s*\d+\s*$/, '').trim();
            if (!name || name.length > 60) return;
            const key = normLabelName(name);
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push({ lid: m[1], name: name, user: true });
        });
        return out;
    }

    async function loadLabels(force) {
        if (LABELS_CACHE && !force) return LABELS_CACHE;
        if (LABELS_INFLIGHT && !force) return LABELS_INFLIGHT;
        const p = (async function () {
            // mailboxUid строкой "null" — как в реально работающих запросах do-label/do-messages.
            let data;
            try {
                data = await apiRequest([{ name: 'labels', params: { mailboxUid: 'null' }, meta: { requestAttempt: 1 } }], 'labels');
                LABELS_LAST_ERROR = '';
            } catch (e) {
                LABELS_LAST_ERROR = (e && e.message) || String(e);
                throw e;
            }
            const model = data && data.models && data.models.find(function (m) { return m.name === 'labels'; });
            let rawArr = extractLabelArray(model && model.data);
            // Формат ответа не узнали — ищем метки по структуре во всём ответе.
            if (!rawArr.length) rawArr = deepFindLabels(data, 0);
            const list = [];
            const byName = new Map();
            rawArr.forEach(function (l, i) {
                const item = normLabelEntry(l, i);
                if (!item) return;
                list.push(item);
                byName.set(normLabelName(item.name), item.lid);
            });
            // Совсем ничего — берём метки из бокового меню почты.
            if (!list.length) {
                labelsFromDom().forEach(function (item) {
                    list.push(item);
                    byName.set(normLabelName(item.name), item.lid);
                });
                if (list.length) {
                    dlog('[Проблемные письма] Метки из ответа web-api не разобрались, взяли из меню почты:', list, data);
                }
            }
            // Диагностика: если меток 0 — покажем реальную структуру ответа в консоли
            // почты, чтобы можно было поправить модель/парсер под конкретную версию.
            if (!list.length) {
                LABELS_LAST_ERROR = 'ответ почты без меток и в меню почты меток не видно';
                try { console.warn('[Проблемные письма] Список меток пуст. Ответ web-api:', data); } catch (e) {}
            } else {
                LABELS_LAST_ERROR = '';
            }
            LABELS_CACHE = { list: list, byName: byName };
            return LABELS_CACHE;
        })();
        LABELS_INFLIGHT = p;
        try {
            return await p;
        } finally {
            if (LABELS_INFLIGHT === p) LABELS_INFLIGHT = null;
        }
    }

    async function resolveLid(name, createIfMissing) {
        const n = normLabelName(name);
        if (!n) return null;
        let c = await loadLabels(false);
        if (c.byName.has(n)) return c.byName.get(n);
        c = await loadLabels(true); // вдруг метку только что создали — перечитаем
        if (c.byName.has(n)) return c.byName.get(n);
        // Метки в почте нет. При простановке (createIfMissing) — создаём её на почте,
        // раз пользователь вписал это название в настройки «Метки на письме».
        if (createIfMissing) {
            const created = await createLabelInMail(String(name || '').trim());
            if (created) {
                const c2 = await loadLabels(true);
                if (c2.byName.has(n)) return c2.byName.get(n);
            }
        }
        return null;
    }

    // "#rrggbb" → десятичное число: именно в таком виде Яндекс принимает label_color
    // в do-labels-add (подтверждено живым запросом: color «мятный» C2F2C7 приходит
    // как label_color: "12776135" — это 0xC2F2C7 в десятичной записи).
    function hexColorToDecimalString(hex) {
        const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
        if (!m) return null;
        return String(parseInt(m[1], 16));
    }

    // Создаёт метку в Яндекс.Почте по имени. Модель подтверждена живым запросом
    // (создание через диалог «Новая метка» на странице почты): do-labels-add,
    // params: { label_name, label_color, mailboxUid: "null" }. После вызова
    // перечитываем список меток — успехом считаем только реально появившуюся метку
    // (не доверяем статусу ответа вслепую).
    let CREATE_LABEL_TRIED = new Set();
    async function createLabelInMail(name) {
        const key = normLabelName(name);
        if (!name || !key) return false;
        // Не долбим создание одной и той же метки повторно за сессию (например, если
        // почта её всё равно не отдаёт в списке) — иначе на каждом добавлении новый вызов.
        if (CREATE_LABEL_TRIED.has(key)) return false;
        CREATE_LABEL_TRIED.add(key);

        // Цвет метки — из настроек (если задан для этого имени в «Метки на письме»),
        // иначе тот же дефолт, что и в UI настроек (#ef7f5f). Ключ — как везде, где
        // хранится/читается цвет плашки (options.js, renderToggleFace): простой
        // toLowerCase, а не normLabelName — чтобы цвет совпал независимо от места чтения.
        let colorHex = '#ef7f5f';
        try {
            const colorKey = String(name || '').trim().toLowerCase();
            const st = await chrome.storage.sync.get(['labelColors']);
            const custom = st && st.labelColors && st.labelColors[colorKey];
            if (custom) colorHex = custom;
        } catch (e) { /* используем дефолт */ }
        const labelColor = hexColorToDecimalString(colorHex) || hexColorToDecimalString('#ef7f5f');

        try {
            const data = await apiRequest([{
                name: 'do-labels-add',
                params: { label_name: name, label_color: labelColor, mailboxUid: 'null' },
                meta: { requestAttempt: 1 }
            }], 'do-labels-add');
            dlog('[Проблемные письма] Создаю метку «' + name + '» (do-labels-add):', data);
            const c = await loadLabels(true);
            if (c.byName.has(key)) {
                dlog('[Проблемные письма] Метка «' + name + '» создана');
                return true;
            }
            try { console.warn('[Проблемные письма] do-labels-add отработал, но метка «' + name + '» в списке не появилась — см. ответ выше'); } catch (e) {}
        } catch (e) {
            try { console.warn('[Проблемные письма] do-labels-add не сработал:', (e && e.message) || e); } catch (e2) {}
        }
        return false;
    }

    // id меток (lid) → их имена. Обратная карта к loadLabels (та хранит имя→lid). Список
    // меток кэшируется (loadLabels(false)) и грузится один раз на весь прогон дозаполнения.
    // Форс-перезагрузку тут не делаем: письма почти всегда несут и системные lid, которых
    // нет в списке пользовательских меток, — иначе перечитывали бы метки на каждой строке.
    // Неизвестные (в т.ч. системные) lid просто выпадают.
    async function lidsToNames(lids) {
        if (!Array.isArray(lids) || !lids.length) return [];
        const c = await loadLabels(false);
        const byLid = new Map();
        (c.list || []).forEach(function (l) { byLid.set(String(l.lid), l.name); });
        const names = [];
        const seen = new Set();
        lids.forEach(function (id) {
            const n = byLid.get(String(id));
            if (n && !seen.has(n)) { seen.add(n); names.push(n); }
        });
        return names;
    }

    // Сопоставляет имена меток письма со словарём {keyword, <field>} и возвращает все
    // совпавшие значения (склады или виды) без повторов. Та же логика вхождения ключевого
    // слова в текст метки, что и в форме захвата (popup.js) — единое поведение.
    function matchDictByLabels(labelNames, dictionary, field) {
        const found = [];
        const seen = new Set();
        if (!Array.isArray(labelNames) || !labelNames.length) return found;
        if (!Array.isArray(dictionary) || !dictionary.length) return found;
        for (const label of labelNames) {
            const lower = String(label || '').toLowerCase();
            for (const entry of dictionary) {
                if (entry && entry.keyword && lower.includes(String(entry.keyword).toLowerCase())) {
                    const val = entry[field];
                    if (val && !seen.has(val)) { seen.add(val); found.push(val); }
                }
            }
        }
        return found;
    }

    // Успешна ли модель в ответе web-api. Форма ответа у почты плавает от версии
    // к версии и от модели к модели: status приходит то строкой ('ok'), то числом
    // (1 — успех), то объектом ({ status: 1, phrase: 'ok' }). Раньше успехом считалась
    // ТОЛЬКО строка 'ok' — из-за этого удачно поставленная метка показывалась тостом
    // «Метка не применилась». Теперь неуспех — только явная ошибка в ответе.
    function modelOk(m) {
        if (!m) return false;
        // Пустая строка — это "ошибок нет" (так почта помечает успех), а не ошибка:
        // "" != null истинно в JS, поэтому проверка на != null ошибочно топила успешные
        // ответы вида {result:"ok", error:""}. Нужна проверка на непустое значение.
        if (m.error) return false;
        if (m.data && typeof m.data === 'object' && m.data.error) return false;
        const st = m.status;
        if (st == null) return true;                       // статуса нет — судим по data
        if (typeof st === 'string') return /^(ok|success|1)$/i.test(st.trim());
        if (typeof st === 'number') return st === 1 || st === 0;
        if (typeof st === 'object') {
            if (st.error) return false;
            if (st.phrase != null && /ok/i.test(String(st.phrase))) return true;
            if (st.status != null) return Number(st.status) === 1 || Number(st.status) === 0;
            return true;
        }
        return true;
    }

    // Текст ошибки из ответа модели — для тоста и консоли.
    function modelErrorText(m) {
        if (!m) return 'нет ответа';
        const e = (m.data && m.data.error) || m.error ||
            (m.status && typeof m.status === 'object' ? m.status.error : null);
        if (e == null) return '';
        const raw = (typeof e === 'string') ? e : (e.message || e.code || e.name || JSON.stringify(e));
        if (String(raw).indexOf('AUTH_NO_AUTH') !== -1) {
            return 'почта не приняла запрос (ключ сессии устарел) — обновите страницу почты';
        }
        return String(raw).slice(0, 120);
    }

    // Ставит/снимает метку на список писем (ids — массив id писем или один id; для всей
    // ветки передаём все её письма). add=true → do-label, add=false → do-unlabel.
    // Один автоматический повтор при неуспехе: массовая простановка (🏷️ синхронизация)
    // бьёт по этому же API из НЕСКОЛЬКИХ параллельных воркеров одновременно —
    // единичные запросы под такой нагрузкой время от времени падают транзиторно
    // (не из-за неверных данных), и именно это давало «через раз применяется». Повтор
    // с небольшой паузой почти всегда решает такие временные сбои — быстрее и надёжнее,
    // чем ждать более медленную проверку «по факту» (verifyThreadLabel, у которой своя
    // пауза в 900мс и отдельный поиск).
    async function setThreadLabel(ids, labelName, add) {
        // Не смешиваем id писем и id ветки (с префиксом t): такой запрос почта
        // отклоняет, а запрос из одних только id ветки в части сборок молча ничего не
        // делает. Есть настоящие id писем — работаем только по ним.
        let list = Array.isArray(ids) ? ids.filter(Boolean).map(String) : String(ids || '').split(',');
        list = list.map(function (x) { return String(x).trim(); }).filter(Boolean);
        const plainIds = list.filter(function (x) { return x.charAt(0) !== 't'; });
        if (plainIds.length) list = plainIds;
        const idsCsv = list.join(',');
        if (!idsCsv || !labelName) return { ok: false, error: 'no-id-or-name' };
        // При простановке метки (add) создаём её в почте, если такой ещё нет.
        // При снятии не создаём — снимать несуществующую нечего.
        const lid = await resolveLid(labelName, add === true);
        if (!lid) return { ok: false, error: 'label-not-found' };
        const model = add ? 'do-label' : 'do-unlabel';

        async function attempt() {
            // mailboxUid передаём строкой "null" — ровно как в реальном запросе почты.
            const data = await apiRequest([{
                name: model,
                params: { ids: idsCsv, lid: String(lid), mailboxUid: 'null' },
                meta: { requestAttempt: 1 }
            }], model);
            const m = data && data.models && data.models[0];
            const ok = modelOk(m);
            if (!ok) {
                // Диагностика: печатаем сырой ответ, чтобы по нему можно было доучить
                // modelOk под конкретную версию почты, а не гадать по тосту.
                dlog('[Проблемные письма] ' + model + ' — ответ считаем неуспешным:', data);
            }
            return { ok: ok, error: ok ? '' : (modelErrorText(m) || 'label-failed') };
        }

        let res = await attempt();
        if (!res.ok) {
            await new Promise(function (r) { setTimeout(r, 500); });
            res = await attempt();
        }
        return res;
    }

    // Проверка по факту: есть ли метка на ветке сейчас. Нужна, когда ответ почты нам
    // не понравился, — чтобы не пугать ложной ошибкой, если метка на самом деле легла.
    // Возвращает true / false / null (проверить не удалось).
    async function verifyThreadLabel(topic, number, dateAdded, labelName, prefer, preview) {
        try {
            const lid = await resolveLid(labelName);
            if (!lid) return null;
            // Небольшая пауза: поиск почты подхватывает изменение метки не мгновенно.
            await new Promise(function (r) { setTimeout(r, 900); });
            const info = await apiGetInfo(topic, number, dateAdded || null, prefer, preview);
            if (!info || !Array.isArray(info.labelIds)) return null;
            return info.labelIds.some(function (id) { return String(id) === String(lid); });
        } catch (e) {
            return null;
        }
    }

    // Проверка «метка реально на этих письмах?». Сначала пробуем точную выборку по id
    // (если эта сборка почты её поддерживает) — она не зависит от того, найдётся ли
    // письмо текстовым поиском. Не вышло — падаем на проверку через поиск по теме.
    // Возвращает true / false / null (проверить не удалось).
    async function verifyLabelOnIds(ids, row, labelName, prefer) {
        try {
            const lidNow = await resolveLid(labelName);
            if (lidNow && ids && ids.length) {
                const msgs = await findMessagesByMids(ids).catch(function () { return null; });
                if (msgs && msgs.length) {
                    const set = new Set();
                    msgs.forEach(function (m) {
                        collectMsgLabelIds(m).forEach(function (x) { set.add(String(x)); });
                    });
                    return set.has(String(lidNow));
                }
            }
        } catch (e) { /* ниже — проверка через поиск */ }
        if (!row) return null;
        return await verifyThreadLabel(row.topic, row.number, row.dateAdded, labelName, prefer, row.preview);
    }

    // Достаёт id писем ветки из info (для do-label/do-unlabel/пометки прочитанным).
    function threadIdsFromInfo(info) {
        if (!info) return [];
        const ids = (info.mids && info.mids.length ? info.mids : null) || info.lastMid || info.mid;
        if (!ids) return [];
        return (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    }

    // Помечает письма ветки прочитанными. Модель метки-прочтения в web-api почты может
    // называться по-разному в разных версиях, поэтому пробуем варианты по очереди
    // (fire-and-forget: неуспех не мешает добавлению). Если оба не сработают — на почте
    // это увидим по неснятой жирности; тогда достаточно поправить имя модели ниже.
    async function markThreadRead(ids) {
        const arr = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
        const idsCsv = arr.join(',');
        if (!idsCsv) return { ok: false };
        // Точная форма запроса пометки прочитанным в этой почте (подтверждено по
        // Network): модель do-messages, action:"mark", ids — список писем через запятую.
        try {
            const data = await apiRequest([{
                name: 'do-messages',
                params: { action: 'mark', ids: idsCsv, mailboxUid: 'null' },
                meta: { requestAttempt: 1 }
            }], 'do-messages');
            const mdl = data && data.models && data.models[0];
            return { ok: modelOk(mdl) };
        } catch (e) {
            return { ok: false };
        }
    }

    // Приводит настройки к списку имён меток без повторов и пустых значений.
    // Старый формат (одно поле labelName) поддерживаем — иначе после обновления
    // расширения метка молча перестала бы ставиться.
    function normalizeLabelNames(st) {
        const raw = Array.isArray(st && st.labelNames)
            ? st.labelNames
            : ((st && st.labelName) ? [st.labelName] : []);
        const out = [];
        const seen = new Set();
        raw.forEach(function (n) {
            const t = String(n || '').trim();
            const key = normLabelName(t);
            if (t && key && !seen.has(key)) { seen.add(key); out.push(t); }
        });
        return out;
    }

    // Читает настройки авто-метки из общего хранилища.
    async function getLabelConfig() {
        try {
            const st = await chrome.storage.sync.get(['labelEnabled', 'labelName', 'labelNames',
                'labelColors', 'labelTextColors', 'labelOpacity', 'quickDoneStyle',
                'syncAllStyle']);
            return { 
                enabled: !!st.labelEnabled, 
                names: normalizeLabelNames(st),
                colors: st.labelColors || {},
                textColors: st.labelTextColors || {},
                opacity: st.labelOpacity || {},
                quickDone: st.quickDoneStyle || null,
                syncAll: st.syncAllStyle || null
            };
        } catch (e) {
            return { enabled: false, names: [], colors: {}, textColors: {}, opacity: {},
                     quickDone: null, syncAll: null };
        }
    }


    // === ОБНОВЛЕНИЕ СПИСКА ПИСЕМ — ЕДИНАЯ ТОЧКА ===
    //
    // Поводов попросить почту перерисовать список много: поставили метку, сняли
    // метку, дописали метку на ветку, убрали «хвосты», переснимаем протухший конверт.
    // Раньше на каждый повод был свой путь со своим сторожем — их набралось десять, и
    // они друг о друге не знали. Из-за этого каждая версия чинила один симптом и
    // заводила другой: сторож сужали ради «метка не появляется» и получали «письмо
    // закрылось посреди чтения», расширяли обратно — и наоборот.
    //
    // Теперь путь один, сторож один, а подряд идущие просьбы схлопываются в одно
    // нажатие. Никто, кроме requestMailRefresh, кнопку почты не трогает.

    const SYNC_BUTTON_SELECTOR =
        '[class*="SyncButton"], [data-testid*="sync" i], ' +
        'button[aria-label*="новые письма" i], [title*="новые письма" i], ' +
        '[aria-label*="Проверить почту" i]';

    const ACTIVE_FOLDER_SELECTOR =
        'a[href*="folder"][aria-current="true"], ' +
        '[class*="FolderList"] a[class*="active"], [class*="FolderList"] a[class*="_checked"], ' +
        '[class*="folder"] a[aria-current="true"]';

    const BUSY_OPEN_LETTER = 'открыто письмо';
    const BUSY_SEARCH = 'показаны результаты поиска';
    const BUSY_PANEL_NAV = 'идёт переход к письму';

    // Чем сейчас занят человек в почте. Ответ решает, можно ли УВОДИТЬ его с экрана
    // (клик по папке), — и он же объясняет отложенное действие в журнале.
    function mailBusyWithUser() {
        const h = String(location.hash || '');
        if (/#\/?(message|thread)\//.test(h)) return BUSY_OPEN_LETTER;
        if (/#\/?search\?/.test(h)) return BUSY_SEARCH;
        if (panelNavInFlight()) return BUSY_PANEL_NAV;
        return null;
    }

    // Что мешает нажать кнопку почты ПРЯМО СЕЙЧАС (null — ничего).
    //
    // Из результатов поиска кнопка не выбрасывает: человек остаётся на том же
    // запросе, это видно в журнале. А вот открытое письмо она закрывает (в этой
    // сборке уводит во «Входящие»), и ровно так же рвёт незаконченный переход самой
    // панели.
    //
    // Про переход важно: это НЕ занятость человека, это наша собственная цепочка
    // отложенных шагов — клик по папке, ожидание списка, прокрутка, поиск. Между
    // ними проходят секунды, и нажатие посреди уводит с того экрана, на котором
    // следующий шаг собирается работать. В 2.91 сторож сузили до одного лишь
    // открытого письма — и заодно, не заметив, сняли защиту с перехода. Здесь она
    // возвращена и не снимается даже по force: тот, кто зовёт с force, отвечает за
    // СВОЁ действие, а не за чужую цепочку, которая идёт параллельно.
    function mailRefreshBlocker(force) {
        if (panelNavInFlight()) return BUSY_PANEL_NAV;
        if (force) return null;
        const busy = mailBusyWithUser();
        return (busy && busy !== BUSY_SEARCH) ? busy : null;
    }

    // Одно отложенное обновление на всю панель. Десять поводов, пришедшихся на время
    // чтения письма, схлопываются в одно нажатие, когда письмо закроют, — а не в
    // десять подряд.
    let pendingRefresh = null;      // { level, why }

    // Когда тормошили в последний раз. Второе нажатие подряд толку не даёт: почта
    // отвечает на первое. Раньше прогон «обновить все» жал кнопку до восьми раз (по
    // разу на плашку плюс уборка «хвостов»), а одно перетаскивание — трижды за три
    // секунды. Это и выглядело как «всё мигает».
    let lastMailRefreshAt = 0;
    const MAIL_REFRESH_COALESCE_MS = 1500;

    function rememberPendingRefresh(level, why) {
        // Из двух отложенных просьб оставляем более сильную.
        if (pendingRefresh && pendingRefresh.level === 'list') level = 'list';
        pendingRefresh = { level: level, why: why || '' };
    }

    // Просьба, пришедшая внутри окна схлопывания, не выбрасывается, а ОТКЛАДЫВАЕТСЯ
    // на конец окна.
    //
    // Сначала было проще: пришла раньше полутора секунд после прошлого нажатия —
    // молча пропускаем. И это съедало ровно ту просьбу, которая важнее всех, —
    // последнюю. Порядок при перетаскивании такой: поставили метку и пометили письмо
    // прочитанным → обновили список → дозалили метку на остальные письма ветки и
    // дочитали их → попросили обновить список ещё раз. Вторая просьба приходит через
    // доли секунды после первой, то есть прямо в окно, — и пропадала. На экране
    // оставалось состояние ДО дозаливки: письма ветки выглядели непрочитанными,
    // хотя в почте уже были прочитаны.
    //
    // Теперь из очереди подряд идущих просьб выполняются две: первая сразу и
    // последняя в конце окна. Восемь нажатий из прогона «обновить все» по-прежнему
    // не превращаются в восемь, но и последнее состояние больше не теряется.
    let trailingTimer = null;
    let trailingReq = null;

    function scheduleTrailingRefresh(level, why, delay) {
        if (trailingReq && trailingReq.level === 'list') level = 'list';
        trailingReq = { level: level, why: why || '' };
        if (trailingTimer) return;
        trailingTimer = setTimeout(function () {
            trailingTimer = null;
            const r = trailingReq;
            trailingReq = null;
            // Без force: «я всё равно увожу человека» к этому моменту уже неправда —
            // за полторы секунды он мог открыть письмо. Занят — уйдёт в pendingRefresh.
            if (r) requestMailRefresh(r.why, { level: r.level });
        }, Math.max(0, delay));
    }

    // Догоняем отложенное, как только помеха ушла. Зовётся раз в секунду из
    // startOpenMessageWatch.
    function flushPendingMailRefresh() {
        if (!pendingRefresh) return;
        if (mailRefreshBlocker(false)) return;
        const p = pendingRefresh;
        pendingRefresh = null;
        trace('догоняю отложенное обновление почты', p.why);
        requestMailRefresh(p.why, { level: p.level });
    }

    // why   — для журнала: по нему в разборе видно, кто и зачем тормошил почту.
    // level — 'quiet' (по умолчанию): только кнопка почты, никуда не уводит;
    //         'list': если человек ничем не занят — ещё и клик по активной папке.
    //         Клик перерисовывает список целиком (метку, поставленную через API,
    //         почта в уже отрисованном списке не показывает), но уводит с экрана,
    //         поэтому без просьбы человека он делается только на полностью свободном
    //         экране — даже поиск его блокирует.
    // force — сторож по открытому письму не применять: зовущий сам уводит человека
    //         («Выполнено», перетаскивание), и беречь письмо тут не от чего.
    //         Переход панели force НЕ отменяет — см. mailRefreshBlocker.
    function requestMailRefresh(why, opts) {
        opts = opts || {};
        const level = opts.level === 'list' ? 'list' : 'quiet';
        const blocker = mailRefreshBlocker(!!opts.force);
        if (blocker) {
            rememberPendingRefresh(level, why);
            trace('почту не тормошу', blocker + ' — сделаю, когда освободится | ' + (why || ''));
            return false;
        }
        const now = Date.now();
        if (now - lastMailRefreshAt < MAIL_REFRESH_COALESCE_MS) {
            scheduleTrailingRefresh(level, why,
                                    lastMailRefreshAt + MAIL_REFRESH_COALESCE_MS - now);
            trace('почту тормошили только что — отложу на конец окна', why || '');
            return true;
        }
        lastMailRefreshAt = now;
        pendingRefresh = null;

        // 1) Кнопка «Проверить новые письма». Селекторы широкие — в разных сборках
        // почты она называется по-разному, а если не найти её вообще, то ни метки не
        // перерисуются, ни свежий «конверт» запроса не появится.
        let acted = false;
        try {
            const btn = document.querySelector(SYNC_BUTTON_SELECTOR);
            if (btn) {
                trace('жму кнопку почты «проверить новые письма»', (why || '') + ' | ' + describeEl(btn));
                btn.click();
                acted = true;
            }
        } catch (e) { /* не критично */ }

        // 2) Кнопки нет — «возвращаем фокус» вкладке: на это клиент почты обычно сам
        // перезапрашивает список. ЭТОТ путь перезагружает вкладку целиком, поэтому за
        // открытое письмо здесь держимся даже при force.
        if (!acted) {
            if (mailBusyWithUser() === BUSY_OPEN_LETTER) {
                rememberPendingRefresh(level, why);
                trace('почту не тормошу', 'кнопки нет, а письмо открыто — сделаю, когда закроется');
                return false;
            }
            try {
                trace('рассылаю почте синтетические focus/visibilitychange', why || '');
                window.dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
                acted = true;
            } catch (e) { /* не критично */ }
        }

        // 3) Полная перерисовка кликом по активной папке — только по явной просьбе
        // ('list') и только на свободном экране.
        if (level === 'list') {
            const busy = mailBusyWithUser();
            if (busy) {
                dlog('По папке не кликаю: ' + busy);
            } else {
                try {
                    const active = document.querySelector(ACTIVE_FOLDER_SELECTOR);
                    if (active) {
                        trace('клик по активной папке в боковом меню', describeEl(active));
                        active.click();
                        acted = true;
                    }
                } catch (e) { /* не критично */ }
            }
        }
        return acted;
    }

    // Три привычных имени — один и тот же путь выше. Разница только в уровне и в том,
    // уводит ли зовущий человека сам.
    //
    // syncMailQuietly     — после прямого действия человека («Выполнено»,
    //                       перетаскивание): письмо мы и так закрываем.
    // nudgeYandexRefresh  — фоновый повод: метку поставили/сняли, конверт переснимаем.
    // forceMailListRefresh— нужна полная перерисовка списка.
    function syncMailQuietly(why) { return requestMailRefresh(why, { force: true }); }
    function nudgeYandexRefresh(why) { return requestMailRefresh(why || 'метка изменилась'); }
    function forceMailListRefresh(why) {
        return requestMailRefresh(why || 'полная перерисовка списка', { level: 'list' });
    }
    function refreshAfterDone() { return syncMailQuietly('снята метка по «Выполнено»'); }

    // === НАВИГАЦИЯ ПАНЕЛИ ===

    // Когда панель сама повела человека к письму (открыла его или запустила поиск).
    let lastUserNavigationAt = 0;
    function markUserNavigation() { lastUserNavigationAt = Date.now(); }

    // Идёт ли МНОГОШАГОВЫЙ переход панели к письму.
    //
    // Отдельно от lastUserNavigationAt намеренно. Адрес двигают оба: и переход к
    // письму, и закрытие письма после «Выполнено». Но переход — это цепочка
    // отложенных шагов, которую рвать нельзя, а закрытие — один шаг, и ждать его не
    // надо. Пока это было одним окном, refreshAfterDone после «Выполнено» всегда
    // откладывался (панель за секунду до этого сама двинула адрес), и снятая метка
    // не пропадала с экрана до F5.
    const PANEL_NAV_WINDOW_MS = 15000;
    let panelNavUntil = 0;
    function panelNavInFlight() { return Date.now() < panelNavUntil; }
    function panelNavDone() { panelNavUntil = 0; }

    // Адрес, который панель поставила сама. Нужен, чтобы отличить «письмо открыли мы»
    // от «письмо открыл человек».
    let panelSetHash = '';
    function setMailHash(h) {
        panelSetHash = String(h);
        markUserNavigation();
        trace('панель меняет адрес', h);
        try { location.hash = h; } catch (e) { /* ignore */ }
    }

    // Переход к письму состоит из отложенных шагов: клик по папке, ожидание списка,
    // прокрутка, и только потом — поиск. Между ними проходят секунды, и человек за это
    // время успевает открыть письмо сам. Последний шаг (переход к поиску) тогда закрывал
    // то, что он читает: «открыл письмо, а оно через несколько секунд закрылось».
    // Поэтому перед каждым отложенным шагом сверяемся: адрес изменился на открытое
    // письмо, и открыли его не мы — значит человек занят, продолжать нельзя.
    function navStart() {
        markUserNavigation();
        panelNavUntil = Date.now() + PANEL_NAV_WINDOW_MS;
        return String(location.hash || '');
    }

    function userTookOver(startHash) {
        const now = String(location.hash || '');
        if (now === startHash) return false;
        if (!/#\/?(message|thread)\//.test(now)) return false;
        return now !== panelSetHash;
    }

    function abortIfUserTookOver(startHash, what) {
        if (!userTookOver(startHash)) return false;
        panelNavDone();   // цепочка кончилась — держать сторож больше незачем
        trace('шаг отменён — письмо открыли сами', what || 'переход');
        try {
            console.log('[Проблемные письма] ' + (what || 'переход') + ' отменён: ' +
                'вы открыли письмо сами, не мешаю.');
        } catch (e) { /* ignore */ }
        return true;
    }

    // Одиночная простановка/снятие метки + пометка прочитанным при добавлении.
    // add=true  — «взять на контроль»: ставим метку (если авто-метка включена) и
    //             помечаем письмо прочитанным;
    // add=false — «Выполнено»: снимаем метку (достаточно, чтобы имя метки было задано —
    //             её могли поставить и вручную кнопкой при выключенной авто-метке).
    // labelName — какую именно метку ставить (метка язычка или выбранная в форме).
    // Не передали — берём первую из списка настроек. При снятии («Выполнено») имя не
    // нужно: какая из меток стояла на письме, мы не знаем, поэтому снимаем ВСЕ
    // настроенные — чтобы на закрытом письме не осталось «хвоста».
    async function applyLabelForTopic(topic, number, add, dateAdded, labelName, mailId, preview) {
        const cfg = await getLabelConfig();
        let names;
        if (add) {
            const one = String(labelName || '').trim() || cfg.names[0] || '';
            names = (cfg.enabled && one) ? [one] : [];
            // Диагностика «тихо не ставится»: если авто-метку ждали, но она пропущена —
            // печатаем ПОЧЕМУ (выключена в настройках / не задано ни одной метки).
            if (!names.length) {
                try {
                    console.warn('[Проблемные письма] Метка при добавлении не поставлена. Причина:',
                        !cfg.enabled ? 'авто-метка выключена в настройках (labelEnabled=false)'
                                     : 'в настройках не задано ни одной метки (labelNames пуст)',
                        '| cfg:', cfg);
                } catch (e) {}
            }
        } else {
            // Знаем метку строки — снимаем только её; не знаем (старая строка) —
            // снимаем все настроенные, чтобы на закрытом письме не осталось хвоста.
            const one = String(labelName || '').trim();
            names = one ? [one] : cfg.names.slice();
        }
        // Дальше в любом случае есть что делать: даже когда метку ставить или снимать
        // не с чего (в настройках не задано ни одной), письмо надо пометить
        // прочитанным — см. markThreadRead ниже.
        try {
            // Если при добавлении сохранили настоящий id письма/ветки (см. mailId в
            // таблице) — используем его напрямую, без поиска по теме: короткие темы
            // без номера ЗП («Энергия ООО», «ТриолБел ООО» и т.п.) повторяются у
            // разных писем, и поиск по тексту темы иногда попадает не в ту переписку.
            // Но id мог сохранить ДРУГОЙ пользователь в СВОЁМ ящике — сначала проверяем,
            // что он существует именно здесь (см. verifyStoredIdsBelongHere).
            const storedIdsRaw = String(mailId || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            const prefer = parseStoredIds(mailId);
            let info = null;
            // Сохранённый id — ориентир ВНУТРИ результатов поиска: сам поиск отдаёт все
            // письма с похожей темой, и без ориентира выбиралась не та переписка.
            info = await apiGetInfo(topic, number, dateAdded || null, prefer.any ? prefer : null, preview);
            let ids = await fullThreadIds(info);
            if (!ids.length && storedIdsRaw.length) {
                ids = await verifyStoredIdsBelongHere(storedIdsRaw,
                    { topic: topic, preview: preview, ts: prefer.ts });
            }
            if (!ids.length) {
                if (names.length) {
                    try {
                        console.warn('[Проблемные письма] Метка: письмо по теме не найдено. Искали по:',
                            { topic: topic, number: number, dateAdded: dateAdded, add: add, names: names, info: info });
                    } catch (e) {}
                    showToast('Метка: письмо по теме не найдено', 'error');
                }
                return { ok: false, applied: [] };
            }
            const okNames = [];
            const notFound = [];
            let firstError = '';
            for (const name of names) {
                let res = await setThreadLabel(ids, name, add);
                // Ответ почты не распознали как успех — прежде чем показывать ошибку,
                // смотрим на факт: метка на ветке уже есть (или уже снята)?
                if (!res.ok && res.error !== 'label-not-found') {
                    const has = await verifyThreadLabel(topic, number, dateAdded, name, null, preview);
                    if (has === add) res = { ok: true, error: '' };
                }
                if (res.ok) okNames.push(name);
                else if (res.error === 'label-not-found') notFound.push(name);
                else if (!firstError) firstError = res.error;
            }
            if (names.length) {
                if (notFound.length) {
                    showToast('Метка «' + notFound.join('», «') +
                        '» не найдена в почте — проверьте название в настройках', 'error');
                } else if (firstError) {
                    showToast('Метка не применилась: ' + firstError, 'error');
                } else if (names.length === 1) {
                    showToast('Метка «' + names[0] + '» ' + (add ? 'поставлена' : 'снята'), 'success');
                } else {
                    showToast('Метки сняты: ' + okNames.length, 'success');
                }
            }
            // Письмо обработано — значит прочитано. Это верно в ОБЕ стороны:
            //   add=true  — «взять на контроль»: письмо завели в таблицу;
            //   add=false — «Выполнено»: работу по нему закончили.
            //
            // Раньше здесь стояло условие `if (wantRead)`, где wantRead = !!add, то
            // есть при снятии метки письмо прочитанным НЕ становилось. Пока «Выполнено»
            // работало только по открытому письму, это не бросалось в глаза: открытое
            // письмо почта и так помечает прочитанным сама. А с тех пор как кнопка
            // закрывает ВСЕ подходящие строки разом (одно письмо часто относится к
            // нескольким заказам), письма остальных строк человек не открывал — метка
            // с них снималась, а непрочитанными они и оставались.
            try { await markThreadRead(ids); } catch (e) { /* не критично */ }
            // Метку сняли — убираем её плашку с экрана сразу, не дожидаясь, пока почта
            // соизволит перерисоваться. Раньше это делала кнопка «проверить новые
            // письма», но она закрывает открытое письмо, и жать её при чтении нельзя.
            // ids здесь СВОИ: они получены поиском в ЭТОМ ящике, а не взяты из
            // таблицы, — по ним строка и опознаётся. Тема с датой идут запасным
            // путём, на случай если строка отрисована без id в разметке.
            if (!add && okNames.length) {
                hideLabelChipsFor(okNames, 6000, {
                    topic: topic,
                    mid: (info && (info.shownMid || info.mid)) || null,
                    ids: ids,
                    hints: navMatchOpts(Object.assign({}, info || {}, {
                        preview: preview || '',
                        rowTs: dateAdded ? (Date.parse(dateAdded) || 0) : 0
                    }))
                });
            }
            nudgeYandexRefresh(add ? 'поставлена метка' : 'снята метка');
            return { ok: okNames.length === names.length, applied: okNames };
        } catch (e) {
            showToast('Метка — ошибка: ' + friendlyErrorMessage(e), 'error');
            return { ok: false, applied: [] };
        }
    }

    // Яндекс не перерисовывает метку, поставленную через API, в уже отрисованном
    // списке писем — из-за этого метка «появлялась только после F5». Через пару
    // секунд смотрим на строку письма: метки нет — обновляем список принудительно.
    // Мгновенно убирает плашку метки с экрана.
    // Почта рисует метки оптимистично только на СВОИ действия, а нашу отмену через API
    // показывает лишь после синхронизации. Синхронизацию раньше дёргала кнопка
    // «проверить новые письма» — она же и закрывала открытое письмо. Мы перестали её
    // жать, пока человек читает, и метка стала пропадать с задержкой. Поэтому убираем
    // плашку сами: почта потом перерисует список и всё сойдётся.
    //
    // Ищем только «листовые» плашки с ТОЧНЫМ совпадением имени и обходим боковое меню:
    // там папка может называться так же, как метка («Партизан/Уручье»), и её скрывать
    // нельзя.
    const LABEL_CHIP_SKIP_PARENTS = '[class*="FolderList" i], [class*="LeftColumn" i], ' +
                                    '[class*="Folder-m" i], nav, aside';

    // Наша ли это плашка — то есть висит ли она на письме, с которого сняли метку.
    //
    // Идём ОТ ПЛАШКИ к строке, а не наоборот. Так дешевле: разбор id строки стоит
    // обхода всех её узлов, а плашек с нужным именем на экране единицы, тогда как
    // строк в списке бывает под тысячу.
    //
    // Строку опознаём как везде в панели: сначала по id — но у каждого ящика id СВОИ,
    // и у строки, заведённой сменщицей, они чужие и не совпадут никогда. Поэтому
    // дальше идут тема и дата письма.
    function rowMatchesScopeByTopic(row, scope) {
        const want = normForMatch(stripRowSubjectTail(scope.topic || ''));
        if (!want || want.length < 4) return false;
        let subj = '';
        try { subj = normForMatch(getRowSubject(row)); } catch (e) { subj = ''; }
        if (!subj) return false;
        let hit = subj === want;
        if (!hit && subj.length >= 8 && want.indexOf(subj) !== -1) hit = true;
        if (!hit && want.length >= 8 && subj.indexOf(want) !== -1) hit = true;
        if (!hit) return false;
        // Тема совпала — сверяем день. Без даты не подтверждаем: одинаковые темы
        // в разные дни — это разные переписки.
        const anchor = (scope.hints && scope.hints.ts) || 0;
        if (!anchor) return false;
        const ts = getRowDateMs(row);
        if (!ts) return false;
        return Math.abs(startOfDayMs(ts) - startOfDayMs(anchor)) <= 86400000;
    }

    function chipBelongsToScope(el, scope) {
        if (!scope) return true;   // примет строки нет — прежнее поведение, весь экран
        let row = null;
        try { row = el.closest(DRAG_ROW_SELECTOR); } catch (e) { row = null; }
        if (!row) {
            // Плашка не в строке списка — значит в самом открытом письме.
            let open = '';
            try { open = stripThreadPrefix(String(getOpenMessageId() || '')); } catch (e) { open = ''; }
            return !!(open && scope.idSet.has(open));
        }
        if (scope.idSet.size) {
            let ids = [];
            try { ids = collectRowMessageIds(row); } catch (e) { ids = []; }
            if (ids.some(function (x) { return scope.idSet.has(stripThreadPrefix(x)); })) return true;
        }
        return rowMatchesScopeByTopic(row, scope);
    }

    // scope — приметы письма, с которого сняли метку (null: весь экран, как раньше).
    // stats — счётчики для разбора, если убрать так ничего и не удалось.
    function hideLabelChipsOnScreen(names, scope, stats) {
        const want = new Set((names || []).map(function (n) { return normLabelName(n); })
                                          .filter(Boolean));
        const hidden = [];
        if (!want.size) return hidden;
        const combined = DRAG_LABEL_SELECTORS.join(',');
        // Ищем ВНУТРИ списка писем и открытого письма, а не по всему документу.
        //
        // Селекторы плашек широкие ([class*="Label" i], [class*="Marks" i]) — такие
        // браузер не индексирует, каждый обход честно перебирает узлы. А подметание
        // зовётся до двух раз в секунду. По всему документу это заодно вытаскивало
        // боковое меню со всеми папками и метками ящика — и их же потом отсеивал
        // LABEL_CHIP_SKIP_PARENTS, то есть работа делалась дважды и впустую.
        const roots = [];
        try {
            document.querySelectorAll(
                '.MessagesList, .mail-FolderView, [class*="MessagesList"], ' +
                '[class*="MessageHead"], [class*="Message__root"], .mail-Message'
            ).forEach(function (r) { roots.push(r); });
        } catch (e) { /* ниже — запасной путь по всему документу */ }
        // Ни списка, ни открытого письма не нашли (другая раскладка почты) — работаем
        // как раньше, по всему документу: лучше медленно, чем никак.
        if (!roots.length) roots.push(document);

        const nodes = [];
        const seenNodes = new Set();
        roots.forEach(function (root) {
            try {
                root.querySelectorAll(combined).forEach(function (el) {
                    if (seenNodes.has(el)) return;   // вложенные корни дают повторы
                    seenNodes.add(el);
                    nodes.push(el);
                });
            } catch (e) { /* ignore */ }
        });

        nodes.forEach(function (el) {
            try {
                // Сначала дешёвые проверки — текст плашки, — и только потом дорогие
                // обходы разметки (querySelector по тем же широким селекторам и
                // closest). Раньше порядок был обратный, и самый дорогой шаг делался
                // для КАЖДОГО узла, включая те, что отсеивались следующей строкой.
                let text = (el.innerText || el.textContent || '').trim();
                if (!text || text.length > 40) return;
                // У плашки метки внутри есть крестик «снять» — он приклеивается к тексту
                // («⁉️Уручье ✕»), и точное сравнение имени не совпадало. Отрезаем его.
                text = text.replace(/[\s\u00a0]*[✕✖×xX✗]\s*$/, '').trim();
                if (stats) stats.texts.add(text);
                if (!want.has(normLabelName(text))) return;
                if (el.querySelector(combined)) return;           // это контейнер, а не плашка
                if (el.closest(LABEL_CHIP_SKIP_PARENTS)) return;  // боковое меню — не трогаем
                if (stats) stats.byName++;
                // Имя совпало — теперь убеждаемся, что плашка на НАШЕМ письме.
                // У переписки из нескольких писем поиск показывает КАЖДОЕ письмо
                // отдельной строкой, и метка стоит на всех — прячем на всех.
                if (!chipBelongsToScope(el, scope)) return;
                if (stats) stats.byRow++;
                // Уже спрятана нами на прошлом заходе подметания — второй раз в список
                // не кладём: иначе запомнили бы «было: none», и возврат оставил бы
                // плашку скрытой навсегда.
                if (el.style.display === 'none') return;
                hidden.push({ el: el, was: el.style.display });
                el.style.display = 'none';
            } catch (e) { /* ignore */ }
        });
        if (hidden.length) trace('убрал плашку метки с экрана', names.join(', ') + ' — ' + hidden.length + ' шт.');
        return hidden;
    }

    // Закрывает открытое письмо после «Выполнено».
    // Раньше оно закрывалось само — побочным действием кнопки почты «проверить новые
    // письма», которую мы жали после снятия метки. Эту кнопку пришлось убрать (она
    // закрывала письмо и посреди чтения, когда никто не просил), но само закрытие
    // после «Выполнено» удобно и нужно. Поэтому теперь уводим с письма НАМЕРЕННО и
    // только здесь: фоновым обновлениям это по-прежнему запрещено.
    // Адрес поиска, в который панель увела человека. Пусто — поиском не пользовались.
    let lastPanelSearchHash = '';

    function closeOpenLetterAfterDone() {
        let openId = null;
        try { openId = getOpenMessageId(); } catch (e) { /* ignore */ }
        if (!openId) return false;
        // Человек пришёл к письму из поиска — возвращаем его ровно туда. Раньше здесь
        // срабатывал history.back(), и это была стрельба наугад: в истории могло
        // лежать то же самое письмо, и оно открывалось снова. Плюс дальше идёт
        // перезапрос выдачи, который добавляет свои переходы, — вместе это и давало
        // «письмо закрылось, потом открылось, потом закрылось», всё мигало.
        if (lastPanelSearchHash) {
            trace('закрываю письмо после «Выполнено»', 'возврат в результаты поиска');
            setMailHash(lastPanelSearchHash);
            return true;
        }
        let link = null;
        try { link = document.querySelector(ACTIVE_FOLDER_SELECTOR); } catch (e) { /* ignore */ }
        if (link) {
            trace('закрываю письмо после «Выполнено»', describeEl(link));
            try { link.click(); return true; } catch (e) { /* ниже — назад по истории */ }
        }
        trace('закрываю письмо после «Выполнено»', 'возврат по истории');
        try { history.back(); return true; } catch (e) { return false; }
    }

    // Прячет плашку метки не один раз, а несколько секунд подряд.
    //
    // Одного раза мало: сразу после «Выполнено» письмо закрывается, почта заново
    // рисует список из своего кэша — и метка появляется снова, уже на строке списка.
    // Поэтому подметаем экран, пока почта не догонит. Возвращаемый массив
    // пополняется по ходу, так что вернуть плашки можно в любой момент —
    // восстановится всё, что успели спрятать.
    //
    // Мести долго по ВСЕМУ экрану нельзя: у соседних строк та же метка стоит по делу.
    // Поэтому подметание опознаёт нашу строку (по id, а у чужой строки — по теме,
    // дате и началу текста) и работает только внутри неё.
    //
    // ДВА ОГРАНИЧЕНИЯ, без которых это съедало страницу.
    //
    // 1. Подметание ОДНО на всю панель. Раньше каждое «Выполнено» заводило свой
    //    независимый цикл, и ничто не останавливало предыдущий. Смена на тридцать
    //    писем — тридцать параллельных циклов, каждый раз в полторы секунды
    //    обходящий весь документ селекторами вида [class*="Label" i], которые браузер
    //    ускорять не умеет. Новое «Выполнено» теперь гасит прежнее: плашку прошлого
    //    письма почта к этому моменту и так уже перерисовала.
    //
    // 2. Потолок — полторы минуты, а не пятнадцать. Прежние 900 000 мс сходились с
    //    условием «пока человек на том же списке, продлеваем» так: пока открыто
    //    письмо, curList пуст, значит «тот же список», значит продлеваем, — и цикл
    //    крутился всё время чтения письма. Полутора минут хватает с запасом:
    //    обновление почты после «Выполнено» идёт сразу и больше не откладывается
    //    (см. requestMailRefresh), а если за это время список не перерисовался, то он
    //    и не перерисуется — перерисуется при следующем переходе, уже без метки.
    const SWEEP_SCOPED_MS = 90000;    // строка опознана — полторы минуты
    const SWEEP_BLIND_MS = 6000;      // примет строки нет — как раньше, недолго
    // Пока человек стоит на ТОМ ЖЕ списке, почта его не перезапрашивает и держит
    // плашку в своём кэше — значит держим её спрятанной. Ушёл на другой список —
    // почта запросит его заново, уже без метки: домётываем несколько секунд и всё.
    const SWEEP_MAX_MS = 90000;

    // Текущее подметание. Одно на всю панель — см. пункт 1 выше.
    let activeSweep = null;

    function stopActiveSweep(why) {
        if (!activeSweep) return;
        const prev = activeSweep;
        activeSweep = null;
        prev.stopped = true;
        if (prev.timer) { try { clearTimeout(prev.timer); } catch (e) { /* ignore */ } }
        trace('прежнее подметание остановлено', why || '');
    }

    // Адрес СПИСКА, а не открытого письма.
    //
    // Подметание запускается в момент нажатия «Выполнено», когда письмо ещё ОТКРЫТО,
    // — и адрес тогда #/message/…. Через секунду письмо закрывается, адрес становится
    // адресом списка, и прежняя проверка «адрес тот же» решала, что человек ушёл, и
    // сворачивала подметание через несколько секунд. То есть оно успевало посмотреть
    // только на разметку открытого письма (единственная «плашка» там — кнопка
    // «Метка» на панели инструментов) и заканчивалось до того, как отрисуется список.
    //
    // Поэтому открытое письмо адресом списка не считаем: пока оно открыто, ждём.
    // Заодно приводим адрес к общему виду — почта переписывает %20 в +, и сравнение
    // «та же строка» ломалось на ровном месте.
    function currentListHash() {
        const h = String(location.hash || '');
        if (/#\/?(message|thread)\//.test(h)) return '';   // открыто письмо — списка не видно
        try { return decodeURIComponent(h.replace(/\+/g, ' ')); } catch (e) { return h; }
    }

    function hideLabelChipsFor(names, ms, scope) {
        // Новое «Выполнено» гасит прежнее подметание: плашку прошлого письма почта к
        // этому моменту уже перерисовала, а два цикла разом — это два полных обхода
        // разметки в секунду вместо одного (см. комментарий к SWEEP_SCOPED_MS).
        stopActiveSweep('начато новое подметание');

        const hidden = [];
        const started = Date.now();
        // Пусто — подметание начали на открытом письме; список опознаем, как только
        // он появится.
        let listAnchor = currentListHash();
        const base = ms || SWEEP_BLIND_MS;
        let until = started + (scope ? Math.max(base, SWEEP_SCOPED_MS) : base);
        if (scope) {
            scope.idSet = new Set((scope.ids || [])
                .map(function (x) { return stripThreadPrefix(String(x || '').trim()); })
                .filter(Boolean));
        }
        // Счётчики для разбора: сколько плашек вообще видели, у скольких совпало имя,
        // у скольких — ещё и строка письма. По ним сразу видно, на чём рвётся.
        const stats = { texts: new Set(), byName: 0, byRow: 0, hid: 0, maxRows: 0 };

        const self = { stopped: false, timer: null };
        activeSweep = self;

        (function sweep() {
            if (self.stopped) return;
            self.timer = null;
            // Сколько строк письма вообще отрисовано. Ноль всё время — значит списка
            // мы так и не увидели, и разбирать было нечего: это первое, что надо знать.
            try {
                const n = document.querySelectorAll(DRAG_ROW_SELECTOR).length;
                if (n > stats.maxRows) stats.maxRows = n;
            } catch (e) { /* ignore */ }
            hideLabelChipsOnScreen(names, scope, stats).forEach(function (h) {
                hidden.push(h);
                stats.hid++;
            });
            const now = Date.now();
            const curList = currentListHash();
            if (!listAnchor && curList) listAnchor = curList;   // список наконец показался
            // Открыто письмо (curList пусто) — ждём, список ещё вернётся.
            const sameList = !curList || !listAnchor || curList === listAnchor;
            if (scope && sameList) {
                // Тот же список — почта плашку сама не уберёт, метём дальше.
                until = Math.min(started + SWEEP_MAX_MS, now + 2000);
            } else if (until > now + base) {
                // Человек ушёл на другой список — он запросится заново, метки там нет.
                until = now + base;
            }
            if (now < until && now - started < SWEEP_MAX_MS) {
                // Первые секунды — часто (список как раз перерисовывается), дальше
                // реже: частый обход разметки почте ни к чему.
                self.timer = setTimeout(sweep, (now - started < 10000) ? 400 : 1500);
                return;
            }
            if (activeSweep === self) activeSweep = null;   // отработали — освобождаем место
            if (stats.hid) return;   // всё убрали — молчим
            // Человек ушёл с того списка, где было наше письмо (чаще всего — открыл
            // из панели следующее). Прятать там нечего и никто ничего не «не увидел»:
            // тот список он уже не смотрит, а вернётся к нему — почта запросит его
            // заново, уже без метки. Кричать «убрать не удалось» здесь — ложная
            // тревога, а её потом разбирают как настоящую поломку.
            if (!sameList) {
                try {
                    dlog('Плашку не прятал: ушли с того списка, где было письмо' +
                         (scope ? ' («' + String(scope.topic || '—').slice(0, 60) + '»)' : ''));
                } catch (e) { /* ignore */ }
                return;
            }
            // Ничего не убрали. Молчать здесь нельзя: именно этот случай человек и
            // видит как «метка не снялась». Печатаем ровно то, на чём разбор встал.
            try {
                const seen = Array.from(stats.texts);
                console.warn('[Проблемные письма] Плашку метки убрать не удалось.\n' +
                    '    снимали: «' + (names || []).join('», «') + '»\n' +
                    '    строк письма на экране видели: ' + stats.maxRows + '\n' +
                    '    плашек на экране видели: ' + seen.length +
                        (seen.length ? ' («' + seen.slice(0, 12).join('», «') + '»)' : '') + '\n' +
                    '    из них совпало имя: ' + stats.byName + '\n' +
                    '    из них на нужном письме: ' + stats.byRow + '\n' +
                    '    приметы письма: ' + (scope
                        ? ('тема «' + String(scope.topic || '—').slice(0, 60) + '», id ' +
                           (scope.idSet ? scope.idSet.size : 0) + ' шт., дата ' +
                           ((scope.hints && scope.hints.ts)
                                ? new Date(scope.hints.ts).toLocaleString('ru-RU') : '—'))
                        : 'нет (мели по всему экрану)'));
            } catch (e) { /* диагностика не должна ничего ломать */ }
        })();
        return hidden;
    }

    // Приметы строки письма для подметания. id кладём только СВОИ: у каждого ящика
    // они свои, и id из колонки, заполненной сменщицей, в нашей почте не значат
    // ничего. Опознать строку они не мешают — просто не сработают, и дело сделают
    // тема, дата письма и начало текста.
    function labelScopeForRow(r, openMid) {
        const cached = MEMORY_CACHE.results.get(String(r.sheetRow)) || null;
        const ids = [];
        if (openMid) ids.push(String(openMid));
        if (cached) threadIdsOf(cached).forEach(function (x) { ids.push(String(x)); });
        const stored = parseStoredIds(r.mailId);
        if (!storedIdsAreForeign(stored)) stored.all.forEach(function (x) { ids.push(String(x)); });
        const hints = navMatchOpts(Object.assign({}, cached || {}, {
            preview: r.preview || '',
            rowTs: r.dateAdded ? (Date.parse(r.dateAdded) || 0) : 0
        }));
        return {
            topic: r.topic,
            mid: openMid || (cached && (cached.shownMid || cached.mid)) || null,
            ids: ids,
            hints: hints
        };
    }

    // Снять метку не удалось — возвращаем плашку на место, чтобы экран не врал.
    function restoreLabelChips(hidden) {
        (hidden || []).forEach(function (it) {
            try { it.el.style.display = it.was || ''; } catch (e) { /* ignore */ }
        });
        if (hidden && hidden.length) trace('вернул плашку метки — снять не удалось');
    }

    function ensureLabelVisible(topic, ids, name) {
        setTimeout(function () {
            try {
                const row = findMessageInList(topic, (ids && ids[0]) || null, ids);
                const want = normLabelName(name);
                const has = row && collectRowLabelTexts(row, topic).some(function (t) {
                    return normLabelName(t) === want;
                });
                if (has) return;
                // Уровень 'list' сам решит, можно ли сейчас кликать по папке: на
                // занятом экране он обойдётся кнопкой почты и никуда не уведёт.
                forceMailListRefresh('метка ещё не видна на строке');
            } catch (e) { /* не критично */ }
        }, 2200);
    }

    // То же, но без повторного поиска письма: переиспользует уже полученный info
    // (после добавления перетаскиванием мы уже искали письмо ради даты/меток).
    // Дозаливка метки на ветку.
    //
    // Метку ставим списком id — теми письмами ветки, которые известны на момент
    // перетаскивания. Этого может не хватить: почта применяет do-label к списку не
    // атомарно, ответ в переписку мог прийти секундой позже, а у свёрнутой ветки
    // часть писем вообще не отрисована. Со стороны это выглядит как «метка встала
    // только на первое письмо».
    //
    // Поэтому после простановки спрашиваем ВСЮ ветку у почты и дописываем метку тем
    // письмам, у которых её нет. Один запрос; если ветку спросить нельзя — молча
    // выходим, хуже не станет.
    // Возвращает, скольким письмам метку дописали.
    // Возвращает { added, ids } — сколько писем дописали и КАКИЕ ИМЕННО.
    //
    // Раньше отсюда возвращалось одно число, и это тихо ломало пометку прочитанным.
    // Прочитанными помечаются письма, известные на момент перетаскивания (ids), а
    // дозаливка находит как раз те, до которых список НЕ дотянулся: у свёрнутой ветки
    // часть писем не отрисована, а ответ мог прийти секундой позже. Метку они
    // получали, а прочитанными не становились — и выглядело это как «письма в ветке
    // перестали прочитываться». Список id нужен зовущему, чтобы дочитать и их.
    async function topUpThreadLabel(tid, labelName) {
        const none = { added: 0, ids: [] };
        if (!tid || !labelName) return none;
        let lid = null;
        try { lid = await resolveLid(labelName, false); } catch (e) { lid = null; }
        if (!lid) return none;
        let msgs = null;
        try { msgs = await findMessagesByTid(tid); } catch (e) { msgs = null; }
        if (!msgs || !msgs.length) return none;
        const missing = [];
        msgs.forEach(function (m) {
            const mid = m.mid ? stripThreadPrefix(m.mid) : '';
            if (!mid) return;
            let lids = [];
            try { lids = collectMsgLabelIds(m); } catch (e) { lids = []; }
            const has = lids.some(function (x) { return String(x) === String(lid); });
            if (!has) missing.push(mid);
        });
        if (!missing.length) return none;
        trace('дописываю метку на письма ветки', labelName + ' — ' + missing.length + ' шт.');
        let res = null;
        try { res = await setThreadLabel(missing, labelName, true); } catch (e) { res = null; }
        return (res && res.ok) ? { added: missing.length, ids: missing } : none;
    }

    async function labelAndReadFromInfo(info, topic, number, dateAdded, labelName, domIds, preview) {
        const cfg = await getLabelConfig().catch(function () { return { enabled: false, names: [] }; });
        const name = String(labelName || '').trim() || cfg.names[0] || '';
        const wantLabel = !!(cfg.enabled && name);
        if (!wantLabel) {
            try {
                console.warn('[Проблемные письма] Метка при перетаскивании не ставится. Причина:',
                    !cfg.enabled ? 'авто-метка выключена в настройках (labelEnabled=false)'
                                 : 'не удалось определить имя метки (labelNames пуст)',
                    '| cfg:', cfg);
            } catch (e) {}
        }
        try {
            // Порядок источников id: id, снятые прямо со строк списка (domIds),
            // приоритетнее — при перетаскивании ветки это уже id ВСЕХ её видимых писем
            // (см. collectThreadMessageIds), а не одного. API-поиск по теме/номеру —
            // это просто текстовый поиск, а не группировка по переписке: он находит
            // только те письма, что сами подходят под запрос, так что для целой ветки
            // не подходит — используем его лишь если со страницы ничего снять не
            // удалось (например, письмо уже пропало из списка к моменту обработки).
            // Метку вешаем на ВСЮ переписку: id из поиска (там вся ветка, а не только
            // те письма, что видны в списке) плюс id, снятые со страницы. Раньше при
            // свёрнутой ветке метку получало одно письмо — то, которое перетащили.
            let idsFromInfo = await fullThreadIds(info);
            const idsFromDom = (Array.isArray(domIds) ? domIds : []).map(String);

            // Результат поиска по теме принимаем, ТОЛЬКО если он про ту же переписку,
            // что и перетащенное письмо. Раньше два списка просто складывались, и когда
            // поиск по теме попадал в соседнюю переписку («Перемещение Королёв Стан
            // -Борисов» против «— Могилев»), метка уходила ЕЩЁ И на неё. В почте она
            // оказывалась на чужом письме, а в таблице сохранялся чужой id — дальше
            // ломалось всё, что на него опирается: карточка показывала не то письмо,
            // «Ветка не найдена», повторное добавление считалось дублем.
            if (idsFromDom.length && idsFromInfo.length) {
                const domSet = new Set(idsFromDom.map(function (x) { return stripThreadPrefix(x); }));
                const sameThread = idsFromInfo.some(function (x) { return domSet.has(stripThreadPrefix(x)); });
                if (!sameThread) {
                    try {
                        console.warn('[Проблемные письма] Поиск по теме «' + topic + '» нашёл ДРУГУЮ ' +
                            'переписку, чем перетащенное письмо. Метку ставлю только на перетащенное. ' +
                            'Со страницы: ' + idsFromDom.join(', ') + ' | из поиска: ' + idsFromInfo.join(', '));
                    } catch (e) { /* ignore */ }
                    trace('поиск нашёл другую переписку — беру только перетащенное письмо', topic);
                    idsFromInfo = [];
                }
            }

            const idsSeen = new Set();
            let ids = idsFromInfo.concat(idsFromDom).filter(function (x) {
                const k = String(x);
                if (!k || idsSeen.has(k)) return false;
                idsSeen.add(k);
                return true;
            });
            if (!ids.length) {
                const i2 = await apiGetInfo(topic, number, dateAdded || null, null, preview).catch(function () { return null; });
                ids = await fullThreadIds(i2);
            }
            if (!ids.length) {
                // Раньше здесь был молчаливый выход — из-за него «метка не появилась,
                // письмо не прочиталось» выглядело как будто ничего и не запускалось.
                showToast('Письмо не найдено в почте — метка не поставлена и письмо не прочитано' + authHint(), 'error');
                return;
            }
            let labelRes = null;
            if (wantLabel) {
                labelRes = await setThreadLabel(ids, name, true).catch(function (e) {
                    return { ok: false, error: (e && e.message) || 'ошибка' };
                });
                if (!labelRes.ok) {
                    const has = await verifyThreadLabel(topic, number, dateAdded, name, null, preview);
                    if (has === true) labelRes = { ok: true, error: '' };
                }
            }
            const readRes = await markThreadRead(ids).catch(function () { return { ok: false }; });
            // Не nudgeYandexRefresh: его сторож в результатах поиска откладывает
            // нажатие «на потом», и поставленная метка на экране не появляется —
            // ровно та же дыра, что была со снятием.
            syncMailQuietly('поставлена метка при добавлении');
            if (wantLabel && labelRes && labelRes.ok) {
                // Ветку помечаем целиком: спрашиваем её у почты и дописываем метку
                // письмам, до которых список id не дотянулся (свёрнутая ветка, ответ
                // пришёл секундой позже). Иначе метка стоит «только на первом письме».
                let added = 0;
                const tid = (info && info.tid) ||
                    (ids.find(function (x) { return /^t/.test(String(x)); }) || '');
                let topUp = { added: 0, ids: [] };
                try { topUp = await topUpThreadLabel(tid, name); } catch (e) { topUp = { added: 0, ids: [] }; }
                added = topUp.added;
                // Дочитываем и те письма, до которых список при перетаскивании не
                // дотянулся: метку они только что получили, а прочитанными их никто не
                // помечал — markThreadRead выше знал лишь про ids.
                if (topUp.ids.length) {
                    try { await markThreadRead(topUp.ids); } catch (e) { /* не критично */ }
                }
                // Дозаливка идёт ПОСЛЕ синхронизации выше — значит помеченные ею
                // письма почта на экране ещё не показывает. Синхронизируем ещё раз,
                // иначе выходит ровно то, на что жалуются: в журнале «дописываю метку
                // на письма ветки — 3 шт.», а на строках ветки плашки нет.
                if (added) syncMailQuietly('дописана метка на письма ветки');
                // Молчать на успехе нельзя: плашку почта дорисовывает не сразу, и
                // «метка не проставилась» выглядит одинаково и когда её правда нет,
                // и когда она есть, но список ещё старый.
                showToast('Метка «' + name + '» поставлена' +
                    (added ? (' (на всю ветку, дописано писем: ' + added + ')') : ''), 'success');
                ensureLabelVisible(topic, ids, name);
            }

            if (wantLabel && labelRes && !labelRes.ok) {
                showToast(labelRes.error === 'label-not-found'
                    ? ('Метка «' + name + '» не найдена в почте — проверьте название в настройках')
                    : ('Метка «' + name + '» не применилась: ' + labelRes.error), 'error');
            }
            // Про пометку прочитанным не сообщаем: письмо могло быть прочитано и
            // раньше, а красный тост об этом — просто шум. Остаётся в консоли.
            if (!readRes.ok) {
                dlog('[Проблемные письма] Пометить прочитанным не удалось:', topic);
            }
        } catch (e) {
            showToast('Метка/прочтение — ошибка: ' + friendlyErrorMessage(e), 'error');
        }
    }

    // Массовая простановка/снятие метки. Невыполненным письмам таблицы ставим метку,
    // а выполненным — снимаем (чтобы «хвосты» меток не оставались на закрытых письмах).
    // Читаем ВСЕ строки (pm-list-all), включая выполненные, — обычный список панели их
    // отфильтровывает. Тегируется по теме/номеру.
    // Ищет в почте письма, на которых сейчас висит метка lid. Точную форму запроса
    // модели messages в разных сборках почты пишут по-разному, поэтому пробуем
    // несколько вариантов и берём первый, где КАЖДОЕ вернувшееся письмо действительно
    // несёт эту метку — иначе это не выборка по метке, а обычный список папки, и
    // снимать по нему метки нельзя. Не получилось — возвращаем null, зовущий пропустит
    // этот шаг.
    let LABEL_QUERY_SHAPE = null;   // форма запроса, которая работает в этой почте (params)
    let LABEL_FILTER_WORKS = null;  // уважает ли почта фильтр по метке (проба, раз за сессию)
    let LABEL_LOOKUP_WORKS = null;  // даёт ли эта сборка выборку писем по метке вообще
    let LABEL_LOOKUP_FAILS = 0;

    // Форма запроса помнится между плашками, а id метки у каждой свой — поэтому
    // запоминаем её ШАБЛОНОМ: на месте идентификатора стоит заполнитель, который
    // подставляется перед каждым запросом. Иначе вторая плашка спросила бы письма
    // первой и получила бы чужой ответ.
    const LID_SLOT = '{LID}';

    function toLidTemplate(params, lidStr) {
        const out = {};
        Object.keys(params || {}).forEach(function (k) {
            const v = params[k];
            if (typeof v === 'string' && v === lidStr) out[k] = LID_SLOT;
            else if (Array.isArray(v)) out[k] = v.map(function (x) { return String(x) === lidStr ? LID_SLOT : x; });
            else out[k] = v;
        });
        return out;
    }

    function fromLidTemplate(tpl, lidStr) {
        const out = {};
        Object.keys(tpl || {}).forEach(function (k) {
            const v = tpl[k];
            if (v === LID_SLOT) out[k] = lidStr;
            else if (Array.isArray(v)) out[k] = v.map(function (x) { return x === LID_SLOT ? lidStr : x; });
            else out[k] = v;
        });
        return out;
    }

    // Проба: спрашиваем тем же запросом заведомо несуществующую метку. Заполнитель
    // подставляем в ТО ЖЕ поле, где стоит настоящий id, — иначе, если фильтр зовётся
    // не lid, настоящая метка осталась бы в запросе и проба соврала бы.
    async function labelFilterWorks(shapeTpl) {
        if (LABEL_FILTER_WORKS != null) return LABEL_FILTER_WORKS;
        const fake = '999999999999';
        const params = fromLidTemplate(shapeTpl, fake);
        params.count = 5;
        try {
            const data = await apiRequest([{ name: 'messages', params: params, meta: { requestAttempt: 1 } }], 'messages');
            const model = data && data.models && data.models[0];
            const list = model && model.data && model.data.message;
            // Ответа с внятным списком не получили — судить не о чем, не рискуем.
            if (!Array.isArray(list)) { LABEL_FILTER_WORKS = false; return false; }
            LABEL_FILTER_WORKS = list.length === 0;
        } catch (e) {
            LABEL_FILTER_WORKS = false;
        }
        return LABEL_FILTER_WORKS;
    }
    // Метка висит на ВЕТКАХ целиком, а не на отдельных письмах: у 86 строк таблицы
    // легко набирается 400–500 помеченных писем. Один запрос отдаёт максимум `count`,
    // и на первой же странице выборка обрывалась — строки, чьи письма не попали в неё,
    // считались непомеченными и разбирались заново, а проверка «легла ли метка» по той
    // же обрезанной выборке рапортовала «не применилось» на письма, которые на самом
    // деле помечены. Дочитываем страницы, пока почта их отдаёт.
    const LABEL_PAGE = 200;
    const LABEL_MAX_PAGES = 12;   // до 2400 писем — дальше это уже не рабочая плашка

    async function withRemainingPages(tpl, lidStr, firstParams, firstPage) {
        const all = firstPage.slice();
        if (firstPage.length < LABEL_PAGE) return all;
        for (let page = 1; page < LABEL_MAX_PAGES; page++) {
            const params = Object.assign({}, firstParams);
            params.count = LABEL_PAGE;
            params.first = page * LABEL_PAGE;
            let msgs;
            try {
                const data = await apiRequest([{ name: 'messages', params: params, meta: { requestAttempt: 1 } }], 'messages');
                const model = data && data.models && data.models[0];
                msgs = (model && model.data && model.data.message) || [];
            } catch (e) {
                break;   // недочитали — работаем с тем, что есть, это не хуже прежнего
            }
            if (!msgs.length) break;
            all.push.apply(all, msgs);
            if (msgs.length < LABEL_PAGE) break;
        }
        return all;
    }

    async function findMessagesWithLabel(lid) {
        const lidStr = String(lid);
        // Как в этой сборке спросить «покажи письма с меткой», заранее неизвестно:
        // модель `messages` по `tid` отвечает, а по `lid` — молчит (возвращает ответ
        // вообще без данных). Перебираем известные написания фильтра по метке.
        const shapes = [
            { lid: [lidStr], mailboxUid: 'null', count: LABEL_PAGE, first: 0 },
            { lid: lidStr, mailboxUid: 'null', count: LABEL_PAGE, first: 0 },
            { lid: [lidStr], current_folder: null, mailboxUid: null, count: LABEL_PAGE, first: 0 },
            { lid: [lidStr], count: LABEL_PAGE, first: 0 },
            { current_label: lidStr, mailboxUid: 'null', count: LABEL_PAGE, first: 0 },
            { label: lidStr, mailboxUid: 'null', count: LABEL_PAGE, first: 0 },
            { labels: [lidStr], mailboxUid: 'null', count: LABEL_PAGE, first: 0 },
            { lids: [lidStr], mailboxUid: 'null', count: LABEL_PAGE, first: 0 }
        ];
        // Ни одна форма не подошла дважды подряд — эта сборка выборку по метке не
        // даёт. Перестаём пробовать: восемь заведомо пустых запросов на каждую плашку
        // при каждом прогоне стоят дороже, чем польза от ещё одной попытки. Тот же
        // приём, что для поиска по папкам (fid) и выборки по tid.
        if (LABEL_LOOKUP_WORKS === false) return null;

        // Форма, подсмотренная у самой почты, идёт ПЕРВОЙ: она заведомо правильная для
        // этой сборки, если вид метки открыт хоть раз. Перебор ниже — на случай, когда
        // подсмотреть нечего (пользователь ни разу не заходил в метку).
        const spied = shapeFromMailParams(await mailMessagesParams(), lidStr);
        if (spied) {
            shapes.unshift(spied);   // в order попадёт шаблоном, как и остальные
            try {
                console.log('[Проблемные письма] Форма запроса «письма с меткой» взята ' +
                    'у самой почты: ' + JSON.stringify(spied));
            } catch (e) { /* ignore */ }
        }
        // Пустой ответ — это ТОЖЕ ответ: «писем с такой меткой нет». Раньше он не
        // отличался от «форма запроса не подошла»: функция возвращала null, и
        // вызывающий считал, что спросить не удалось. Из-за этого не включался отсев
        // строк, которым метка заведомо не нужна.
        let sawEmpty = false;
        // Первая форма, ответившая пустым списком. Пригодится, если пусто ответят ВСЕ:
        // тогда это и есть рабочая форма, а метки просто ни на одном письме нет.
        let emptyShape = null;
        // Разбор попыток: если ни одна форма не подошла, прогон разбирает всю таблицу
        // подряд — и надо сразу видеть, на чём именно сорвалось, а не гадать.
        const attempts = [];
        // Форму запроса, которая сработала, запоминаем на сессию: перебирать три
        // варианта на каждый вызов — это втрое больше запросов на пустом месте.
        // Сработавшую форму помним ЦЕЛИКОМ, а не её номером в списке: список
        // непостоянен — подсмотренная у почты форма встаёт в его начало и сдвигает
        // все номера, после чего запомненный номер указывал бы на чужую форму.
        const seen = new Set();
        const order = [];
        function addShape(s) {
            if (!s) return;
            let key;
            try { key = JSON.stringify(s); } catch (e) { return; }
            if (seen.has(key)) return;
            seen.add(key);
            order.push(s);
        }
        addShape(LABEL_QUERY_SHAPE);
        shapes.forEach(function (s) { addShape(toLidTemplate(s, lidStr)); });

        for (let si = 0; si < order.length; si++) {
            const tpl = order[si];
            const params = fromLidTemplate(tpl, lidStr);
            let data;
            try { data = await apiRequest([{ name: 'messages', params: params, meta: { requestAttempt: 1 } }], 'messages'); }
            catch (e) {
                attempts.push({ 'форма': si, 'итог': 'запрос не прошёл', 'ошибка': (e && e.message) || String(e) });
                continue;
            }
            const model = data && data.models && data.models[0];
            const msgs = (model && model.data && model.data.message) || [];
            if (!msgs.length) {
                if (model && model.data && Array.isArray(model.data.message)) {
                    // Пустой ответ — ещё НЕ доказательство, что метки нет ни на одном
                    // письме. Ровно так же выглядит форма запроса, которая в этой
                    // сборке просто ничему не соответствует.
                    //
                    // Раньше здесь стоял break: первая же форма, ответившая пустым
                    // списком, принималась за истину и запоминалась на всю сессию. А
                    // цена ошибки высокая — при пустой выборке прогон не разбирает
                    // выполненные строки (их отсев опирается как раз на эту выборку) и
                    // не видит «хвостов», то есть НЕ МОЖЕТ СНЯТЬ МЕТКУ НИ С ЧЕГО и при
                    // этом бодро рапортует «разбирать нечего». Выглядит это как «метку
                    // в почте не сняли, хотя строку закрыли».
                    //
                    // Поэтому пустой ответ запоминаем и пробуем остальные формы. Если
                    // хоть одна вернёт письма — верим ей. Если все ответят пусто —
                    // значит метки правда нет, и вот тогда это истина.
                    sawEmpty = true;
                    if (emptyShape == null) emptyShape = tpl;
                    attempts.push({ 'форма': si, 'параметры': params,
                                    'итог': 'ответ пуст — пробую остальные формы' });
                    continue;
                }
                attempts.push({
                    'форма': si,
                    'параметры': params,
                    'итог': 'в ответе нет списка писем',
                    'ключи модели': model && model.data ? Object.keys(model.data) : null,
                    // Что почта вернула на самом деле. Без этого видно только «данных
                    // нет», а нужно знать, ЧТО вместо них: ошибка модели, другое имя
                    // модели или пустой конверт. Печатаем только у первой попытки и
                    // с обрезкой — тем письмам оно всё равно не принадлежит.
                    'сырой ответ': attempts.length === 0
                        ? (function () {
                            try { return JSON.stringify(data).slice(0, 900); }
                            catch (e) { return 'не сериализуется'; }
                        })()
                        : undefined
                });
                continue;
            }
            const withLabel = msgs.filter(function (m) {
                return collectMsgLabelIds(m).some(function (id) { return String(id) === lidStr; });
            }).length;
            if (withLabel === msgs.length) {
                LABEL_QUERY_SHAPE = tpl; LABEL_LOOKUP_WORKS = true; LABEL_LOOKUP_FAILS = 0;
                return await withRemainingPages(tpl, lidStr, params, msgs);
            }

            // Метки на письмах прочитать не удалось ВООБЩЕ (не «часть писем чужие», а
            // «поле меток в этой сборке в незнакомом виде»). Отвергать ответ из-за
            // этого — значит гонять всю таблицу каждый прогон. Но и принимать вслепую
            // нельзя: если фильтр lid не сработал, почта вернула весь ящик, и мы сочли
            // бы помеченными все письма подряд — метки не проставились бы никогда.
            //
            // Проверяем сам фильтр отдельной пробой: тем же запросом спрашиваем заведомо
            // несуществующую метку. Пусто в ответ — фильтр почта уважает, значит и в
            // основном ответе лежит именно множество этой метки, читается поле меток
            // или нет. Проба стоит один запрос на сессию, её итог запоминается.
            if (withLabel === 0) {
                const filtersWork = await labelFilterWorks(tpl);
                if (filtersWork) {
                    LABEL_QUERY_SHAPE = tpl; LABEL_LOOKUP_WORKS = true; LABEL_LOOKUP_FAILS = 0;
                    try {
                        console.warn('[Проблемные письма] Метки на письмах в этой сборке не читаются, ' +
                            'но фильтр по метке почта уважает (проверено пробой) — выборку принимаем. ' +
                            'Поля письма: ' + JSON.stringify(Object.keys(msgs[0] || {})));
                    } catch (e) { /* ignore */ }
                    return await withRemainingPages(tpl, lidStr, params, msgs);
                }
            }
            // Не подтвердилось. Принять такой ответ нельзя: если фильтр lid не сработал,
            // почта вернула весь ящик, и мы сочли бы помеченными ВСЕ письма — метки
            // после этого не проставились бы вообще. Поэтому только запоминаем, почему.
            const first = msgs[0] || {};
            attempts.push({
                'форма': si,
                'итог': 'метка не подтвердилась на письмах',
                'писем в ответе': msgs.length,
                'из них с нужной меткой': withLabel,
                'ищем lid': lidStr,
                'поля письма': Object.keys(first),
                'что удалось разобрать как метки': collectMsgLabelIds(first),
                'сырые поля меток': {
                    labels: first.labels, label: first.label, lid: first.lid,
                    labelIds: first.labelIds, label_ids: first.label_ids
                }
            });
        }
        // Все формы ответили пусто — значит форма рабочая, а метки просто нет ни на
        // одном письме. Теперь это вывод по итогам перебора, а не по первому ответу.
        if (sawEmpty && LABEL_QUERY_SHAPE == null) LABEL_QUERY_SHAPE = emptyShape;
        if (sawEmpty) LABEL_LOOKUP_WORKS = true;
        else if (LABEL_LOOKUP_WORKS !== true && ++LABEL_LOOKUP_FAILS >= 2) LABEL_LOOKUP_WORKS = false;
        if (!sawEmpty) {
            // Печатаем всегда и ТЕКСТОМ: без этой выборки прогон идёт по всей таблице
            // и длится минуты вместо секунд, а объект консоль сворачивает — при
            // копировании от него остаётся «[{…}, {…}, {…}]» и толку ноль.
            try {
                console.warn('[Проблемные письма] Выборка «кто носит метку» не удалась — ' +
                    'прогон разберёт всю таблицу. Попытки:\n' +
                    JSON.stringify(attempts, null, 2).slice(0, 4000));
            } catch (e) { /* диагностика не должна ломать прогон */ }
        }
        return sawEmpty ? [] : null;
    }

    // Полный список писем ветки по её настоящему id (tid), а не только тех, что нашёл
    // текстовый поиск по теме/номеру. Поиск — обычный полнотекстовый: короткий ответ
    // вроде «примите по скану?» без номера в него просто не попадёт, и метка ляжет
    // только на часть переписки. tid у письма — это НАСТОЯЩАЯ группировка почты, а не
    // текстовое совпадение, так что выборка по нему покрывает всю ветку целиком.
    // Форму запроса пока не подтверждали по Network (см. findMessagesWithLabel выше) —
    // пробуем несколько похожих на неё вариантов и проверяем результат по факту.
    let TID_LOOKUP_WORKS = null;
    let TID_LOOKUP_FAILS = 0;
    let TID_QUERY_SHAPE = null;
    // Форма запроса «дай все письма этой переписки», подсмотренная у самой почты
    // (её она делает, когда человек открывает письмо). Хранится ШАБЛОНОМ: на месте
    // идентификатора ветки — заполнитель.
    let TID_SPIED_SHAPE = null;
    let tidSpyTried = false;

    async function spiedThreadShape() {
        if (TID_SPIED_SHAPE || tidSpyTried) return TID_SPIED_SHAPE;
        tidSpyTried = true;
        try {
            const res = await mailMessagesParamsRaw();
            const p = res && res.threadParams;
            if (!p) return null;
            // Находим поле, в котором лежит id ветки, и заменяем его заполнителем.
            const tpl = {};
            let found = false;
            Object.keys(p).forEach(function (k) {
                if (/^(tid|thread_id|threadId)$/.test(k)) { tpl[k] = LID_SLOT; found = true; }
                else tpl[k] = p[k];
            });
            if (!found) return null;
            tpl.count = 200;
            tpl.first = 0;
            TID_SPIED_SHAPE = tpl;
            try {
                console.log('[Проблемные письма] Форма запроса «письма переписки» взята ' +
                    'у самой почты: ' + JSON.stringify(tpl));
            } catch (e) { /* ignore */ }
        } catch (e) { /* работаем перебором, как раньше */ }
        return TID_SPIED_SHAPE;
    }

    async function findMessagesByTid(tid) {
        if (TID_LOOKUP_WORKS === false) return null;
        const tidStr = stripThreadPrefix(tid);
        // Почта в разных местах отдаёт id ветки то с префиксом t, то без — пробуем оба.
        const shapes = [
            { tid: tidStr, mailboxUid: 'null', count: 200, first: 0 },
            { tid: 't' + tidStr, mailboxUid: 'null', count: 200, first: 0 },
            { tid: [tidStr], mailboxUid: 'null', count: 200, first: 0 },
            { thread_id: tidStr, mailboxUid: 'null', count: 200, first: 0 }
        ];
        // Сработавшую форму запоминаем — иначе каждая ветка стоит четырёх запросов
        // вместо одного.
        const spied = await spiedThreadShape();
        if (spied) shapes.unshift(fromLidTemplate(spied, tidStr));
        const order = TID_QUERY_SHAPE == null
            ? shapes.map(function (_, i) { return i; })
            : [TID_QUERY_SHAPE].concat(shapes.map(function (_, i) { return i; })
                  .filter(function (i) { return i !== TID_QUERY_SHAPE; }));
        for (const si of order) {
            const params = shapes[si];
            let data;
            try { data = await apiRequest([{ name: 'messages', params: params, meta: { requestAttempt: 1 } }], 'messages'); }
            catch (e) { continue; }
            const model = data && data.models && data.models[0];
            const msgs = (model && model.data && model.data.message) || [];
            if (!msgs.length) continue;
            const allSameTid = msgs.every(function (m) { return stripThreadPrefix(m.tid) === tidStr; });
            if (allSameTid) {
                TID_LOOKUP_WORKS = true; TID_LOOKUP_FAILS = 0;
                TID_QUERY_SHAPE = si;
                return msgs;
            }
        }
        // Порог 5, а не 2. Двух неудач подряд слишком мало: достаточно пары строк с
        // устаревшим id (письмо удалили, ветку перенесли) — и рабочий механизм
        // выключался на весь сеанс, унося с собой и точный поиск, и метки на всю ветку.
        if (TID_LOOKUP_WORKS !== true && ++TID_LOOKUP_FAILS >= 5) {
            TID_LOOKUP_WORKS = false;
            // Без этой выборки метка ложится только на письма, которые вернул ПОИСК, —
            // то есть на часть переписки, а новые ответы остаются без метки. Раньше
            // это происходило молча, и выглядело как «метка не доставляется».
            try {
                console.warn('[Проблемные письма] Выборка писем переписки (tid) не работает в этой ' +
                    'сборке — метка ляжет только на письма из результатов поиска, ' +
                    'новые ответы в ветке могут остаться без неё. Откройте любое письмо ' +
                    'в почте: расширение подсмотрит нужную форму запроса у самой почты.');
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    // Данные писем по их точным id (сохранённым в таблице при добавлении) — когда
    // они известны, это надёжнее любого текстового поиска: без него для короткой
    // темы без номера ЗП («Энергия ООО» и т.п.) невозможно понять, какая из
    // нескольких одинаково названных переписок нужна. Форма запроса не подтверждена
    // по Network — пробуем варианты, принимаем только если хоть одно письмо из
    // запрошенных id нашлось в ответе.
    // Выборка писем по id: если эта сборка почты её не поддерживает, после пары
    // неудач перестаём пробовать — иначе каждая строка стоит трёх лишних запросов
    // с таймаутами, и синхронизация меток тянется минутами.
    let MIDS_LOOKUP_WORKS = null;
    let MIDS_TRIED_SPIED = false;   // пробовали ли форму, подсмотренную у почты
    let MIDS_LOOKUP_FAILS = 0;
    async function findMessagesByMids(mids) {
        // Сдались раньше — но с тех пор у почты подсмотрена рабочая форма запроса.
        // Стоит попробовать ещё раз именно ею, а не молчать до перезагрузки вкладки.
        if (MIDS_LOOKUP_WORKS === false && (!TID_SPIED_SHAPE || MIDS_TRIED_SPIED)) return null;
        const list = (Array.isArray(mids) ? mids : String(mids || '').split(','))
            .map(function (s) { return String(s).trim(); }).filter(Boolean);
        if (!list.length) return null;
        const csv = list.join(',');
        const shapes = [
            { mid: list, mailboxUid: 'null' },
            { mid: csv, mailboxUid: 'null' },
            { ids: csv, mailboxUid: 'null' }
        ];
        // Форма запроса «письма переписки», подсмотренная у самой почты, точно ей
        // подходит — от неё и пляшем, подставляя вместо id ветки id писем. Без этого
        // запрос по id собирался наугад: не подошла ни одна из трёх форм — и выборка
        // по id отключалась на весь сеанс, а вместе с ней и точный путь к письму.
        const spied = await spiedThreadShape();
        if (spied) {
            const base = {};
            Object.keys(spied).forEach(function (k) {
                if (!/^(tid|thread_id|threadId)$/.test(k)) base[k] = spied[k];
            });
            shapes.unshift(Object.assign({}, base, { mid: csv }));
            shapes.unshift(Object.assign({}, base, { mid: list }));
            MIDS_TRIED_SPIED = true;
        }
        const wanted = new Set(list);
        for (const params of shapes) {
            let data;
            try { data = await apiRequest([{ name: 'messages', params: params, meta: { requestAttempt: 1 } }], 'messages'); }
            catch (e) { continue; }
            const model = data && data.models && data.models[0];
            const msgs = (model && model.data && model.data.message) || [];
            if (!msgs.length) continue;
            if (msgs.some(function (m) { return wanted.has(String(m.mid)); })) {
                MIDS_LOOKUP_WORKS = true; MIDS_LOOKUP_FAILS = 0;
                return msgs;
            }
        }
        if (MIDS_LOOKUP_WORKS !== true && ++MIDS_LOOKUP_FAILS >= 2) MIDS_LOOKUP_WORKS = false;
        return null;
    }

    // Сохранённый mailId сняли из DOM того, кто перетаскивал письмо, — а у КАЖДОГО
    // пользователя своя отдельная почта Яндекса со своей нумерацией писем. Если
    // строку в таблице завёл коллега, а метку синхронизирует другой человек — id
    // из его строки в ЭТОМ ящике ничего не значит (do-label с чужим/несуществующим
    // id тем не менее отвечает «ок» — реально не делая ничего, отсюда «метка не
    // ставится, а ошибок нет»). Проверяем, что хотя бы одно из сохранённых id
    // реально существует в текущем ящике, прежде чем доверять им вместо поиска.
    async function verifyStoredIdsBelongHere(ids, check) {
        if (!ids || !ids.length) return [];
        // Существование id — ещё НЕ доказательство. id у каждого ящика свои и идут
        // подряд, поэтому чужой id вполне может существовать и здесь, но указывать на
        // совершенно другое письмо. Поэтому найденное сверяем с приметами строки:
        // временем письма (оно одинаково во всех ящиках), темой и началом текста.
        const want = check || {};
        const wTopic = normForMatch(want.topic);
        const wPre = normForMatch(want.preview);
        const hasTopic = wTopic.length >= 4;
        const hasPre = wPre.length >= 8;
        function looksLikeOurs(m) {
            if (want.ts) {
                const t = msgDateMs(m);
                if (t && Math.abs(t - want.ts) > 12 * 3600000) return false;
            }
            if (hasTopic && normForMatch(m.subject).indexOf(wTopic) !== -1) return true;
            if (hasPre && previewMatches(m, wPre)) return true;
            // Сверять нечем (старая строка без темы-приметы) — верим id и времени.
            return !hasTopic && !hasPre;
        }
        function keepOurs(list) {
            const ours = (list || []).filter(looksLikeOurs);
            if (ours.length !== (list || []).length) {
                dlog('🆔 Сохранённые id есть в этом ящике, но указывают на другое письмо — отбрасываем',
                     { было: (list || []).length, осталось: ours.length, приметы: want });
            }
            return ours;
        }
        const plain = ids.filter(function (id) { return String(id).charAt(0) !== 't'; });
        const threads = ids.filter(function (id) { return String(id).charAt(0) === 't'; });
        if (plain.length) {
            const msgs = keepOurs(await findMessagesByMids(plain).catch(function () { return null; }));
            if (msgs && msgs.length) {
                // Возвращаем ТОЛЬКО подтверждённые id. Раньше отдавался весь сохранённый
                // список: при перетаскивании в него попадают все длинные числа из
                // разметки строки, и «лишние» id уходили в do-label — почта на них
                // отвечает «ок», ничего не делая.
                const alive = new Set(msgs.map(function (m) { return String(m.mid); }));
                const confirmed = plain.filter(function (id) { return alive.has(String(id)); });
                if (confirmed.length) return confirmed;
            }
        }
        if (threads.length) {
            const msgs = keepOurs(await findMessagesByTid(String(threads[0]).replace(/^t/, '')).catch(function () { return null; }));
            if (msgs && msgs.length) {
                // Настоящие id писем ветки лучше её собственного id: do-label по id ветки
                // в части сборок почты молча ничего не делает.
                const mids = msgs.map(function (m) { return m.mid; })
                    .filter(function (x) { return x && !/^t/.test(String(x)); });
                if (mids.length) return mids;
                return threads.slice(0, 1);
            }
        }
        return [];
    }

    // id всех писем ветки: сначала пробуем настоящую группировку по tid (полнее),
    // и только если она не сработала (форма запроса не подошла под эту почту) —
    // откатываемся к тому, что уже примешал текстовый поиск (threadIdsFromInfo).
    // Сколько веток пометили по полной выборке, а сколько — только по результатам
    // поиска. Второе означает, что часть переписки метку не получит.
    // noTid    — поиск не вернул id переписки, спросить её письма не у чего;
    // lookupBad — id есть, но выборка писем ветки ничего не дала.
    // Причины разные, и лечатся по-разному, поэтому считаем их отдельно.
    const THREAD_IDS_STAT = { full: 0, noTid: 0, lookupBad: 0 };

    // out — необязательный объект, куда кладём итог по ЭТОЙ ветке: 'full' (список
    // писем полный), 'lookupBad' (id ветки есть, но выборка не удалась) или 'noTid'
    // (поиск не вернул id ветки). Нужен, чтобы отчёт называл проблемные строки
    // поимённо, а не просил искать их вручную.
    async function fullThreadIds(info, out) {
        let ids = threadIdsFromInfo(info);
        let complete = false;
        let hadTid = !!(info && info.tid);
        if (hadTid) {
            try {
                const msgs = await findMessagesByTid(info.tid);
                if (msgs && msgs.length) {
                    const full = msgs.map(function (m) { return m.mid; })
                        .filter(function (x) { return x && !/^t/.test(String(x)); });
                    if (full.length) { ids = full; complete = true; }
                }
            } catch (e) { /* используем то, что уже было в info */ }
        }
        if (ids.length) {
            const state = complete ? 'full' : (hadTid ? 'lookupBad' : 'noTid');
            THREAD_IDS_STAT[state]++;
            if (out) { out.state = state; out.count = ids.length; }
        }
        return ids;
    }

    // Раскладывает выборку «письма с этой меткой» в множества, по которым можно
    // СРАЗУ, без единого запроса, понять: может ли строка таблицы иметь эту метку.
    function indexLabelled(msgs) {
        const ids = new Set();
        const times = [];
        const subjects = [];
        const entries = [];
        (msgs || []).forEach(function (m) {
            const own = [];
            [m.mid, m.tid, m.last_mid].forEach(function (x) {
                if (x == null) return;
                const id = stripThreadPrefix(String(x));
                ids.add(id);
                own.push(id);
            });
            const t = msgDateMs(m);
            if (t) times.push(t);
            const subj = normForMatch(stripRowSubjectTail(msgSubject(m)));
            if (subj) subjects.push(subj);
            // tid — настоящая группировка почты. По нему собирается ВСЯ помеченная
            // часть ветки, а не только письма из 12-часового окна вокруг сохранённого
            // времени: переписка тянется днями, и в окно попадает одно-два письма.
            // ВНИМАНИЕ: поле count в этом ответе — НЕ размер переписки. Ответ отфильтрован
            // по метке, и count считает только письма, попавшие в фильтр, то есть уже
            // помеченные. Я принял его за размер ветки — и проверка «вся ли ветка
            // помечена» стала тавтологией: помечено 15 из 15, пропускаем, а в переписке
            // при этом 20 писем и пять из них без метки. Размер берём только из кэша
            // карточки: он считается по ПОИСКУ, который меткой не ограничен.
            entries.push({ ids: own, ts: t, subj: subj, tid: stripThreadPrefix(m.tid) });
        });
        return { ids: ids, times: times, subjects: subjects, entries: entries };
    }

    // Связывает строку таблицы с письмами из выборки «что сейчас носит эту метку» —
    // БЕЗ единого запроса к почте.
    //
    // Отдаёт наружу:
    //   ids      — письма, которые ТОЧНО относятся к этой строке (по id либо по
    //              связке время+тема, плюс вся помеченная часть их ветки по tid);
    //   maybeIds — «возможно, её»: совпала одна тема. Ставить по ним метку нельзя,
    //              но и снимать как с «хвоста» — тем более;
    //   tids     — ветки строки: по ним прогон спрашивает у почты полный состав
    //              переписки одним запросом вместо поиска и подсчётов;
    //   loose    — есть ли вообще хоть какая-то связь (нужно, чтобы решить, разбирать
    //              ли чужую строку: снимать нечего, если метки там и нет);
    //   why      — почему решение такое (диагностика прогона, см. syncDiag).
    //
    // Раньше отсюда возвращался ещё и флаг strong — «метка уже стоит, строку можно
    // пропустить». Его не читал НИКТО: пропуск давно решается фазой 0, которая
    // спрашивает состав ветки у самой почты по tid, а не выводит его из чисел.
    // Вместе с флагом убраны и два блока, которые его гасили (сверка сохранённых id и
    // сверка размера ветки с кэшем карточки) — вместе с походом в MEMORY_CACHE на
    // каждую строку таблицы.
    function matchLabelledRow(r, idx) {
        const prefer = parseStoredIds(r.mailId);
        const nt = normForMatch(stripRowSubjectTail(r.topic));
        const strongIds = [];   // письма, которые ТОЧНО относятся к этой строке
        const looseIds = [];    // «возможно, её» — только чтобы решить, разбирать ли строку
        let looseByTimeOnly = 0;   // совпало ТОЛЬКО по времени — это не улика (см. ниже)
        let anyIdMatched = false;  // хоть один сохранённый id нашёлся в ЭТОМ ящике
        let matchedEntries = 0;    // сколько писем совпало напрямую (по id или время+тема)
        let labelledInThread = 0;  // сколько писем ВЕТКИ носят метку (по tid)
        const matchedTids = new Set();
        idx.entries.forEach(function (e) {
            const byId = prefer.any && e.ids.some(function (id) { return prefer.all.has(id); });
            const byTime = !!(prefer.ts && e.ts && Math.abs(e.ts - prefer.ts) <= 12 * 3600000);
            const bySubject = !!(nt.length >= 4 && e.subj &&
                (e.subj === nt || e.subj.indexOf(nt) !== -1 || (nt.length >= 8 && nt.indexOf(e.subj) !== -1)));
            if (byId) anyIdMatched = true;
            if (byId || (byTime && bySubject)) {
                matchedEntries++;
                if (e.tid) matchedTids.add(e.tid);
                e.ids.forEach(function (id) { strongIds.push(id); });
            } else if (bySubject) {
                e.ids.forEach(function (id) { looseIds.push(id); });
            } else if (byTime) {
                // Совпадение ОДНОГО ТОЛЬКО времени (±12 часов) опознанием не является:
                // за полсуток в ящик приходят десятки писем, и почти у каждой строки
                // таблицы найдётся помеченное письмо в этом окне. Раньше этого хватало,
                // чтобы отправить строку в полный разбор: у плашки с одной своей
                // строкой разбиралось 74 — почти вся таблица, каждый прогон, впустую.
                looseByTimeOnly++;
            }
        });
        // Совпадение по времени берёт только письма в пределах 12 часов от сохранённого,
        // а переписка тянется днями: у ветки из восьми писем в окно попадает одно.
        // Настоящую группировку даёт tid — собираем по нему ВСЮ помеченную часть ветки.
        // Её письма идут в «известные»: иначе те, что не попали в окно, потом сочлись бы
        // «хвостами» (письмо с меткой, которого нет в таблице) и предлагались бы к снятию.
        if (matchedTids.size) {
            const inThread = [];
            idx.entries.forEach(function (e) {
                if (e.tid && matchedTids.has(e.tid)) inThread.push(e);
            });
            inThread.forEach(function (e) { e.ids.forEach(function (id) { strongIds.push(id); }); });
            labelledInThread = inThread.length;
        }
        // Наружу отдаём ТОЛЬКО точные совпадения: их id идут в «известные», и слабое
        // совпадение (например, письмо той же минуты, но с чужой темой) выдало бы
        // чужое письмо за наше — и оно не попало бы в «хвосты».
        return {
            loose: strongIds.length + looseIds.length > 0,
            ids: strongIds,
            // Слабые совпадения наружу тоже отдаём — но ТОЛЬКО чтобы защитить эти
            // письма от снятия метки как «хвоста». Ставить по ним метку нельзя, а вот
            // снимать по недостатку улик — тем более: лишняя метка не мешает никому,
            // а снятая с чужого письма теряется молча и навсегда.
            maybeIds: looseIds.slice(),
            tids: Array.from(matchedTids),
            // Почему решение именно такое — для диагностики прогона (см. syncDiag).
            why: {
                hasIds: prefer.any,
                hasTs: !!prefer.ts,
                topicLen: nt.length,
                byId: anyIdMatched,
                matched: matchedEntries,
                вПомеченнойВетке: labelledInThread,
                loose: looseIds.length,
                совпалоТолькоПоВремени: looseByTimeOnly
            }
        };
    }

    // name  — какую метку проставлять (кнопка на язычке передаёт свою).
    // btnEl — кнопка, на которой показывать прогресс (в шапке панели или на язычке).
    // Раньше замок был один на всё расширение: пока идёт одна плашка, остальные ждут.
    // Теперь замок на КАЖДУЮ метку — плашки можно обновлять одновременно, и каждая
    // освобождается сама, как только закончила свою работу.
    const labelsInFlight = new Set();
    function isLabelBusy(name) { return labelsInFlight.has(normLabelName(name)); }

    // Колонка «ID письма» выключена в настройках — говорим об этом прямо.
    //
    // В defaults.js она (как и «Текст письма») выключена по умолчанию: под неё надо
    // выделить свободный столбец в таблице. А всё опознание переписки построено
    // именно на ней. Без колонки строка связывается с письмом догадкой по теме, дате
    // и началу текста, и если тем с одинаковым текстом в ящике десяток («Перемещение
    // Заславль - Таборы»), догадка регулярно промахивается: метка уходит на соседнюю
    // переписку, а с настоящего письма снимается как с «хвоста».
    //
    // Раньше расширение в таком режиме молча работало хуже, и понять, почему у одного
    // сотрудника метки держатся, а у другого уезжают, было нельзя — настройки у них
    // разные, а панель об этом не говорила ни слова.
    let missingColumnsWarned = false;
    function warnAboutMissingColumns(columns, quiet) {
        if (!columns || columns.mailId) return;
        if (missingColumnsWarned) return;
        missingColumnsWarned = true;
        const text = 'Колонка «ID письма» выключена в настройках расширения. ' +
            'Без неё письмо строки опознаётся только по теме, дате и началу текста — ' +
            'у одинаковых тем это промахивается, и метка может уйти на соседнюю ' +
            'переписку. Выделите под колонку свободный столбец в таблице и включите ' +
            'её в Настройках.';
        try { console.warn('[Проблемные письма] ' + text); } catch (e) { /* ignore */ }
        if (!quiet) showToast(text, 'error');
    }
    // Разбор прогона в консоль. Печатаем ВСЕГДА, не только в отладке: когда прогон на
    // 87 письмах идёт две минуты вместо секунд, надо сразу видеть, почему пропуск не
    // сработал, а не включать отладку и повторять прогон.
    function printRunDiagnostics(labelName, d) {
        try {
            // Коротко — всегда: по этой строке видно, работает ли экономия.
            console.log('[Проблемные письма] Синхронизация «' + labelName + '»: разбираем ' +
                d.parsed + ' из ' + d.total + ' строк, пропущено ' + d.already +
                ' (метка уже стоит), писем с меткой в почте ' +
                (d.labelledBefore ? d.labelledBefore.length : '— запрос не удался'));

            // Подробности — только когда есть на что смотреть: выборка не удалась или
            // не пропущено ни одной своей строки, хотя выборка пришла. В обычном
            // прогоне двадцать полей в консоли — просто шум.
            const looksWrong = !d.labelledBefore ||
                (d.syncDiag['своих строк'] > 0 && d.already === 0);
            if (!looksWrong && !DEBUG) return;
            // Текстом, а не объектом: объект консоль сворачивает, и при копировании от
            // него остаётся «{…}» вместо самих чисел.
            console.log('[Проблемные письма] Разбор прогона:\n' +
                JSON.stringify(d.syncDiag, null, 2));
            if (d.diagSample) {
                console.log('[Проблемные письма] Пример строки, которую НЕ пропустили:\n' +
                    JSON.stringify(d.diagSample, null, 2).slice(0, 3000));
            }
        } catch (e) { /* диагностика не должна ломать прогон */ }
    }

    // Итог прогона одной плашки — строка для тоста.
    function buildLabelRunReport(t) {
        return 'Метки: поставлено ' + t.put + ', снято ' + t.removed +
            (t.already ? ', уже стояло ' + t.already : '') +
            // Судьбу писем с меткой, которых нет в таблице, называем ВСЕГДА. Раньше
            // при их отсутствии отчёт про них просто молчал, и после прогона
            // оставалось непонятно: их сняли или их не нашли.
            (t.strayOut.length
                ? ', снимаю метку ещё с ' + t.strayOut.length + ' ' +
                  plural(t.strayOut.length, 'письма', 'писем', 'писем') + ' вне таблицы'
                : ', лишних меток нет') +
            (t.unconfirmed ? ', не применилось ' + t.unconfirmed : '') +
            (t.noThread ? ', писем не найдено ' + t.noThread + authHint() : '') +
            (t.fail ? ', ошибок ' + t.fail + (t.firstFail ? ' (' + t.firstFail + ')' : '') : '');
    }

    // Куда отправить строку таблицы в прогоне меток: в быструю сверку ветки (фаза 0),
    // в полный разбор (фаза 1) или никуда.
    //
    // idx        — выборка «что сейчас носит эту метку», разложенная indexLabelled.
    //              null — выборку получить не удалось, разбираем всё подряд.
    // isMine     — строка этой плашки и невыполненная, то есть метку ей ставить.
    // syncDiag   — счётчики разбора прогона (пополняются здесь же).
    // diagSample — уже собранный пример «строки, которую не пропустили»; если он ещё
    //              не собран, функция вернёт первый подходящий.
    function classifyRowForRun(r, idx, isMine, isOwnLabel, syncDiag, diagSample) {
        const res = { keepIds: [], keepTids: [], fastRow: null, parse: false,
                      clearedNotFound: false, diagSample: null };
        // Выборки по метке нет — гадать не о чем, строка идёт в полный разбор.
        if (!idx) { res.parse = true; return res; }

        const m = matchLabelledRow(r, idx);
        // Письмо этой строки нашлось среди помеченных — значит оно в ящике есть.
        // Снимаем прежнюю пометку «не найдено»: иначе красный крестик висел до
        // перезагрузки вкладки, хотя метка на письме стоит и всё в порядке.
        if ((m.ids.length || m.tids.length) && NOT_FOUND_ROWS.has(String(r.sheetRow))) {
            NOT_FOUND_ROWS.delete(String(r.sheetRow));
            res.clearedNotFound = true;
        }

        if (!isMine) {
            // ВЫПОЛНЕННАЯ строка СВОЕЙ метки разбирается всегда. Это ровно тот случай,
            // ради которого прогон и запускают: человек закрыл письмо (а закрыть его
            // могли и прямо в таблице, минуя кнопку «Выполнено» в панели) — метку надо
            // снять. Отсев ниже опирается на выборку «кто носит метку», и если она
            // пришла ПУСТОЙ, он отбрасывал такую строку вместе со всеми: снимать было
            // не с чего, «хвостов» тоже не было, и прогон рапортовал «разбирать
            // нечего», оставив метку висеть. Таких строк единицы — разобрать их дешево,
            // а не разобрать означает не сделать главного.
            if (isOwnLabel) { res.parse = true; return res; }
            // Чужая строка нужна только чтобы СНЯТЬ метку — а снимать нечего, если её
            // там нет. Опознание идёт по id или теме; голого совпадения времени мало
            // (см. matchLabelledRow). И даже если такую строку не разобрать, метка на
            // её письме не останется висеть: письмо, которое не заявила ни одна
            // строка, снимается в конце прогона как «хвост» — одним запросом на всех.
            res.parse = !!m.loose;
            return res;
        }

        syncDiag['своих строк']++;
        if (m.why.hasIds) syncDiag['у них сохранены id']++;
        if (m.why.hasTs) syncDiag['у них сохранено время']++;
        if (m.why.byId) syncDiag['опознано по id']++;
        else if (m.why.matched) syncDiag['опознано по времени+теме']++;
        else if (!diagSample) {
            // Первая НЕ пропущенная своя строка — по ней видно, чего не хватило.
            const stored = parseStoredIds(r.mailId);
            res.diagSample = {
                'строка таблицы': r.sheetRow,
                'тема': r.topic,
                'колонка ID письма': r.mailId || '(пусто)',
                'разобранные id': Array.from(stored.all),
                'разобранное время': stored.ts || 0,
                'чей ящик выдал id': stored.owner || '(не помечено)',
                'наш ящик': MAILBOX_UID || '(неизвестен)',
                'почему': m.why,
                'пример письма с меткой': idx.entries[0] || null
            };
        }

        // Всё, что опознано за этой строкой, — не «хвост». Раньше эти id попадали в
        // keepIds только окольным путём (через запрос ветки по tid), и если ветку
        // спросить не удавалось, письма своей же строки уходили в «хвосты» и метка с
        // них снималась фоном, без спроса.
        res.keepIds = m.ids.concat(m.maybeIds || []);
        res.keepTids = m.tids.slice();

        // Ветку опознали в выборке — знаем её tid. Тогда не гадаем, вся ли она
        // помечена, а СПРАШИВАЕМ её у почты (фаза 0): один запрос вместо поиска и
        // подсчётов. Все попытки вывести полноту из чисел проваливались одинаково — и
        // count из ответа по метке, и число писем из карточки занижены (считают только
        // то, что попало в фильтр или в поиск). В переписке 25 писем, помечено 22, а
        // оба источника говорят «22 из 22»: строка пропускается, и три письма
        // остаются без метки.
        if (m.tids.length) {
            res.fastRow = { row: r, tid: m.tids[0], known: m.ids };
            return res;
        }
        res.parse = true;
        return res;
    }

    // Проверка результата ПО ФАКТУ — одной выборкой на весь прогон.
    //
    // Почта отвечает «ок» и на id, которых у неё нет (например, снятых в чужом ящике),
    // молча ничего не делая: отчёт из-за этого рапортовал «поставлено 6», хотя метку
    // получили два. Проверять надо по факту — но раньше это был отдельный запрос НА
    // КАЖДУЮ ветку. Теперь берём выборку писем с этой меткой один раз: она же нужна
    // потом для «хвостов».
    //
    // applied       — ветки, которым отправили do-label/do-unlabel.
    // labelledAfter — выборка «что носит эту метку» ПОСЛЕ простановки (null — не удалась).
    async function confirmAppliedLabels(applied, labelledAfter, labelName) {
        const idxAfter = labelledAfter ? indexLabelled(labelledAfter) : null;
        const runLog = [];
        let put = 0, removed = 0, fail = 0, unconfirmed = 0;

        for (const t of (applied || [])) {
            const row0 = t.rows[0];
            let has = null;
            if (idxAfter) {
                has = t.ids.some(function (x) { return idxAfter.ids.has(stripThreadPrefix(x)); });
            } else {
                // Выборку по метке получить не удалось — падаем на прежнюю поштучную
                // проверку, чтобы не врать в отчёте.
                has = await verifyLabelOnIds(t.ids, row0, labelName,
                    t.prefer && t.prefer.any ? t.prefer : null);
            }
            const rr = t.rr || { ok: false, error: 'нет ответа' };
            if (has === t.add) {
                if (t.add) put++; else if (t.hasLabelNow || !t.labelsKnown) removed++;
            } else if (has === null) {
                // Проверить не смогли — верим ответу почты, но не радуемся молча.
                if (rr.ok) { if (t.add) put++; else removed++; }
                else fail++;
            } else {
                unconfirmed++;
            }
            runLog.push({
                тема: row0.topic,
                строки: t.rows.map(function (x) { return x.sheetRow; }).join(','),
                idИзТаблицы: t.rows.map(function (x) { return x.mailId || '—'; }).join(' | '),
                действие: t.add ? 'поставить' : 'снять',
                ids: t.ids.join(','),
                ответПочты: rr.ok ? 'ок' : rr.error,
                поФакту: has === null ? 'проверить не удалось' : (has ? 'метка есть' : 'метки нет')
            });
        }
        return { put: put, removed: removed, fail: fail,
                 unconfirmed: unconfirmed, runLog: runLog };
    }

    // Ветки, для которых список писем неполный: почта пометит только те письма, что
    // вернул поиск, а новые ответы останутся без метки. Самая частая причина жалобы
    // «метка не доставилась» — поэтому называем такие ветки поимённо, иначе искать их
    // придётся вручную по всему списку.
    function reportPartialThreads(labelName, partialRows) {
        const partial = THREAD_IDS_STAT.noTid + THREAD_IDS_STAT.lookupBad;
        if (!partial) return;
        try {
            // Совет «откройте письмо» уместен, только пока форма запроса не
            // подсмотрена. Когда она уже есть, а выборка всё равно пуста — причина
            // другая, и звать открывать письмо только сбивает с толку.
            const hint = THREAD_IDS_STAT.lookupBad && !TID_SPIED_SHAPE
                ? ' Откройте любое письмо в почте: расширение подсмотрит у неё нужную форму запроса.'
                : (THREAD_IDS_STAT.noTid
                    ? ' У ' + THREAD_IDS_STAT.noTid + ' из них поиск не вернул id переписки — ' +
                      'спросить её письма не у чего, метку получат только найденные поиском.'
                    : '');
            console.warn('[Проблемные письма] «' + labelName + '»: веток помечено по ПОЛНОЙ ' +
                'выборке писем — ' + THREAD_IDS_STAT.full + ', по неполной — ' + partial +
                ' (без id переписки — ' + THREAD_IDS_STAT.noTid +
                ', выборка не удалась — ' + THREAD_IDS_STAT.lookupBad + ').' + hint);
            if (partialRows && partialRows.length) {
                console.warn('[Проблемные письма] Ветки с неполной выборкой (в них метку ' +
                    'получили только найденные письма):\n' +
                    JSON.stringify(partialRows, null, 2));
            }
        } catch (e) { /* диагностика не должна ломать прогон */ }
    }

    // Строки, для которых письма в ящике нет: метим красным и называем поимённо.
    // «Писем не найдено 1» без указания, каких именно, искать не помогает.
    function markRowsWithoutMail(notFoundRows) {
        if (!notFoundRows || !notFoundRows.length) return;
        notFoundRows.forEach(function (r) {
            const key = String(r.sheetRow);
            NOT_FOUND_ROWS.add(key);
            MEMORY_CACHE.results.delete(key);
            const badge = badgeForRow(key);
            if (badge) { badge.classList.remove('syncing'); paintThreadBadge(badge, null); }
        });
        saveCacheToStorage();
        try {
            console.warn('[Проблемные письма] Писем нет в этом ящике (строки помечены красным):\n' +
                notFoundRows.map(function (r) {
                    return '  строка ' + r.sheetRow + ': ' + r.topic;
                }).join('\n'));
        } catch (e) { /* ignore */ }
    }

    // Фаза 2 прогона меток: одна переписка — одно решение.
    //
    // Разные строки таблицы часто указывают на ОДНУ переписку (одинаковая тема или
    // один и тот же номер ЗП). Если одна из них выполнена, а другая нет, то раньше
    // строки затирали работу друг друга: одна ставила метку, другая тут же снимала — и
    // результат зависел от того, кто отработал последним. Здесь на ветку принимается
    // одно решение, и «поставить» побеждает «снять».
    //
    // resolved  — итоги фазы 1 (по строке на запись).
    // fastApply — ветки из фазы 0, которым метки не хватает: id уже известны.
    function groupResolvedByThread(resolved, fastApply) {
        const byThread = new Map();
        const runLog = [];
        const notFoundRows = [];
        let noThread = 0;

        (resolved || []).forEach(function (it) {
            if (!it.ids.length) {
                if (!it.add) return;   // снимать не с чего — молчим
                noThread++;
                runLog.push({ тема: it.row.topic, действие: 'поставить',
                              итог: it.failed ? 'запрос к почте не прошёл'
                                              : 'письмо в почте не найдено' });
                // Прогон честно выяснил, что письма в этом ящике нет — отмечаем строку
                // так же, как это делает поиск для карточки: красный кружок с крестиком.
                // Раньше отчёт писал «писем не найдено 1», а найти эту строку в панели
                // было невозможно: красным её метил только другой путь (обновление
                // карточек), и до неё он мог просто не дойти.
                // Красным метим ТОЛЬКО когда почта ответила и письма правда нет.
                if (!it.failed) notFoundRows.push(it.row);
                return;
            }
            const key = it.ids.slice().sort().join(',');
            const prev = byThread.get(key);
            if (!prev) {
                byThread.set(key, { ids: it.ids, add: it.add, labelIdsNow: it.labelIdsNow,
                                    rows: [it.row], prefer: it.prefer });
                return;
            }
            prev.add = prev.add || it.add;
            if (!Array.isArray(prev.labelIdsNow) && Array.isArray(it.labelIdsNow)) {
                prev.labelIdsNow = it.labelIdsNow;
            }
            prev.rows.push(it.row);
        });

        // Ветки из фазы 0 — им метки не хватает, id уже известны, искать нечего.
        // Ставим их в ту же очередь применения: там и проверка результата, и учёт.
        (fastApply || []).forEach(function (t) {
            const key = t.ids.slice().sort().join(',');
            const prev = byThread.get(key);
            if (prev) { prev.add = true; return; }
            byThread.set(key, { ids: t.ids, add: true, labelIdsNow: null,
                                rows: t.rows, prefer: { all: new Set(), any: false } });
        });

        return { byThread: byThread, runLog: runLog,
                 notFoundRows: notFoundRows, noThread: noThread };
    }

    // Фаза 0 прогона меток, одна ветка: спросить у почты её состав и сверить с теми
    // письмами, на которых метка уже стоит.
    //
    // Смысл фазы: не ГАДАТЬ, вся ли ветка помечена, а спросить. Все попытки вывести
    // полноту из чисел проваливались одинаково — и count из ответа по метке, и число
    // писем из карточки занижены (считают только то, что попало в фильтр или в поиск).
    // В переписке 25 писем, помечено 22, а оба источника говорят «22 из 22»: строка
    // пропускается, и три письма остаются без метки.
    //
    // it           — { row, tid, known } из выборки по метке.
    // labelledIds  — id писем, на которых метка уже стоит (без префикса «t»).
    async function verifyKnownThread(it, labelledIds) {
        let msgs = null;
        try { msgs = await findMessagesByTid(it.tid); } catch (e) { msgs = null; }
        // Ветку спросить не удалось — пусть строку разберёт обычный путь.
        if (!msgs || !msgs.length) {
            return { keepIds: [], keepTid: '', needsFullParse: true,
                     alreadyLabelled: false, apply: null };
        }
        const mids = msgs.map(function (m) { return m.mid; })
            .filter(function (x) { return x && !/^t/.test(String(x)); })
            .map(String);
        const missing = mids.filter(function (id) { return !labelledIds.has(id); });
        // Метка уже на всех письмах ветки — строку не трогаем.
        if (!missing.length) {
            return { keepIds: mids, keepTid: it.tid, needsFullParse: false,
                     alreadyLabelled: true, apply: null };
        }
        // Не хватает — метим ВСЮ ветку сразу, без поиска письма. Для строки, которой
        // нужна дописка, это даже дешевле прежнего пути (был поиск, потом выборка,
        // потом простановка).
        return {
            keepIds: mids, keepTid: it.tid, needsFullParse: false, alreadyLabelled: false,
            apply: { ids: mids, rows: [it.row], missing: missing.length }
        };
    }

    // Фаза 1 прогона меток, одна строка таблицы: найти письма её переписки.
    //
    // Вынесено из bulkApplyLabels — там это был самый глубокий и самый длинный кусок
    // (вложенность доходила до тринадцати уровней), и любая правка в нём требовала
    // держать в голове весь прогон целиком. Здесь функция ничего не знает о прогоне:
    // на входе строка, на выходе — что с ней вышло. Побочных эффектов нет, всё, что
    // прогону нужно дописать в свои списки, возвращается полями.
    //
    // add — надо ли этой строке метку ставить (она «своя» и невыполненная).
    async function resolveRowThread(r, add) {
        let ids = [];
        let info = null;
        let labelIdsNow = null;
        let prefer = { all: new Set(), any: false };
        let partial = null;
        let firstFail = '';
        // Запрос мог не пройти вовсе (сеть, почта отклонила). Это НЕ то же самое, что
        // «письма в ящике нет», и метить строку красным крестиком из-за осечки нельзя:
        // крестик потом висит до перезагрузки вкладки.
        let lookupFailed = false;
        try {
            // Сохранённый при добавлении id (mailId) надёжнее поиска по теме —
            // короткие темы без номера ЗП совпадают у разных переписок. Но строку мог
            // завести ДРУГОЙ пользователь в СВОЁМ ящике: там этих id нет, а do-label с
            // несуществующим id всё равно отвечает «ок», ничего не делая. Поэтому
            // берём только подтверждённые id.
            // Сохранённый id ветки используем не ВМЕСТО поиска, а как ОРИЕНТИР внутри
            // его результатов: поиск возвращает все письма с похожей темой, и без
            // ориентира выбиралась не та переписка — метка уходила на чужое письмо, а
            // проверка смотрела на него же и рапортовала успех.
            prefer = parseStoredIds(r.mailId);
            // Строку завела сменщица (в колонке стоит пометка её ящика) — её id в нашей
            // почте не значат ничего. Не подставляем их ориентиром и не спрашиваем по
            // ним почту: ветку опознаём по теме, началу текста и времени письма.
            const foreignIds = storedIdsAreForeign(prefer);
            info = await apiGetInfo(r.topic, r.number, r.dateAdded,
                                    (prefer.any && !foreignIds) ? prefer : null, r.preview);
            const threadState = {};
            ids = await fullThreadIds(info, threadState);
            if (threadState.state && threadState.state !== 'full') {
                partial = {
                    тема: r.topic,
                    строка: r.sheetRow,
                    писем_в_выборке: threadState.count,
                    причина: threadState.state === 'noTid'
                        ? 'поиск не вернул id переписки'
                        : 'выборка писем переписки не удалась'
                };
            }
            // Поиск письмо не нашёл — последняя попытка: спросить почту по самим
            // сохранённым id.
            if (!ids.length && prefer.any && !foreignIds) {
                const storedIdsRaw = String(r.mailId || '').split(',')
                    .map(function (x) { return x.trim(); }).filter(Boolean);
                ids = await verifyStoredIdsBelongHere(storedIdsRaw,
                    { topic: r.topic, preview: r.preview, ts: prefer.ts });
            }
            labelIdsNow = info && Array.isArray(info.labelIds) ? info.labelIds : null;
            if (!labelIdsNow && ids.length) {
                const msgs = await findMessagesByMids(ids).catch(function () { return null; });
                if (msgs) {
                    const set = new Set();
                    msgs.forEach(function (m) {
                        collectMsgLabelIds(m).forEach(function (id) { set.add(id); });
                    });
                    labelIdsNow = Array.from(set);
                }
            }
        } catch (e) {
            lookupFailed = true;
            firstFail = friendlyErrorMessage(e);
        }

        // Дописываем строке то, чего ей не хватает для точного поиска: время письма
        // (одинаково во всех ящиках, по нему сменщица опознаёт ту же переписку) и id
        // ВЕТКИ (по нему письмо спрашивается у почты напрямую, без поиска по теме).
        let tsFix = null;
        const needTs = !prefer.ts && info && (info.lastTs || info.firstTs);
        const needTid = !(prefer.tids && prefer.tids.size) && info && info.tid;
        if ((needTs || needTid) && ids.length) {
            // Дописываем, а не переписываем: mergeMailIdValue сохраняет всё, что уже
            // было, не трогает чужие строки и возвращает пусто, если писать нечего.
            const merged = mergeMailIdValue(r.mailId, ids,
                prefer.ts || (info && (info.lastTs || info.firstTs)) || 0,
                (info && info.tid) || '');
            if (merged) tsFix = { rowNumber: r.sheetRow, fields: { mailId: merged } };
        }

        return {
            entry: { row: r, add: add, ids: ids, labelIdsNow: labelIdsNow,
                     prefer: prefer, failed: lookupFailed || AUTH_TROUBLE },
            add: add,
            tid: (info && info.tid) || '',
            partial: partial,
            tsFix: tsFix,
            firstFail: firstFail
        };
    }

    async function bulkApplyLabels(name, btnEl, opts) {
        opts = opts || {};
        const cfg = await getLabelConfig();
        const labelName = String(name || '').trim() || cfg.names[0] || '';
        if (isLabelBusy(labelName)) return null;
        const btn = btnEl || labelAllEl;
        if (!labelName) { showToast('Сначала укажите метку в настройках расширения', 'error'); return null; }
        if (!opts.skipConfirm && !window.confirm('Синхронизировать метку «' + labelName + '» с таблицей?\n\n' +
            '• поставить её на невыполненные письма этой метки;\n' +
            '• снять со всех остальных строк таблицы (выполненных и писем других меток);\n' +
            '• найти письма с этой меткой, которых в таблице нет, и предложить снять её и с них.')) return null;

        labelsInFlight.add(normLabelName(labelName));
        if (btn) { btn.disabled = true; setLabelBtnState(btn, 'working'); }
        try {
            // Одна проверка на весь прогон: существует ли метка в почте. Заодно это
            // главный диагностический сигнал — если метка не резолвится, ломаются и
            // авто-метка при добавлении, и снятие при «Выполнено», и эта кнопка.
            let labelsInfo = null;
            try { labelsInfo = await loadLabels(true); } catch (e) { /* ниже обработаем */ }
            let lid = labelsInfo ? labelsInfo.byName.get(normLabelName(labelName)) : null;
            if (!lid) {
                // Метки нет в ЭТОМ аккаунте почты — обычная ситуация, когда таблицу с
                // такой меткой заполнял другой сотрудник на своей почте. Создаём метку
                // здесь же (по имени из настроек), а не сразу сдаёмся с ошибкой —
                // раньше синхронизация у второго пользователя намертво стопорилась.
                const created = await createLabelInMail(labelName).catch(function () { return false; });
                if (created) {
                    labelsInfo = await loadLabels(true).catch(function () { return labelsInfo; });
                    lid = labelsInfo ? labelsInfo.byName.get(normLabelName(labelName)) : null;
                }
            }
            if (!lid) {
                const n = (labelsInfo && labelsInfo.list) ? labelsInfo.list.length : 0;
                // Показываем ПРИЧИНУ: «меток 0» бывает и когда список правда пуст, и
                // когда запрос к почте вообще не прошёл — это разные поломки.
                const why = LABELS_LAST_ERROR ? (', причина: ' + LABELS_LAST_ERROR) : '';
                showToast('Метка «' + labelName + '» не найдена в почте и не удалось создать (загружено меток: ' + n + why +
                    '). Проверьте точное название в Настройках.', 'error');
                return;
            }

            const runStartedAt = Date.now();
            const res = await send({ type: 'pm-list-all' });
            const all = (res && res.ok && res.rows) || [];
            warnAboutMissingColumns(res && res.columns, opts.quiet);
            // Свои невыполненные строки — метку ставим. Все остальные строки таблицы
            // (выполненные и письма соседних плашек) — метку снимаем: раньше «хвосты»
            // оставались висеть на письмах, которых в этой плашке уже нет.
            // Строки ЭТОЙ метки целиком — и невыполненные, и закрытые. Закрытые нужны
            // не меньше: именно с них метку надо снять (см. classifyRowForRun).
            const ownRows = rowsOfLabel(all, labelName, { strict: true });
            const ownSet = new Set(ownRows.map(function (r) { return r.sheetRow; }));
            const mineRows = ownRows.filter(function (r) { return !r.done; });
            const mine = new Set(mineRows.map(function (r) { return r.sheetRow; }));
            // Что прогон считает «своим» и не тронет при уборке «хвостов»:
            //   keepIds      — id писем, которым метка положена;
            //   keepTids     — ветки, которые за собой заявили живые строки плашки;
            //   keepSubjects — темы живых строк (предохранитель для строк, чьи id из
            //                  чужого ящика и потому с письмом не связываются).
            //
            // Кладём и сравниваем ВСЁ через stripThreadPrefix. Раньше множество
            // наполнялось из трёх источников с разной нормализацией: matchLabelledRow
            // отдавал id уже без префикса «t», фаза 0 — заведомо без него, а фаза 2
            // клала то, что вернул fullThreadIds, — а он при неудачном запросе по tid
            // отдаёт id прямо из info, с префиксом. collectStrays при этом сравнивал
            // СЫРЫЕ значения из ответа почты. Достаточно было, чтобы письмо пришло с
            // mid «t123», а в keepIds лежало «123», — и живое письмо считалось
            // «хвостом», метка с него снималась молча и навсегда. Предохранители по
            // ветке и теме, добавленные в 2.91, это лишь прикрывали; здесь причина.
            const keepIds = new Set();
            const keepTids = new Set();
            const keepSubjects = new Set();
            const keepId = function (v) {
                const id = stripThreadPrefix(String(v == null ? '' : v).trim());
                if (id) keepIds.add(id);
            };
            const keepTid = function (v) {
                const id = stripThreadPrefix(String(v == null ? '' : v).trim());
                if (id) keepTids.add(id);
            };

            mineRows.forEach(function (r) {
                const sj = normForMatch(stripRowSubjectTail(r.topic));
                if (sj) keepSubjects.add(sj);
                parseStoredIds(r.mailId).tids.forEach(keepTid);
            });
            if (!all.length) {
                showToast('Таблица пуста — нечего синхронизировать', 'info');
                return;
            }

            // ОДИН запрос: какие письма сейчас носят эту метку. Дальше он экономит
            // десятки запросов. Раньше расширение разбирало ВСЕ строки таблицы, хотя
            // строки соседних плашек нужны только чтобы СНЯТЬ метку — а снимать
            // нечего, если её там и нет. При 94 строках и одной своей это была сотня
            // лишних запросов к почте и полминуты ожидания.
            const labelledBefore = await findMessagesWithLabel(lid);
            const idx = labelledBefore ? indexLabelled(labelledBefore) : null;
            let already = 0;           // строк, где метка уже стоит — их не трогаем
            const rows = [];
            // Свои строки, чью ветку узнали в выборке: их проверим точным запросом
            // к переписке, а не догадками о её размере.
            const fastRows = [];
            // Диагностика прогона: если пропуск «метка уже стоит» не сработал, по этим
            // числам сразу видно, на чём именно он рвётся, — без гадания по симптомам.
            const syncDiag = {
                'писем с меткой в почте': labelledBefore ? labelledBefore.length : 'запрос не удался',
                'дочитано страниц': labelledBefore ? Math.ceil(labelledBefore.length / 200) : 0,
                'из них со временем': idx ? idx.entries.filter(function (e) { return !!e.ts; }).length : 0,
                'из них с темой': idx ? idx.entries.filter(function (e) { return !!e.subj; }).length : 0,
                // Если тема или время не разобрались — решает форма ответа почты.
                // Печатаем только имена полей, без содержимого писем.
                'поля ответа почты': (labelledBefore && labelledBefore[0])
                    ? Object.keys(labelledBefore[0]) : null,
                'своих строк': 0,
                'у них сохранены id': 0,
                'у них сохранено время': 0,
                'опознано по id': 0,
                'опознано по времени+теме': 0,
                'пропущено (метка уже стоит)': 0,
                'сверено запросом к переписке': 0
            };
            let diagSample = null;
            let clearedNotFound = 0;
            all.forEach(function (r) {
                const out = classifyRowForRun(r, idx, mine.has(r.sheetRow),
                                              ownSet.has(r.sheetRow), syncDiag, diagSample);
                if (out.clearedNotFound) clearedNotFound++;
                if (out.diagSample) diagSample = out.diagSample;
                out.keepIds.forEach(keepId);
                out.keepTids.forEach(keepTid);
                if (out.fastRow) fastRows.push(out.fastRow);
                else if (out.parse) rows.push(r);
            });
            if (clearedNotFound) {
                // Крестики нарисованы по устаревшей причине — перерисовываем список
                // сразу, не дожидаясь перезагрузки вкладки.
                lastRenderSig = null;
                render(latestRows, null);
                saveCacheToStorage();
                dlog('Снял пометку «письмо не найдено» с ' + clearedNotFound + ' строк');
            }
            // === Фаза 0: точная проверка веток, узнанных в выборке ===
            // Один запрос на строку: спрашиваем письма переписки и сверяем их с теми,
            // на которых метка уже стоит. Ничего не не хватает — строку не трогаем;
            // не хватает — метим ВСЮ ветку сразу, без поиска письма. Для строки,
            // которой нужна дописка, это даже дешевле прежнего пути (был поиск плюс
            // выборка плюс простановка).
            const labelledIds = new Set();
            (labelledBefore || []).forEach(function (m) {
                [m.mid, m.last_mid].forEach(function (x) {
                    if (x != null) labelledIds.add(stripThreadPrefix(String(x)));
                });
            });
            const fastApply = [];     // ветки, которым метки не хватает
            if (fastRows.length) {
                setRowsSyncing(fastRows.map(function (x) { return x.row.sheetRow; }), true);
                const fq = fastRows.slice();
                async function verifier() {
                    while (fq.length) {
                        const it = fq.shift();
                        const out = await verifyKnownThread(it, labelledIds);
                        out.keepIds.forEach(keepId);
                        if (out.keepTid) keepTid(out.keepTid);
                        // Спросить ветку не вышло — разберём строку обычным путём.
                        if (out.needsFullParse) rows.push(it.row);
                        if (out.alreadyLabelled) already++;
                        if (out.apply) fastApply.push(out.apply);
                        if (!out.apply) setRowsSyncing([it.row.sheetRow], false);
                    }
                }
                const vw = [];
                for (let i = 0; i < Math.min(REFRESH_CONCURRENCY, fastRows.length); i++) vw.push(verifier());
                await Promise.all(vw);
                syncDiag['сверено запросом к переписке'] = fastRows.length;
            }
            // Считаем ВСЕГДА, а не только когда фаза 0 отработала. Раньше строка
            // стояла внутри if выше, и при пустом fastRows разбор показывал
            // «пропущено 0» при ненулевом already — то есть врал ровно там, где по
            // нему и разбираются.
            syncDiag['пропущено (метка уже стоит)'] = already;

            printRunDiagnostics(labelName, {
                parsed: rows.length, total: all.length, already: already,
                labelledBefore: labelledBefore, syncDiag: syncDiag, diagSample: diagSample
            });

            if (!rows.length && !fastApply.length) {
                // Разбирать нечего, но «хвосты» проверить надо: письмо могло получить
                // метку мимо таблицы (руками в почте или из удалённой строки).
                // Время печатаем и здесь: иначе в прогоне «обновить все» у быстрых
                // плашек строки «готова за …» просто нет, и непонятно, что они вообще
                // отработали.
                try {
                    console.log('[Проблемные письма] «' + labelName + '» готова за ' +
                        Math.round((Date.now() - runStartedAt) / 100) / 10 + ' с ' +
                        '(разбирать нечего, пропущено: ' + already + ').');
                } catch (e) { /* ignore */ }
                markLabelSynced(labelName);
                clearAllRowsSyncing();
                // «Хвосты» снимаем, только если прогон видел ПОЛНУЮ картину. Здесь
                // этой проверки не было — в отличие от основного пути ниже, — и при
                // отклонённом запросе к почте (AUTH_TROUBLE) или сорвавшейся выборке
                // по метке метка снималась по неполному списку, то есть с живых
                // писем. Цена ошибки несимметрична: лишняя метка никому не мешает и
                // будет предложена в следующий прогон, снятая по ошибке теряется
                // молча и навсегда.
                const blind = AUTH_TROUBLE || !labelledBefore;
                if (blind) {
                    try {
                        console.warn('[Проблемные письма] «' + labelName + '»: лишние метки ' +
                            'не снимаю — ' + (AUTH_TROUBLE
                                ? 'почта отклоняет запросы, полного списка писем с меткой нет'
                                : 'выборку писем с меткой получить не удалось') +
                            '. Сниму, когда прогон отработает целиком.');
                    } catch (e) { /* ignore */ }
                }
                const strays = blind ? [] : collectStrays(labelledBefore, keepIds, labelName,
                                             { tids: keepTids, subjects: keepSubjects });
                const empty = { put: 0, removed: 0, unconfirmed: 0, noThread: 0, fail: 0,
                                already: already, strayIds: strays };
                if (opts.quiet) return empty;
                const tail = strays.length
                    ? ('. Снимаю метку ещё с ' + strays.length + ' ' +
                       plural(strays.length, 'письма', 'писем', 'писем') + ' вне таблицы')
                    : '. Лишних меток нет';
                showToast((already
                    ? ('Всё уже проставлено: писем с меткой — ' + already)
                    : 'Нечего синхронизировать: писем этой плашки нет') + tail, 'success');
                cleanupStrays(strays);
                return empty;
            }
            // Часики — только на строках, которые реально пойдут в разбор. Пропущенные
            // («метка уже стоит») не мигают: они и так готовы.
            setRowsSyncing(rows.map(function (r) { return r.sheetRow; }), true);
            THREAD_IDS_STAT.full = 0; THREAD_IDS_STAT.noTid = 0; THREAD_IDS_STAT.lookupBad = 0;

            let put = 0, removed = 0, noThread = 0, fail = 0, unconfirmed = 0, done = 0;
            let firstFail = '';          // первая реальная причина — покажем в отчёте
            const tsFixes = [];          // строкам без времени письма допишем его
            const runLog = [];           // построчная диагностика прогона (в консоль)
            const notFoundRows = [];     // строки, для которых письма в этом ящике нет
            const partialRows = [];      // ветки, помеченные по НЕПОЛНОЙ выборке писем

            // === Фаза 1: для каждой строки находим письма её переписки ===
            const resolved = [];
            const queue = rows.slice();
            async function resolver() {
                while (queue.length) {
                    const r = queue.shift();
                    const out = await resolveRowThread(r, mine.has(r.sheetRow));
                    if (out.partial) partialRows.push(out.partial);
                    if (out.tsFix) tsFixes.push(out.tsFix);
                    if (out.firstFail && !firstFail) firstFail = out.firstFail;
                    if (out.add && out.tid) keepTid(out.tid);
                    resolved.push(out.entry);
                    done++;
                    btn.title = 'Метки: ' + done + '/' + rows.length;
                }
            }
            const workers = [];
            for (let i = 0; i < Math.min(REFRESH_CONCURRENCY, rows.length); i++) workers.push(resolver());
            await Promise.all(workers);

            // === Фаза 2: одна переписка — одно решение ===
            const grouped = groupResolvedByThread(resolved, fastApply);
            noThread += grouped.noThread;
            grouped.runLog.forEach(function (x) { runLog.push(x); });
            grouped.notFoundRows.forEach(function (x) { notFoundRows.push(x); });

            const threads = Array.from(grouped.byThread.values());
            const queue2 = threads.slice();
            const applied = [];        // ветки, которым отправили do-label/do-unlabel
            let done2 = 0;
            async function applier() {
                while (queue2.length) {
                    const t = queue2.shift();
                    const labelsKnown = Array.isArray(t.labelIdsNow);
                    const hasLabelNow = labelsKnown &&
                        t.labelIdsNow.some(function (x) { return String(x) === String(lid); });
                    if (t.add) t.ids.forEach(keepId);

                    if (!t.add && labelsKnown && !hasLabelNow) {
                        done2++;
                        btn.title = 'Метки: ' + done2 + '/' + threads.length;
                        continue; // метки и так не было — снимать нечего
                    }

                    let rr;
                    try { rr = await setThreadLabel(t.ids, labelName, t.add); }
                    catch (e) { rr = { ok: false, error: friendlyErrorMessage(e) }; }
                    if (!rr.ok && rr.error !== 'label-not-found' && !firstFail) firstFail = rr.error;

                    // Проверку «а метка правда легла?» раньше делали ЗДЕСЬ, отдельным
                    // запросом на каждую ветку. Теперь копим и проверяем все ветки
                    // разом — одной выборкой писем с этой меткой (см. ниже).
                    t.rr = rr;
                    t.hasLabelNow = hasLabelNow;
                    // Ветка отработана — освобождаем её строки сразу, не дожидаясь
                    // остальных: с ними уже можно работать.
                    setRowsSyncing(t.rows.map(function (x) { return x.sheetRow; }), false);
                    t.labelsKnown = labelsKnown;
                    applied.push(t);
                    done2++;
                    btn.title = 'Метки: ' + done2 + '/' + threads.length;
                }
            }
            const workers2 = [];
            for (let i = 0; i < Math.min(REFRESH_CONCURRENCY, threads.length); i++) workers2.push(applier());
            await Promise.all(workers2);

            // === Проверка по факту — ОДНИМ запросом на весь прогон ===
            const labelledAfter = await findMessagesWithLabel(lid);
            const tally = await confirmAppliedLabels(applied, labelledAfter, labelName);
            put += tally.put;
            removed += tally.removed;
            fail += tally.fail;
            unconfirmed += tally.unconfirmed;
            tally.runLog.forEach(function (x) { runLog.push(x); });

            dlog('[Проблемные письма] Синхронизация метки «' + labelName + '»:', runLog);
            if (tsFixes.length) {
                try {
                    await send({ type: 'pm-backfill-write', items: tsFixes });
                    // Именно отсутствие времени письма не даёт пропустить строку без
                    // запроса к почте: без него не опознать, что метка уже стоит.
                    // Раз дописали — следующий прогон по этим строкам будет быстрым.
                    console.log('[Проблемные письма] «' + labelName + '»: дописано время ' +
                        'письма в ' + tsFixes.length + ' строк — в следующий прогон они ' +
                        'пропустятся без запросов к почте.');
                } catch (e) { /* не критично: допишем в следующий прогон */ }
            }

            reportPartialThreads(labelName, partialRows);

            markRowsWithoutMail(notFoundRows);

            // «Хвосты»: письма с этой меткой, которых в таблице вообще нет. Собираем
            // здесь, а снимаем метку сами — фоном, уже после отчёта: на работу это не
            // влияет и срочности не имеет. Раньше тут стояло модальное окно посреди
            // прогона, потом — тост с кнопкой; и то, и другое требовало решения на
            // ровном месте.
            // Снимать метку с «хвостов» можно, только когда прогон отработал ПОЛНОСТЬЮ.
            // Если хоть одну строку не удалось разобрать (почта не ответила, письмо не
            // нашлось), мы не знаем, чьи это письма, — и «хвостом» может оказаться
            // письмо живой строки. Лишняя метка не мешает никому и будет предложена в
            // следующий прогон; снятая по ошибке теряется молча и навсегда.
            const runIncomplete = !!(fail || noThread || unconfirmed || AUTH_TROUBLE);
            const strayOut = runIncomplete ? [] : collectStrays(labelledAfter, keepIds, labelName,
                { tids: keepTids, subjects: keepSubjects });
            if (runIncomplete) {
                try {
                    console.warn('[Проблемные письма] Лишние метки в этот раз не снимаю: ' +
                        'прогон прошёл не полностью (не разобрано строк: ' +
                        (fail + noThread + unconfirmed) + '). Сниму, когда прогон отработает ' +
                        'целиком, — иначе можно снять метку с живого письма.');
                } catch (e) { /* ignore */ }
            }

            // Сколько плашка работала. Часики на ней крутятся до этой секунды, и когда
            // строки внутри давно без часиков, а плашка всё ещё занята — по этому числу
            // сразу видно, сколько на самом деле шёл прогон.
            try {
                console.log('[Проблемные письма] «' + labelName + '» готова за ' +
                    Math.round((Date.now() - runStartedAt) / 100) / 10 + ' с ' +
                    '(разобрано строк: ' + rows.length + ', пропущено: ' + already + ').');
            } catch (e) { /* ignore */ }

            const report = buildLabelRunReport({
                put: put, removed: removed, already: already, strayOut: strayOut,
                unconfirmed: unconfirmed, noThread: noThread, fail: fail, firstFail: firstFail
            });
            // Метки этой плашки приведены в порядок — запоминаем состав её строк.
            // Пока он не изменится, кнопка 🏷️ остаётся спокойной; изменится (коллега
            // добавила письмо или закрыла своё) — станет красной.
            markLabelSynced(labelName);

            if (opts.quiet) {
                // Список НЕ обновляем: в прогоне «обновить все» плашек до семи, и
                // раньше каждая жала кнопку почты сама — до восьми нажатий подряд за
                // один прогон, считая уборку «хвостов». Общий итог и одно обновление
                // покажет syncAllLabels в самом конце.
                return { put: put, removed: removed, unconfirmed: unconfirmed,
                         noThread: noThread, fail: fail, firstFail: firstFail, already: already,
                         strayIds: strayOut };
            }
            if (put || removed || unconfirmed) {
                // Метки, поставленные через API, Яндекс в уже отрисованном списке не
                // показывает — обновляем список сами, а если не помогло, даём кнопку.
                forceMailListRefresh('прогон метки «' + labelName + '»');
                showActionToast(report, 'Обновить почту', function () {
                    trace('перезагрузка по кнопке в отчёте');
                    saveTrace();
                    try { location.reload(); } catch (e) { /* ignore */ }
                }, fail ? 'error' : 'success', 12000);
            } else {
                showToast(report, (fail || noThread || unconfirmed) ? 'error' : 'success');
            }
            cleanupStrays(strayOut);
            return { put: put, removed: removed, unconfirmed: unconfirmed,
                     noThread: noThread, fail: fail, firstFail: firstFail, already: already };
        } catch (e) {
            if (opts.quiet) return { put: 0, removed: 0, unconfirmed: 0, noThread: 0, fail: 1,
                                     already: 0, firstFail: friendlyErrorMessage(e) };
            showToast('Ошибка простановки меток: ' + friendlyErrorMessage(e), 'error');
            return null;
        } finally {
            labelsInFlight.delete(normLabelName(labelName));
            clearAllRowsSyncing();
            if (btn) {
                btn.disabled = false;
                setLabelBtnState(btn, '', labelName);
            }
            updateSyncMarks();
        }
    }

    // Письма, на которых метка висит, а в таблице их нет.
    //
    // «Хвост» опознаётся ОТ ОБРАТНОГО: письмо не заявила ни одна строка. Это верно
    // ровно настолько, насколько точно мы опознали строки, — а у сменщицы в колонке
    // «ID письма» лежат id ЧУЖОГО ящика, и опознание идёт догадкой по теме, началу
    // текста и времени. Стоит догадке промахнуться на одну переписку из нескольких
    // с одинаковой темой («Перемещение Заславль - Таборы» — их в ящике десяток), и
    // настоящее письмо строки оказывается «вне таблицы»: метку с него снимают молча
    // и насовсем, а ставят на соседнее. Ровно так и выглядит «нет вообще меток на
    // письмах».
    //
    // Поэтому у снятия теперь два предохранителя, и оба — от ЖИВЫХ строк плашки:
    //   * ветка (tid) уже заявлена какой-то своей строкой — все её письма наши;
    //   * тема письма совпала с темой живой невыполненной строки — значит строка
    //     такая есть, и мы просто не смогли связать её с этим письмом.
    // Выполненные строки под предохранители не попадают: с их писем метку снимает
    // обычный путь («снять»), и он опирается на опознание, а не на догадку.
    //
    // Цена ошибки несимметрична: лишняя метка никому не мешает и будет предложена в
    // следующий прогон, а снятая по ошибке теряется молча и навсегда.
    //
    // ЧЕМ ЗА ЭТО ПЛАТИМ — чтобы следующий разбор не пошёл по кругу. Предохранитель по
    // теме грубый: тема нормализуется, и если в ящике десяток переписок с одинаковой
    // темой («Перемещение Заславль - Таборы»), одна живая строка прикрывает ВСЕ
    // десять. Для таких плашек уборка «хвостов» фактически не работает — метку,
    // повешенную руками не на то письмо, придётся снять руками же. Это сознательный
    // размен, а не недосмотр: молча снятая метка обходится дороже.
    //
    // Лечится это не ослаблением предохранителя, а тем, чтобы строку было с чем
    // связать, — то есть заполненной колонкой «ID письма» (см. keepId выше и
    // MAILBOX_UID). Когда id свои и на месте, письмо опознаётся точно и до
    // предохранителя по теме дело не доходит.
    function collectStrays(msgs, keepIds, labelName, keep) {
        const out = [];
        const keepTids = (keep && keep.tids) || null;
        const keepSubjects = (keep && keep.subjects) || null;
        let sparedByTid = 0, sparedBySubject = 0;
        (msgs || []).forEach(function (m) {
            const mid = m.last_mid || (m.mid ? stripThreadPrefix(m.mid) : null);
            // Сравниваем НОРМАЛИЗОВАННО — как и кладём (см. keepId в bulkApplyLabels).
            // Раньше здесь шли сырые значения из ответа почты, и письмо с mid «t123»
            // не совпадало с «123» в keepIds: живое письмо уходило в «хвосты».
            const known = [m.mid, m.tid, m.last_mid, mid].some(function (x) {
                return x != null && keepIds.has(stripThreadPrefix(x));
            });
            if (known || !mid) return;
            if (keepTids && keepTids.size && m.tid &&
                keepTids.has(stripThreadPrefix(m.tid))) { sparedByTid++; return; }
            if (keepSubjects && keepSubjects.size) {
                const subj = normForMatch(stripRowSubjectTail(msgSubject(m)));
                if (subj && keepSubjects.has(subj)) { sparedBySubject++; return; }
            }
            out.push({ id: String(mid), label: labelName });
        });
        if (sparedByTid || sparedBySubject) {
            try {
                console.log('[Проблемные письма] «' + labelName + '»: метку НЕ снимаю с ' +
                    (sparedByTid + sparedBySubject) + ' ' +
                    plural(sparedByTid + sparedBySubject, 'письма', 'писем', 'писем') +
                    ' — они из веток живых строк плашки (по ветке: ' + sparedByTid +
                    ', по теме: ' + sparedBySubject + '). Строку с ними связать не ' +
                    'удалось: скорее всего, id в таблице из чужого ящика.');
            } catch (e) { /* ignore */ }
        }
        return out;
    }

    // «Хвосты» — письма, на которых метка висит, а строки для них в таблице нет
    // (метку повесили руками в почте, или строку из таблицы удалили). Снятие никого
    // не держит и подтверждения не требует: снимаем сами, фоном и в последнюю
    // очередь — после отчёта, ничего не блокируя.
    function cleanupStrays(list) {
        if (!list || !list.length) return;
        trace('фоновая уборка хвостов', 'писем: ' + list.length);
        const byLabel = new Map();
        list.forEach(function (it) {
            if (!byLabel.has(it.label)) byLabel.set(it.label, []);
            byLabel.get(it.label).push(String(it.id));
        });
        let ok = 0, bad = 0;
        const jobs = [];
        byLabel.forEach(function (ids, label) {
            jobs.push(setThreadLabel(ids, label, false)
                .then(function (rr) { if (rr && rr.ok) ok += ids.length; else bad += ids.length; })
                .catch(function () { bad += ids.length; }));
        });
        Promise.all(jobs).then(function () {
            // Молчим, когда всё прошло: это фоновая уборка, а не результат работы.
            // Сообщаем только о неудаче — там метка осталась висеть.
            if (bad) showToast('Не удалось снять метку с ' + bad + ' ' +
                plural(bad, 'письма', 'писем', 'писем') + ' вне таблицы', 'error');
            if (ok) forceMailListRefresh('убраны хвосты меток');
        });
    }

    // Прогон по ВСЕМ плашкам подряд. Одно подтверждение на всё и один общий итог —
    // иначе в смену с семью плашками приходится семь раз кликать и семь раз читать
    // почти одинаковый тост.
    async function syncAllLabels(btn) {
        const all = labelCfg.names.filter(function (n) { return String(n || '').trim(); });
        if (!all.length) { showToast('Сначала укажите метки в настройках расширения', 'error'); return; }
        // «Обновить метки» обновляет ВСЕ плашки — как и написано на кнопке.
        //
        // Раньше прогон брал только те, где изменился состав строк таблицы. Экономия
        // имела смысл, пока плашка обновлялась минуты; теперь уже проставленная стоит
        // пары запросов и доли секунды. А цена у пропуска была высокая: расширение
        // видит изменения В ТАБЛИЦЕ и не видит, что метку сняли РУКАМИ В ПОЧТЕ. Состав
        // строк тот же, плашка не краснеет, прогон её не берёт — и «обновить всё»
        // молча обновляло не всё. Догонять пришлось поштучно, кнопкой на каждой плашке.
        const names = all.slice();
        const staleNames = all.filter(function (n) { return labelNeedsSync(n); });
        if (!window.confirm('Синхронизировать с таблицей все метки (' + names.length + '): ' +
            names.join(', ') + '?\n\n' +
            (staleNames.length
                ? ('Изменения замечены в: ' + staleNames.join(', ') +
                   ' — остальные проверим тоже, это быстро.\n\n')
                : 'Изменений в таблице нет, но метки могли снять вручную в самой почте — проверим все.\n\n') +
            'Для каждой: поставить метку на её невыполненные письма и снять с остальных.')) return;

        const total = { put: 0, removed: 0, unconfirmed: 0, noThread: 0, fail: 0, already: 0 };
        let firstFail = '';
        const strayAll = [];       // «хвосты» со всех плашек — спросим один раз в конце
        if (btn) { btn.disabled = true; btn.classList.add('busy'); }

        // Плашки идут ПО ОДНОЙ, начиная с самой маленькой. Раньше их пускали по две
        // параллельно — быстрее на пару секунд, но непонятно: часики горели сразу на
        // нескольких, а какая из них сейчас работает, видно не было. Прогон теперь
        // занимает секунды, так что ясная картинка важнее выигрыша: маленькая плашка
        // отрабатывает первой и сразу освобождается, а очередь видна целиком.
        const queue = names.slice().sort(function (a, b) {
            return rowsOfLabel(latestRows, a).length - rowsOfLabel(latestRows, b).length;
        });
        const toggleOf = function (nm) {
            return TOGGLES.find(function (x) { return normLabelName(x.name) === normLabelName(nm); });
        };
        // Все ждущие плашки сразу помечаем часиками — очередь должна быть видна
        // с самого начала, а не появляться по мере дохождения до каждой.
        queue.forEach(function (nm) {
            const t = toggleOf(nm);
            if (t && t.btnEl) setLabelBtnState(t.btnEl, 'queued');
        });

        let finished = 0;
        function progress() {
            renderSyncAllFace(btn, finished + '/' + names.length);
        }
        progress();
        try {
            while (queue.length) {
                const nm = queue.shift();
                const t = toggleOf(nm);
                const r = await bulkApplyLabels(nm, t && t.btnEl, { skipConfirm: true, quiet: true });
                finished++;
                progress();
                if (!r) continue;
                total.put += r.put; total.removed += r.removed;
                total.unconfirmed += r.unconfirmed; total.noThread += r.noThread; total.fail += r.fail;
                total.already += (r.already || 0);
                if (Array.isArray(r.strayIds)) r.strayIds.forEach(function (id) { strayAll.push(id); });
                if (!firstFail && r.firstFail) firstFail = r.firstFail;
            }
        } finally {
            // Прогон мог оборваться — снимаем часики со всех, до кого не дошли.
            names.forEach(function (nm) {
                const t = toggleOf(nm);
                if (t && t.btnEl) setLabelBtnState(t.btnEl, '', nm);
            });
            clearAllRowsSyncing();
            if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
            renderSyncAllFace(btn, '');
            updateSyncMarks();
        }



        // Обновляем список ОДИН раз на весь прогон. Плашки внутри его не трогают
        // (см. opts.quiet в bulkApplyLabels): раньше каждая жала кнопку почты сама, и
        // на семи плашках это было до восьми нажатий подряд.
        if (total.put || total.removed || total.unconfirmed) {
            forceMailListRefresh('прогон всех плашек');
        }

        const report = 'Обновлено плашек: ' + names.length + ' (' + names.join(', ') + '). ' +
            'Поставлено ' + total.put + ', снято ' + total.removed +
            (total.already ? ', уже стояло ' + total.already : '') +
            (total.unconfirmed ? ', не применилось ' + total.unconfirmed : '') +
            (total.noThread ? ', писем не найдено ' + total.noThread + authHint() : '') +
            (total.fail ? ', ошибок ' + total.fail + (firstFail ? ' (' + firstFail + ')' : '') : '') +
            (strayAll.length
                ? '. Снимаю метку ещё с ' + strayAll.length + ' ' +
                  plural(strayAll.length, 'письма', 'писем', 'писем') + ' вне таблицы'
                : '. Лишних меток нет');
        if (total.put || total.removed || total.unconfirmed) {
            showActionToast(report, 'Обновить почту', function () {
                trace('перезагрузка по кнопке в общем отчёте');
                saveTrace();
                try { location.reload(); } catch (e) { /* ignore */ }
            }, total.fail ? 'error' : 'success', 12000);
        } else {
            showToast(report, (total.fail || total.noThread || total.unconfirmed) ? 'error' : 'success');
        }
        cleanupStrays(strayAll);
    }

    // === ЗАГРУЗКА КЭША ===
    // Версия панели, которой посчитан кэш. Записи кэша — это РЕЗУЛЬТАТЫ поиска письма,
    // то есть выводы старой логики. После обновления расширения они живут ещё десять
    // минут (столько кэш считается свежим) и показывают в карточках ровно то, что мы
    // только что починили: «обновил, а всё то же». Поэтому кэш, посчитанный другой
    // версией, при загрузке выбрасываем — строки просто перечитаются заново.
    const CACHE_VERSION_KEY = 'pm_cache_version';

    async function loadCacheFromStorage() {
        try {
            const ver = await chrome.storage.local.get(CACHE_VERSION_KEY);
            if (ver && ver[CACHE_VERSION_KEY] !== PM_VERSION) {
                await chrome.storage.local.remove(STORAGE_KEY);
                await chrome.storage.local.set({ [CACHE_VERSION_KEY]: PM_VERSION });
                if (ver[CACHE_VERSION_KEY]) {
                    console.log('[Проблемные письма] Версия панели изменилась (' +
                        ver[CACHE_VERSION_KEY] + ' → ' + PM_VERSION + ') — найденные ' +
                        'ранее письма перечитаю заново, чтобы карточки не показывали ' +
                        'выводы прежней версии.');
                }
                return {};
            }
        } catch (e) { /* не критично: поработаем со старым кэшем */ }
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY);
            if (result[STORAGE_KEY]) {
                const cache = result[STORAGE_KEY];
                for (const [topic, data] of Object.entries(cache)) {
                    MEMORY_CACHE.results.set(topic, data.info);
                    MEMORY_CACHE.updatedAt.set(topic, data.updatedAt);
                }
                dlog(`📦 Загружено ${Object.keys(cache).length} записей`);
                return cache;
            }
        } catch (err) {
            console.error('❌ Ошибка загрузки кэша:', err);
        }
        return {};
    }

    // Чистка кэша. Записи лежат по номеру строки таблицы, и раньше они накапливались
    // навсегда: строку закрыла коллега или её удалили из таблицы — запись оставалась.
    // Одна запись ≈ 0,7 КБ, лимит chrome.storage.local — 10 МБ, то есть переполнение
    // не завтра, но кэш пишется ЦЕЛИКОМ на каждое сохранение, и лишние тысячи записей
    // просто тормозят запись. Поэтому после каждой загрузки строк выбрасываем всё,
    // чему в таблице уже ничего не соответствует.
    const CACHE_MAX_AGE_MS = 30 * 86400000;   // страховка: записи старше месяца — вон

    function pruneCache(rows) {
        const alive = new Set((rows || []).map(function (r) { return String(r.sheetRow); }));
        const now = Date.now();
        let dropped = 0;
        // Обходим ключи ОБЕИХ карт: у ненайденной строки результат удаляется, а
        // отметка времени остаётся — по ключам results такая запись не вычищалась
        // никогда и копилась до перезагрузки вкладки.
        const keys = new Set(Array.from(MEMORY_CACHE.results.keys())
            .concat(Array.from(MEMORY_CACHE.updatedAt.keys())));
        keys.forEach(function (key) {
            const stale = (now - (MEMORY_CACHE.updatedAt.get(key) || 0)) > CACHE_MAX_AGE_MS;
            // Строки нет в таблице (выполнена или удалена) — запись больше не нужна.
            if (alive.has(key) && !stale) return;
            const had = MEMORY_CACHE.results.has(key);
            MEMORY_CACHE.results.delete(key);
            MEMORY_CACHE.updatedAt.delete(key);
            NOT_FOUND_ROWS.delete(key);
            if (had) dropped++;
        });
        // Слепки синхронизации меток, которых в настройках уже нет, тоже убираем.
        const knownLabels = new Set(labelCfg.names.map(function (n) { return normLabelName(n); }));
        let marksChanged = false;
        Object.keys(labelSyncMarks).forEach(function (key) {
            if (knownLabels.has(key)) return;
            delete labelSyncMarks[key];
            marksChanged = true;
        });
        if (marksChanged) {
            try { chrome.storage.local.set({ [LABEL_SYNC_KEY]: labelSyncMarks }); } catch (e) { /* не критично */ }
        }
        if (dropped) {
            dlog('🧹 Кэш: выброшено записей без строки в таблице —', dropped);
            saveCacheToStorage();
            updateCacheInfo();
        }
        return dropped;
    }

    async function saveCacheNow() {
        cacheSaveTimer = null;
        try {
            const cache = {};
            for (const [topic, info] of MEMORY_CACHE.results) {
                const updatedAt = MEMORY_CACHE.updatedAt.get(topic) || Date.now();
                cache[topic] = { info, updatedAt };
            }
            await chrome.storage.local.set({ [STORAGE_KEY]: cache });
        } catch (err) {
            console.error('❌ Ошибка сохранения кэша:', err);
        }
    }

    // Кэш сохраняется ЦЕЛИКОМ одним куском, а зовут сохранение по строке за раз —
    // на проходе по всей таблице это были десятки полных перезаписей подряд.
    // Копим их и пишем один раз в конце: результат тот же, запись одна.
    let cacheSaveTimer = null;
    const CACHE_SAVE_DELAY = 1000;

    function saveCacheToStorage() {
        if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
        cacheSaveTimer = setTimeout(saveCacheNow, CACHE_SAVE_DELAY);
    }

    // Вкладку закрывают или прячут — дописываем то, что ещё не успело сохраниться.
    function flushCacheSave() {
        if (!cacheSaveTimer) return;
        clearTimeout(cacheSaveTimer);
        saveCacheNow();
    }
    window.addEventListener('pagehide', flushCacheSave);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) flushCacheSave();
    });

    // === ПОИСК В DOM ===
    // Разбор строк списка почты стоит дорого: объединение из шести селекторов по всему
    // списку плюс цепочка из шести селекторов темы НА КАЖДУЮ строку. А зовут этот
    // разбор по строке таблицы за раз — при 94 строках это 94 одинаковых прохода по
    // одной и той же разметке, все в одном тике. Разбираем список ОДИН раз и держим
    // готовый индекс до ближайшего изменения разметки (его ловит наблюдатель) или
    // истечения короткого срока.
    const LIST_INDEX_TTL = 2000;
    let listIndex = null;
    let listIndexAt = 0;

    function invalidateListIndex() {
        listIndex = null;
    }

    function getListIndex() {
        if (listIndex && Date.now() - listIndexAt < LIST_INDEX_TTL) return listIndex;

        const subjectSelectors = [
            '.MessageListItem__subject--Kqkku .Text',
            '.qa-MessagesListSubject .Text',
            '[data-testid="messages-list_subject"] .Text',
            '.mail-MessageSnippet-Subject span',
            '[class*="Subject"] span',
            '[class*="subject"] span'
        ];

        const items = document.querySelectorAll(
            '.qa-MessagesListItem, .MessagesList__item, [data-testid="messages-list_message-item"], .MessageListItem__root--qxe9X, .mail-MessageSnippet, .mail-FolderView-Item'
        );

        const out = [];
        for (const item of items) {
            if (item.offsetParent === null) continue;

            let subject = '';
            for (const selector of subjectSelectors) {
                const el = item.querySelector(selector);
                if (el) {
                    subject = el.textContent.trim();
                    if (subject) break;
                }
            }

            // Без узла темы строку не берём совсем: раньше вместо темы шёл весь
            // текст строки (отправитель + метки + тело), и «совпадением» становилось
            // случайное вхождение — в карточку попадало чужое письмо.
            if (!subject) continue;

            out.push({
                element: item,
                subj: normForMatch(stripRowSubjectTail(subject)),
                date: extractDate(item)
            });
        }

        listIndex = out;
        listIndexAt = Date.now();
        return out;
    }

    function findEmailsByTopic(topic, preview) {
        const want = normForMatch(stripRowSubjectTail(topic));
        const wantPre = normForMatch(preview);
        // Слишком короткую тему по разметке не ищем: «Энергия ООО» встречается в
        // десятке писем, и любой из них подошёл бы.
        if (want.length < 4) return [];
        const result = [];

        for (const entry of getListIndex()) {
            const item = entry.element;
            const subj = entry.subj;
            const subjectHit = subj === want || subj.indexOf(want) !== -1 ||
                (subj.length >= 8 && want.indexOf(subj) !== -1);
            // Знаем начало текста письма — оно должно совпасть тоже: одинаковые темы
            // от одного поставщика различаются только телом.
            let previewOk = true;
            if (subjectHit && wantPre.length >= 8) {
                const got = normForMatch(getRowFirstline(item));
                if (got) {
                    // Сравниваем ВЕСЬ доступный общий префикс, а не первые 40 символов.
                    // Ровно эта ошибка уже была в сверке через почту: письма по шаблону
                    // («Доброй ночи. Водитель прибыл на загрузку …») совпадают первыми
                    // сорока символами дословно, и список отдавал соседнее письмо той
                    // же темы — самое свежее, потому что результаты сортируются по дате.
                    const n = Math.min(wantPre.length, got.length, 200);
                    previewOk = n < 8 || wantPre.slice(0, n) === got.slice(0, n);
                }
            }
            if (subjectHit && previewOk) {
                result.push({ element: item, date: entry.date });
            }
        }

        result.sort((a, b) => {
            const dateA = a.date instanceof Date ? a.date.getTime() : 0;
            const dateB = b.date instanceof Date ? b.date.getTime() : 0;
            return dateB - dateA;
        });
        
        return result.map(item => item.element);
    }

    function extractDate(emailElement) {
        if (!emailElement) return null;
        
        const dateSelectors = [
            '.MessageDate__root--DZJhr .Text',
            '.qa-MessagesListDate .Text',
            '[data-testid="messages-list_message-date"] .Text',
            '.mail-MessageSnippet-Date span',
            '.MessageListItem__date--TmgWc .Text',
            '.mail-MessageSnippet-Info span:last-child'
        ];
        
        for (const selector of dateSelectors) {
            const el = emailElement.querySelector(selector);
            if (el) {
                const text = el.textContent.trim();
                const parsed = tryParseDate(text);
                if (parsed) return parsed;
            }
        }
        return null;
    }

    function tryParseDate(str) {
        if (!str) return null;
        
        let date = new Date(str);
        if (!isNaN(date)) return date;
        
        const ruMonths = {
            'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'май': 4,
            'июн': 5, 'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11
        };
        
        const match = str.match(/(\d{1,2})\s+([а-яa-z]{3,})/i);
        if (match) {
            const day = parseInt(match[1]);
            const monthName = match[2].toLowerCase().substring(0, 3);
            const month = ruMonths[monthName];
            if (month !== undefined && !isNaN(day)) {
                const now = new Date();
                let year = now.getFullYear();
                if (month > now.getMonth()) {
                    year--;
                }
                const parsedDate = new Date(year, month, day);
                if (!isNaN(parsedDate)) return parsedDate;
            }
        }
        
        const match2 = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (match2) {
            const day = parseInt(match2[1]);
            const month = parseInt(match2[2]) - 1;
            const year = parseInt(match2[3]);
            const parsedDate = new Date(year, month, day);
            if (!isNaN(parsedDate)) return parsedDate;
        }
        
        return null;
    }

    // Дата письма ИЗ СТРОКИ списка, в миллисекундах (0 — снять не удалось).
    // Нужна, чтобы различать письма с ОДИНАКОВОЙ темой, пришедшие в разные дни:
    // без неё «показать ветку» открывало первую попавшуюся строку с такой темой.
    // Разбираем сами, а не через tryParseDate: тот при явном годе («25 авг 2025»)
    // год из текста игнорирует и подставляет текущий — как раз у старых писем.
    const ROW_RU_MONTHS = {
        'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'май': 4,
        'июн': 5, 'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11
    };
    const ROW_DATE_SELECTORS = [
        '[data-testid="messages-list_message-date"]',
        '.MessageDate__root--DZJhr',
        '.qa-MessagesListDate',
        '.MessageListItem__date--TmgWc',
        '.mail-MessageSnippet-Date'
    ];

    function startOfDayMs(ms) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    function getRowDateMs(row) {
        if (!row) return 0;
        let text = '';
        for (const sel of ROW_DATE_SELECTORS) {
            let el;
            try { el = row.querySelector(sel); } catch (e) { continue; }
            if (el) {
                text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text) break;
            }
        }
        if (!text) {
            // Узла даты нет — почта диктует её и в aria-label строки (оттуда же её
            // вырезает разбор темы), значит там она тоже есть.
            try {
                const ariaEl = row.closest('[aria-label]');
                text = ariaEl ? String(ariaEl.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() : '';
            } catch (e) { text = ''; }
        }
        if (!text) return 0;

        const today = startOfDayMs(Date.now());
        if (/позавчера/i.test(text)) return today - 2 * 86400000;
        if (/вчера/i.test(text)) return today - 86400000;
        if (/сегодня/i.test(text)) return today;

        // «25 августа 2025» / «25 авг» (год не показан — значит текущий).
        const ru = text.match(/(\d{1,2})\s+([а-яё]{3,})(?:\s+(\d{4}))?/i);
        if (ru) {
            const month = ROW_RU_MONTHS[ru[2].toLowerCase().slice(0, 3)];
            const day = parseInt(ru[1], 10);
            if (month !== undefined && day >= 1 && day <= 31) {
                const now = new Date();
                let year = ru[3] ? parseInt(ru[3], 10) : now.getFullYear();
                // Года нет и месяц ещё не наступил — письмо прошлогоднее.
                if (!ru[3] && month > now.getMonth()) year--;
                return new Date(year, month, day).getTime();
            }
        }
        // «25.08.2026» / «25.08.26» / «25.08»
        const dot = text.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
        if (dot) {
            const day = parseInt(dot[1], 10);
            const month = parseInt(dot[2], 10) - 1;
            if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
                const now = new Date();
                let year = now.getFullYear();
                if (dot[3]) {
                    year = parseInt(dot[3], 10);
                    if (year < 100) year += 2000;
                } else if (month > now.getMonth()) {
                    year--;
                }
                return new Date(year, month, day).getTime();
            }
        }
        // Осталось одно время («10:41») — так почта показывает СЕГОДНЯШНИЕ письма.
        if (/(^|\s)\d{1,2}:\d{2}(\s|$)/.test(text)) return today;
        return 0;
    }

    // Все известные id переписки — для второго прохода поиска строки в списке.
    // Свёрнутая ветка рисует ОДНО представительское письмо, и его id обычно не тот,
    // что у нашего письма, — но это та же переписка.
    function threadIdsOf(info) {
        if (!info) return [];
        const out = [];
        function add(v) { if (v) out.push(String(v)); }
        (Array.isArray(info.mids) ? info.mids : []).forEach(add);
        add(info.shownMid);
        add(info.mid);
        add(info.lastMid);
        add(info.tid);
        return out;
    }

    // Что увидел последний разбор списка. Печатается, когда переход не удался:
    // «ветка не найдена» сама по себе не говорит НИЧЕГО о том, на чём он рвётся —
    // не нашлось строк, не совпали id, не разобрались даты или не подошла тема.
    let FIND_DIAG = null;

    // Печатаем ТЕКСТОМ, а не объектом: консоль сворачивает объект в «Object», и
    // диагностика, ради которой всё затевалось, остаётся нераскрытой.
    function printFindDiag(where) {
        if (!FIND_DIAG) return;
        try {
            const lines = Object.keys(FIND_DIAG).map(function (k) {
                return '    ' + k + ': ' + String(FIND_DIAG[k]);
            });
            console.warn('[Проблемные письма] Разбор списка при переходе (' + where + '):\n' +
                         lines.join('\n'));
        } catch (e) { /* диагностика не должна ничего ломать */ }
    }

    // Что карточка показывает вместо начала текста, когда почта его не вернула.
    //
    // Было «письмо найдено» — и это врало по смыслу: надпись стояла ровно в том месте,
    // где идёт текст письма, и читалась как его содержимое («что значит „письмо
    // найдено“ в теле письма?»). Сообщать «мы нашли письмо» в слоте текста незачем:
    // раз карточка показывает дату, автора и число писем, письмо очевидно найдено.
    // Честная подпись здесь одна — что текста нет.
    //
    // ТОЛЬКО для показа человеку: в данные (info.lastPreview) эта строка не попадает —
    // иначе её потом принимают за текст письма и сравнивают со строками списка.
    const PREVIEW_MISSING_TEXT = '(без текста)';
    // Прежнее значение — чтобы отсеять его из кэша, сохранённого старой версией.
    const PREVIEW_MISSING_LEGACY = 'письмо найдено';

    // Настоящий текст или пусто. Отсеивает заглушку, в том числе приехавшую из кэша,
    // сохранённого прежней версией панели.
    function notPreviewPlaceholder(v) {
        const s = String(v == null ? '' : v).trim();
        if (!s || s === PREVIEW_MISSING_TEXT || s === PREVIEW_MISSING_LEGACY) return '';
        return s;
    }

    // Приметы нужной переписки для сопоставления со строками списка: время письма
    // (различает однотемные письма разных дней) и начало текста (различает однотемные
    // письма одного дня). Берём из того же info, что рисует карточку.
    function navMatchOpts(info) {
        // lastPreview — начало текста ИМЕННО показанного письма строки (см. shown).
        //
        // Заглушку карточки за текст письма не принимаем. Раньше проверка стояла ПОСЛЕ
        // выбора источника и просто обнуляла результат — то есть при заглушке строка
        // теряла начало текста СОВСЕМ, хотя в колонке «Текст письма» оно лежало. А это
        // третья примета строки (после темы и даты) и единственная, что различает
        // однотемные письма одного дня. Теперь заглушка отбрасывается ДО выбора, и
        // настоящий текст из таблицы доходит.
        const preview = notPreviewPlaceholder(info && info.lastPreview) ||
                        notPreviewPlaceholder(info && info.preview);
        // В списке у строки стоит дата ПОСЛЕДНЕГО письма ветки, поэтому важно, откуда
        // взято время.
        //   lastTs из ответа почты — время последнего письма ветки: сверяем день в день;
        //   ts: из колонки «ID письма», дата письма из таблицы, firstTs — время того
        //   письма, которое ЗАВЕЛИ на контроль, то есть начала переписки: строка списка
        //   будет не раньше него, но запросто позже — на все ответы, пришедшие с тех
        //   пор. Сверять «день в день» нельзя, иначе живая переписка отбраковывается.
        // lastTsFromSheet ставит обработчик клика, когда ответа почты ещё нет и время
        // взято из таблицы: по смыслу это НЕ время последнего письма.
        const fromSheet = !!(info && info.lastTsFromSheet);
        const lastTs = (info && info.lastTs && !fromSheet) ? info.lastTs : 0;
        const startTs = (fromSheet ? (info && info.lastTs) : 0) ||
                        (info && (info.rowTs || info.firstTs)) || 0;
        return {
            ts: lastTs || startTs,
            tsExact: !!lastTs,
            preview: preview
        };
    }

    function extractAuthor(emailElement) {
        const authorElement = 
            emailElement.querySelector('.SenderName__name--5LLnO .Text') ||
            emailElement.querySelector('.qa-SenderName .Text') ||
            emailElement.querySelector('[data-testid="message-common_sender-name"] .Text') ||
            emailElement.querySelector('.mail-MessageSnippet-From span');

        if (authorElement) {
            return authorElement.textContent.trim();
        }
        return 'Неизвестный';
    }

    function extractPreview(emailElement) {
        const previewElement = 
            emailElement.querySelector('.MessageListItem__firstline--IuqXQ .Text') ||
            emailElement.querySelector('[data-testid="messages-list-firstline_root"] .Text') ||
            emailElement.querySelector('.mail-MessageSnippet-Content span');

        if (previewElement) {
            let preview = previewElement.textContent.trim();
            if (preview.length > 100) {
                preview = preview.substring(0, 100) + '...';
            }
            return preview;
        }
        return null;
    }

    function extractThreadCount(emailElement) {
        const countElement = 
            emailElement.querySelector('.ThreadCounter__root--DkL7Z .Button2-Text') ||
            emailElement.querySelector('.qa-MessagesListThreadCounter .Button2-Text');

        if (countElement) {
            const count = parseInt(countElement.textContent.trim(), 10);
            if (!isNaN(count)) return count;
        }
        return 0;
    }

    function getEmailInfo(email) {
        if (!email) return null;
        
        const count = extractThreadCount(email) || 1;
        const author = extractAuthor(email);
        const dateObj = extractDate(email);
        const preview = extractPreview(email);

        let dateStr = 'дата неизвестна';
        if (dateObj instanceof Date && !isNaN(dateObj)) {
            // В списке письма нет времени — показываем только дату, без фейкового 00:00.
            const p = function (n) { return String(n).padStart(2, '0'); };
            dateStr = p(dateObj.getDate()) + '.' + p(dateObj.getMonth() + 1) + '.' + dateObj.getFullYear();
        }

        return {
            count: count,
            lastDate: dateStr,
            lastAuthor: author || 'неизвестный',
            lastPreview: preview || ''
        };
    }

    // === ОСНОВНАЯ ФУНКЦИЯ - МГНОВЕННОЕ ОТОБРАЖЕНИЕ ===
    // Кэш и карточки ключуются по sheetRow (номеру строки), а НЕ по теме: у разных
    // строк тема часто буквально совпадает («Энергия ООО», «СТАИРС ПРОФИ ООО» и
    // т.п.) — при ключе по теме фоновое обновление ОДНОЙ строки перезаписывало общий
    // кэш и подсовывало другой строке чужую переписку (неверные дата/автор/ветка).
    function getEmailInfoSmart(sheetRow, topic, preview, mailId) {
        const key = String(sheetRow);
        // 1. СНАЧАЛА проверяем кэш в памяти (мгновенно)
        if (MEMORY_CACHE.results.has(key)) {
            return MEMORY_CACHE.results.get(key);
        }

        // 2. Ищем в DOM — в ВИДИМОМ списке писем, по теме и началу текста.
        //    Это самый первый источник карточки, ещё до запроса к почте, и именно он
        //    показывал не то письмо: при одинаковой теме список отдаёт самое свежее.
        //    Поэтому, если у строки сохранён id письма, берём из списка строку С ЭТИМ
        //    id, а не первую подходящую по теме.
        const emails = findEmailsByTopic(topic, preview);
        if (emails.length > 0) {
            let picked = emails[0];
            const want = parseStoredIds(mailId);
            if (want.any && emails.length > 1) {
                const exact = emails.find(function (el) {
                    const ids = collectRowMessageIds(el) || [];
                    return ids.some(function (x) { return want.all.has(stripThreadPrefix(x)); });
                });
                if (exact) picked = exact;
            }
            const info = getEmailInfo(picked);
            MEMORY_CACHE.results.set(key, info);
            MEMORY_CACHE.updatedAt.set(key, Date.now());
            saveCacheToStorage();
            updateCacheInfo();
            return info;
        }

        return null;
    }

    // Как часто перезапрашивать тему у API (мс). Свежий кэш не дёргает сеть.
    // Заведомо БОЛЬШЕ периода опроса таблицы в background.js (5 минут): раньше здесь
    // стояло 3 минуты, и к моменту каждого тика будильника кэш каждой строки был уже
    // просрочен — то есть не срабатывал никогда, и панель переискивала всё заново.
    const API_TTL = 600000; // 10 минут

    // Отдельный срок для отрицательного ответа («письма в этом ящике нет»). Он длиннее
    // положительного: письмо, которого в ящике нет, само там не появится, а стоит такой
    // поиск дороже всех остальных — его не подтверждает ни глобальный поиск, ни одна
    // папка, поэтому обход идёт по всем папкам целиком. Раньше срока не было вовсе:
    // выход по кэшу требовал наличия результата, а у ненайденной строки результат как
    // раз удаляется — и самые дорогие строки переискивались каждый проход.
    const NEG_TTL = 1800000; // 30 минут

    // === ФОНОВОЕ ОБНОВЛЕНИЕ (асинхронное) ===
    // Сначала пробуем API Яндекса (ищет по всему ящику, отдаёт tid для перехода),
    // при неудаче — старый поиск в DOM (видит только загруженные письма).
    async function refreshTopicAsync(sheetRow, topic, number, dateAdded, force, mailId, preview) {
        const key = String(sheetRow);
        // Не бьём по сети, если тема обновлялась недавно.
        const cachedInfo = MEMORY_CACHE.results.get(key);
        const age = Date.now() - (MEMORY_CACHE.updatedAt.get(key) || 0);
        if (!force && cachedInfo && age < API_TTL) {
            return cachedInfo;
        }
        // Недавно уже искали и честно не нашли — не повторяем самый дорогой поиск.
        // Карточка такой строки уже нарисована как «не найдено» (NOT_FOUND_ROWS
        // проверяется в render), поэтому возвращаем null молча.
        if (!force && !cachedInfo && NOT_FOUND_ROWS.has(key) && age < NEG_TTL) {
            return null;
        }

        let info = null;

        try {
            const prefer = parseStoredIds(mailId);
            info = await apiGetInfo(topic, number, dateAdded, prefer.any ? prefer : null, preview);
        } catch (e) {
            dlog(`⚠️ API не ответил для "${topic}": ${e.message}, ищу в DOM`);
        }

        if (!info) {
            // Запасной путь — поиск по разметке открытого списка. Тема строки должна
            // совпасть с темой строки списка (а не «встретиться где-то в её тексте»).
            const emails = findEmailsByTopic(topic, preview);
            if (emails.length > 0) {
                info = getEmailInfo(emails[0]);
            }
        }

        if (!info) {
            // Письма в этом ящике нет. Раньше здесь был просто выход — и карточка
            // продолжала показывать ПРЕЖНИЙ результат, в том числе ошибочный,
            // найденный старой (менее строгой) версией поиска: «в таблице одно письмо,
            // а в карточке чужое тело и чужой автор». Теперь устаревший результат
            // выбрасываем и помечаем строку как «не найдено».
            MEMORY_CACHE.results.delete(key);
            MEMORY_CACHE.updatedAt.set(key, Date.now());
            NOT_FOUND_ROWS.add(key);
            saveCacheToStorage();
            updateCardForTopic(sheetRow, null);
            updateCacheInfo();
            return null;
        }
        NOT_FOUND_ROWS.delete(key);

        const oldInfo = MEMORY_CACHE.results.get(key);
        const changed = !oldInfo ||
                       oldInfo.count !== info.count ||
                       oldInfo.lastDate !== info.lastDate ||
                       oldInfo.lastAuthor !== info.lastAuthor ||
                       oldInfo.tid !== info.tid;

        MEMORY_CACHE.results.set(key, info);
        MEMORY_CACHE.updatedAt.set(key, Date.now());

        if (changed) {
            dlog(`🔄 Обновлена информация для "${topic}"`);
            saveCacheToStorage();
            updateCacheInfo();
        }
        return info;
    }

    // === ОБНОВЛЕНИЕ ВСЕХ ТЕМ (асинхронное, фоновое) ===
    // Запросы к API идут пачками (ограниченная параллельность), карточки
    // обновляются по мере готовности каждой темы.
    const REFRESH_CONCURRENCY = 5;

    async function refreshAllTopics(force) {
        if (isUpdating) return;
        if (latestRows.length === 0) return;
        // Эта функция ищет в почте письмо ДЛЯ КАЖДОЙ строки таблицы — чтобы показать
        // в карточке дату, автора и начало текста. При закрытой панели карточек не
        // видно, а запросы всё равно уходили: на загрузке почты и при каждом новом
        // письме в списке это десятки запросов впустую (при 94 строках — 94 поиска).
        // Панель откроют — тогда и поищем, там же стоит autoRefresh(true).
        if (!isPanelOpen) {
            dlog('⏸️ Панель закрыта — карточки не обновляем, счётчики уже посчитаны по таблице');
            return;
        }
        // Вкладка почты в фоне: карточек тоже никто не видит. Раньше сюда смотрели
        // только через isPanelOpen, и свёрнутая вкладка с открытой панелью продолжала
        // раз в пять минут переискивать всю таблицу. Вернутся на вкладку — autoRefresh
        // по visibilitychange всё обновит.
        if (document.hidden && !force) {
            dlog('⏸️ Вкладка в фоне — карточки не обновляем');
            return;
        }

        isUpdating = true;
        try {
            const queue = latestRows.slice();

            async function worker() {
                while (queue.length) {
                    const row = queue.shift();
                    const info = await refreshTopicAsync(row.sheetRow, row.topic, row.number, row.dateAdded, force, row.mailId, row.preview);
                    if (info) updateCardForTopic(row.sheetRow, info);
                }
            }

            const workers = [];
            for (let i = 0; i < Math.min(REFRESH_CONCURRENCY, latestRows.length); i++) {
                workers.push(worker());
            }
            await Promise.all(workers);
        } finally {
            isUpdating = false;
            updateCacheInfo();
        }
    }

    function updateCardForTopic(sheetRow, info) {
        const card = listEl.querySelector('.pm-card[data-row-number="' + cssEscape(String(sheetRow)) + '"]');
        if (!card) return;
        const emailBlock = card.querySelector('.pm-last-email');
        const badge = card.querySelector('.pm-thread-badge');
        if (emailBlock) updateEmailBlock(emailBlock, info, card.dataset.topic || '');
        if (badge) paintThreadBadge(badge, info);
    }

    // === ЧТО СЕЙЧАС ОБНОВЛЯЕТСЯ ===
    // Прогон меток идёт по плашкам, а внутри плашки — по строкам. Раньше видно было
    // только «кнопка нажата», и на большой плашке казалось, что расширение зависло.
    // Теперь состояние показывается там, где человек его ищет: на самой плашке и на
    // кружке слева от темы. Обработалась строка — её кружок сразу освобождается,
    // с ней можно работать, не дожидаясь остальных.
    const SYNCING_ROWS = new Set();

    function badgeForRow(sheetRow) {
        return listEl.querySelector('.pm-card[data-row-number="' +
            cssEscape(String(sheetRow)) + '"] .pm-thread-badge');
    }

    function setRowsSyncing(sheetRows, on) {
        (sheetRows || []).forEach(function (rowNum) {
            const key = String(rowNum);
            if (on) SYNCING_ROWS.add(key); else SYNCING_ROWS.delete(key);
            const badge = badgeForRow(key);
            if (!badge) return;
            if (on) {
                badge.classList.add('syncing');
                badge.textContent = '⏳';
                badge.title = 'Обновляю метку этого письма…';
            } else {
                badge.classList.remove('syncing');
                paintThreadBadge(badge, MEMORY_CACHE.results.get(key) || null);
            }
        });
    }

    function clearAllRowsSyncing() {
        setRowsSyncing(Array.from(SYNCING_ROWS), false);
        SYNCING_ROWS.clear();
    }

    // Состояние плашки: '' — обычная, 'queued' — ждёт своей очереди (часики стоят),
    // 'working' — сейчас обрабатывается (часики крутятся).
    function setLabelBtnState(btnEl, state, labelName) {
        if (!btnEl) return;
        btnEl.classList.remove('queued', 'working');
        if (state === 'queued') {
            btnEl.classList.add('queued');
            btnEl.textContent = '⏳';
            btnEl.title = 'В очереди на обновление меток';
        } else if (state === 'working') {
            btnEl.classList.add('working');
            btnEl.textContent = '⏳';
            btnEl.title = 'Обновляю метки плашки…';
        } else {
            btnEl.textContent = '🏷️';
            btnEl.title = labelName
                ? 'Синхронизировать метку «' + labelName + '» с таблицей'
                : btnEl.title;
        }
    }

    // Кружок слева от темы. Нашли переписку — число писем (или ✉), не нашли —
    // красный «✕»: сразу видно, какие письма расширение не пометило и почему.
    function paintThreadBadge(badge, info) {
        // Строка сейчас обрабатывается — её кружок занят часиками, не перебиваем.
        if (badge.classList.contains('syncing')) return;
        if (info) {
            badge.textContent = info.count > 1 ? String(info.count) : '✉';
            badge.classList.remove('notfound');
            badge.title = '';
        } else {
            badge.textContent = '✕';
            badge.classList.add('notfound');
            badge.title = 'Письма нет в этой почте — метка на него не ставилась';
        }
    }

    // Безопасное экранирование значения для селектора [data-topic="…"].
    // Сколько карточек сейчас видно в списке.
    //
    // Раньше считалось CSS-селектором по ПОДСТРОКЕ в сериализованном атрибуте style.
    // Держится это на том, что браузер запишет свойство ровно как «display: none»,
    // с пробелом после двоеточия; запишет иначе — счётчик молча начнёт врать.
    // Смотрим на само свойство, а не на его текстовую запись.
    function visibleCardCount() {
        try {
            return Array.from(listEl.querySelectorAll('.pm-card')).filter(function (c) {
                return c.style.display !== 'none';
            }).length;
        } catch (e) { return 0; }
    }

    function cssEscape(value) {
        if (window.CSS && CSS.escape) return CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    // «Extension context invalidated» — техническая ошибка Chrome, а не баг в логике:
    // возникает, когда расширение обновили/перезагрузили в chrome://extensions, а эта
    // конкретная вкладка почты продолжает работать со СТАРЫМ инжектированным скриптом,
    // у которого связь с расширением разорвана. Любой вызов chrome.* API после этого
    // валится с этой фразой. Лечится только перезагрузкой вкладки (F5) — сообщаем это
    // прямо пользователю вместо непонятного технического текста.
    function friendlyErrorMessage(e) {
        const raw = String((e && e.message) || e || '');
        if (/Extension context invalidated/i.test(raw)) {
            return 'расширение обновилось — обновите эту вкладку почты (F5) и повторите';
        }
        return raw;
    }

    // Всплывающее уведомление в панели (вместо alert).
    function showToast(message, type) {
        let wrap = shadow.querySelector('.pm-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'pm-toast-wrap';
            shadow.appendChild(wrap);
        }
        const toast = document.createElement('div');
        toast.className = 'pm-toast' + (type ? ' ' + type : '');
        toast.textContent = message;
        wrap.appendChild(toast);
        setTimeout(function () {
            toast.style.transition = 'opacity 0.3s';
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 2600);
    }

    // Тост с кнопкой действия (например, «Отменить»). Кнопка живёт заданное время,
    // затем тост уезжает. Клик по кнопке вызывает onAction и сразу убирает тост.
    // Возвращает функцию принудительного закрытия.
    function showActionToast(message, actionLabel, onAction, type, timeoutMs) {
        let wrap = shadow.querySelector('.pm-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'pm-toast-wrap';
            shadow.appendChild(wrap);
        }
        const toast = document.createElement('div');
        toast.className = 'pm-toast' + (type ? ' ' + type : '');
        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        let closed = false;
        function dismiss() {
            if (closed) return;
            closed = true;
            toast.style.transition = 'opacity 0.3s';
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }

        if (actionLabel && typeof onAction === 'function') {
            const btn = document.createElement('button');
            btn.className = 'pm-toast-action';
            btn.textContent = actionLabel;
            btn.onclick = function () {
                dismiss();
                onAction();
            };
            toast.appendChild(btn);
        }

        wrap.appendChild(toast);
        setTimeout(dismiss, timeoutMs || 6000);
        return dismiss;
    }

    // Модальное подтверждение в Shadow DOM (вместо confirm). Возвращает Promise<boolean>.
    function pmConfirm(message) {
        return new Promise(function (resolve) {
            const overlay = document.createElement('div');
            overlay.className = 'pm-modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'pm-modal';

            const text = document.createElement('div');
            text.className = 'pm-modal-text';
            text.textContent = message;

            const actions = document.createElement('div');
            actions.className = 'pm-modal-actions';

            const cancel = document.createElement('button');
            cancel.className = 'pm-btn pm-btn-outline';
            cancel.textContent = 'Отмена';

            const ok = document.createElement('button');
            ok.className = 'pm-btn pm-btn-success';
            ok.textContent = 'Да';

            function close(result) {
                overlay.remove();
                resolve(result);
            }
            cancel.onclick = function () { close(false); };
            ok.onclick = function () { close(true); };
            overlay.onclick = function (e) { if (e.target === overlay) close(false); };

            actions.appendChild(cancel);
            actions.appendChild(ok);
            modal.appendChild(text);
            modal.appendChild(actions);
            overlay.appendChild(modal);
            shadow.appendChild(overlay);
            ok.focus();
        });
    }

    // === НАБЛЮДАТЕЛЬ ===
    function startObserver() {
        if (observer) {
            observer.disconnect();
        }
        
        observer = new MutationObserver(function(mutations) {
            let hasNewEmails = false;
            
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.matches && (
                                node.matches('.qa-MessagesListItem') ||
                                node.matches('.MessagesList__item') ||
                                node.matches('.mail-MessageSnippet') ||
                                node.matches('.MessageListItem__root--qxe9X') ||
                                node.querySelector && node.querySelector('.qa-MessagesListItem, .MessagesList__item, .mail-MessageSnippet')
                            )) {
                                hasNewEmails = true;
                                break;
                            }
                        }
                    }
                }
                if (hasNewEmails) break;
            }
            
            if (hasNewEmails) {
                // Разметка списка изменилась — построенный по ней индекс устарел.
                invalidateListIndex();
                // Список писем виртуализирован: прокрутка добавляет узлы непрерывно,
                // и обычный дебаунс сбрасывался снова и снова — при долгой прокрутке
                // не срабатывал вообще. Держим предельный срок: не откладываем дольше
                // OBSERVER_MAX_WAIT от первого изменения.
                if (!observerFirstHitAt) observerFirstHitAt = Date.now();
                const waited = Date.now() - observerFirstHitAt;
                if (updateTimeout && waited < OBSERVER_MAX_WAIT) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
                if (!updateTimeout) {
                    const delay = Math.max(0, Math.min(OBSERVER_DEBOUNCE, OBSERVER_MAX_WAIT - waited));
                    updateTimeout = setTimeout(() => {
                        updateTimeout = null;
                        observerFirstHitAt = 0;
                        refreshAllTopics();
                    }, delay);
                }
            }
        });

        // За разметкой почты следим ТОЛЬКО при открытой панели: при закрытой
        // refreshAllTopics всё равно сразу выходит, то есть весь обход мутаций
        // (а в почте их сотни в секунду при прокрутке) уходил впустую.
        const container = document.querySelector('.MessagesList, .mail-FolderView, [class*="MessagesList"]');
        observer.observe(container || document.body, {
            childList: true,
            // Без контейнера списка не подписываемся на всё поддерево body: в почте
            // это самый горячий узел страницы. Верхнего уровня достаточно, чтобы
            // поймать появление самого списка, а как только он появится —
            // переподключимся к нему (см. ensureObserver).
            subtree: !!container,
            attributes: false
        });
        observerContainer = container || null;
    }

    const OBSERVER_DEBOUNCE = 500;
    const OBSERVER_MAX_WAIT = 3000;
    let observerFirstHitAt = 0;
    let observerContainer = null;

    function stopObserver() {
        if (observer) { observer.disconnect(); observer = null; }
        if (updateTimeout) { clearTimeout(updateTimeout); updateTimeout = null; }
        observerFirstHitAt = 0;
        observerContainer = null;
    }

    // Подключает наблюдателя, когда панель открыта, и отключает, когда закрыта.
    // Заодно перецепляется на контейнер списка, если тот появился уже после запуска
    // (почта дорисовывает его не сразу) или сменился при переходе между папками.
    function ensureObserver() {
        if (!isPanelOpen) { stopObserver(); return; }
        const container = document.querySelector('.MessagesList, .mail-FolderView, [class*="MessagesList"]');
        if (observer && container === observerContainer) return;
        startObserver();
    }

    // Переход к письму/ветке. Портировано из ветки jullichart-web-patch-1obnovlenie
    // (PR #1): вместо грубого поиска по теме — точный переход по id письма, доскролл
    // виртуализированного списка до ветки и разворот ветки inline, чтобы список писем
    // не пропадал с экрана.
    // === ФУНКЦИИ ПЕРЕХОДА К ВЕТКЕ С ПРИНУДИТЕЛЬНЫМ СКРОЛЛОМ И РАЗВОРОТОМ ===

    // Ищет ближайшего скроллящегося родителя элемента (контейнер списка писем)
    function getScrollableAncestor(el) {
        let node = el && el.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            try {
                const oy = getComputedStyle(node).overflowY;
                if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 20) {
                    return node;
                }
            } catch (e) {}
            node = node.parentElement;
        }
        return null;
    }

    // Ищет в боковом меню Яндекса ссылку на папку по её fid (id папки из API).
    // Нужно, чтобы в сплошном списке переключиться на папку ветки, не открывая письмо.
    function findFolderLinkByFid(fid) {
        if (!fid) return null;
        const idStr = String(fid);
        // 1) Точное совпадение по data-атрибутам
        const dataMatch = document.querySelector(
            '[data-fid="' + idStr + '"], [data-id="' + idStr + '"], [data-folder-id="' + idStr + '"]'
        );
        if (dataMatch) {
            return dataMatch.closest('a, [role="link"], [role="treeitem"], [class*="FolderList"], [class*="folder"]') || dataMatch;
        }
        // 2) Поиск по href, содержащему fid, среди ссылок на папки
        const links = document.querySelectorAll('a[href]');
        for (const el of links) {
            const href = el.getAttribute('href') || '';
            if (/folder/i.test(href) &&
                (href.indexOf('/' + idStr) !== -1 || href.indexOf('=' + idStr) !== -1 ||
                 new RegExp('\\b' + idStr + '\\b').test(href))) {
                return el;
            }
        }
        return null;
    }

    // Проверяет, является ли ссылка на папку текущей активной
    function isActiveFolderLink(el) {
        if (!el) return false;
        let node = el;
        for (let i = 0; i < 3 && node; i++) {
            const cls = String(node.className || '');
            if (/active|current|selected|_checked/i.test(cls)) return true;
            if (node.getAttribute && node.getAttribute('aria-current') === 'true') return true;
            node = node.parentElement;
        }
        return false;
    }

    // Определяет режим отображения почты.
    // true  — 3-панельный (список слева/сверху + область чтения): строка списка узкая.
    // false — сплошной список на всю ширину: строка широкая.
    // Виден ли СЕЙЧАС список писем (хотя бы одна строка). Когда пользователь открыл
    // конкретное письмо на весь экран (список свёрнут/не отрисован совсем), это false —
    // и тогда полагаться на «текущий список» нельзя: скроллить нечего, expand искать негде.
    function hasMessageListVisible() {
        return !!document.querySelector(
            '.qa-MessagesListItem, [class*="MessageListItem"], [class*="MessagesListItem"], ' +
            '.mail-MessageSnippet, .mail-FolderView-Item'
        );
    }

    // Докручивает список писем Яндекса, пока в него не подгрузится нужная ветка.
    // Виртуализированный список рендерит только видимые письма, поэтому далёкую
    // ветку надо «доскроллить». onDone(foundElement|null) — колбэк с результатом.
    //
    // РАНЬШЕ здесь была отсечка по числу попыток (25, ~5 сек) — в большой папке
    // (тысячи писем) старое письмо физически не успевало долистаться за 5 секунд,
    // скролл обрывался «не найдено», и код проваливался в хеш-переход по id, который
    // открывает ОДНО письмо, а не ветку — пользователь видел именно это. Отсечки по
    // времени/числу попыток больше НЕТ: останавливаемся только когда список реально
    // упёрся в конец и дальше грузить нечего (это единственный законный повод сдаться).
    // SAFETY_CAP — не пользовательский лимит, а защита от вечного цикла на случай
    // бага (список технически никогда не «упирается»); в норме недостижим.
    function scrollListToFindThread(topic, info, onDone) {
        let container = null;
        let attempts = 0;
        // Пять-шесть экранов прокрутки — и хватит. Раньше предел был 6000 попыток
        // (это четверть часа кручения): в большой папке казалось, что расширение
        // зависло, а заканчивалось всё равно поиском. Лучше сразу поиском.
        const MAX_SCROLL_STEPS = 6;
        let lastScrollTop = -1;
        let stuckCount = 0;

        const hints = navMatchOpts(info);
        const rowMid = (info && (info.shownMid || info.mid)) ? String(info.shownMid || info.mid) : '';

        function step() {
            const found = findMessageInList(topic, rowMid || (info && (info.tid || info.mid)),
                                            threadIdsOf(info),
                                            Object.assign({ strictDay: true }, hints));
            if (found) { onDone(found); return; }

            if (!container) {
                const anyItem = document.querySelector(
                    '.qa-MessagesListItem, [class*="MessageListItem"], [class*="MessagesListItem"], ' +
                    '.mail-MessageSnippet, .mail-FolderView-Item'
                );
                container = getScrollableAncestor(anyItem) ||
                            document.querySelector('[class*="MessagesList"]') ||
                            document.scrollingElement;
            }
            if (!container) { onDone(null); return; }

            const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
            // Список перестал прокручиваться (уперлись в дно и ничего нового не грузится).
            // Порог поднят с 2 до 4 — виртуализированному списку иногда нужно чуть
            // больше времени, чтобы дозагрузить следующую порцию писем с сервера.
            if (container.scrollTop === lastScrollTop) { stuckCount++; } else { stuckCount = 0; }
            lastScrollTop = container.scrollTop;

            if (attempts >= MAX_SCROLL_STEPS || (atBottom && stuckCount >= 2)) {
                dlog(`📨 Прокрутили ${attempts} экранов и не нашли — дальше поиском`);
                onDone(null);
                return;
            }

            attempts++;
            const delta = Math.max(300, container.clientHeight * 0.85);
            container.scrollTop += delta;
            setTimeout(step, 150);
        }

        step();
    }

    // «Показать ветку». Показываем переписку только СПИСКОМ: строкой в текущем
    // списке, переключением на её папку или поиском почты. Письмо при этом не
    // открывается — иначе почта показывает одно сообщение из середины ветки.
    function openThread(topic, info) {
        dlog(`📨 openThread (ветка): "${topic}"`, info);
        // Адрес на момент клика: по нему поймём, что человек ушёл в другое место, пока
        // шли отложенные шаги (см. abortIfUserTookOver).
        const navFrom = navStart();

        function expandFound(el) {
            scrollToMessage(el);
            setTimeout(function () { expandThreadInList(el); }, 300);
        }

        // Хеш-перехода (#/message/<id>) здесь больше нет вообще. В этой сборке почты
        // он открывает не переписку, а ОДНО сохранённое письмо из её середины: сверху
        // вместо темы «(Без темы)», остальные письма под «Ещё N писем». Так ведёт себя
        // и переход по id письма, и переход по id ветки. Показываем ветку только тем,
        // что заведомо показывает список: строкой в списке, папкой или поиском почты.

        // Точный id письма ЭТОЙ СТРОКИ (не последнего письма ветки). По нему письмо и
        // ищется в списке, и открывается напрямую, если в списке его нет.
        const rowMid = (info && (info.shownMid || info.mid)) ? String(info.shownMid || info.mid) : '';

        // 1) Если ветка уже видна в текущем списке — разворачиваем её inline со скроллом.
        //    Сначала строго по id письма строки (по теме находилось не то письмо), затем
        //    по остальным id ветки: свёрнутая ветка рисует в списке ОДНО письмо, и его
        //    id обычно не наш — но переписка та же, и разворачивать надо эту строку.
        const hints = navMatchOpts(info);
        // strictDay: за этим шагом есть ещё шаги — строку другого дня пропускаем.
        const found = findMessageInList(topic, rowMid || (info && (info.tid || info.mid)),
                                        threadIdsOf(info),
                                        Object.assign({ strictDay: true }, hints));
        if (found) {
            dlog(`📨 Письмо найдено в списке — разворачиваем ветку inline`);
            expandFound(found);
            return;
        }

        // 1.5) Насколько ветка «старая». Возраст считаем по ПОСЛЕДНЕМУ письму, а не
        // по первому: список писем отсортирован по последнему сообщению, поэтому
        // переписка, начатая полгода назад, но с ответом сегодня, лежит в самом верху
        // папки. По firstTs она считалась «старой» и переход сразу уходил в поиск —
        // это и был случай «я просто во Входящих, а оно вбило тему в поисковую строку».
        // Старую ветку не долистываем руками: в большой папке это минуты скролла.
        // Шесть дней, а не десять: поиск снова находит нужное письмо (тема уходит
        // в кавычках, «-» больше не оператор исключения), поэтому отдавать ему ветку
        // можно раньше — прокрутка папки всё равно осиливает лишь несколько экранов.
        const OLD_THREAD_DAYS = 6;
        // Якорь возраста ищем в трёх местах. Раньше брали только время писем из
        // ответа поиска — а его может не быть вовсе: панель ещё не успела обновить
        // строку, или колонка «ID письма» с меткой ts: у сотрудника выключена. Тогда
        // возраст считался неизвестным, ветка проходила как свежая и открывалась
        // переходом по id — то самое «у меня нормально, а у коллеги через раз».
        // Дата письма из таблицы есть всегда: это обязательная колонка.
        let anchorTs = (info && (info.lastTs || info.firstTs)) || 0;
        if (!anchorTs && info && info.rowTs) anchorTs = info.rowTs;
        const ageMs = anchorTs ? (Date.now() - anchorTs) : null;
        const isOldThread = ageMs != null && ageMs > OLD_THREAD_DAYS * 86400000;

        // Старую ветку показываем ТОЛЬКО через поисковую строку почты — списком
        // результатов. Точный переход по id для неё не годится: почта открывает не
        // ветку целиком, а одно сохранённое письмо из середины переписки, и сверху
        // вместо темы висит «(Без темы)» (у ответа своей темы нет), а остальные
        // письма прячутся под «Ещё N писем». Поиск же показывает всю переписку
        // строками, из которых видно и тему, и метки, и кто что писал.
        if (isOldThread) {
            dlog(`📨 Последнему письму больше ${OLD_THREAD_DAYS} дней — показываем поиском`);
            searchAndScrollToMessage(topic, info, false, true);
            return;
        }

        // 2) Ветки нет в видимом списке. Порядок действий один и в сплошном списке, и
        //    в 3-панельном режиме, и он же — от точного к грубому:
        //      папка ветки → точный переход по id → и только в самом конце поиск
        //      по тексту темы (он находит ПЕРВЫЙ похожий разговор, а нам нужен наш).
        //    НЕ навигируем на #/message/<mid> последнего письма — иначе в режиме
        //    области чтения открывалось бы последнее письмо вместо ветки.

        // Крайний фолбэк — поиск почты. Хеш-перехода здесь больше нет: в этой сборке
        // он открывает одно сохранённое письмо из середины переписки («(Без темы)»
        // сверху), причём и по id письма, и по id ветки. Именно он и давал разное
        // поведение у разных сотрудников — «через раз».
        function searchFallback() {
            if (abortIfUserTookOver(navFrom, 'Поиск письма')) return;
            dlog(`📨 Ветку в папке не нашли — показываем поиском почты`);
            // В списке не нашлось — говорим, на чём именно разбор остановился.
            printFindDiag('в списке до поиска');
            searchAndScrollToMessage(topic, info, false, true);
        }

        function scrollCurrentFolderThenExpand() {
            scrollListToFindThread(topic, info, function (el) {
                if (el) {
                    dlog(`📨 Ветка догрузилась при скролле — разворачиваем inline`);
                    expandFound(el);
                } else {
                    searchFallback();
                }
            });
        }

        // Что делаем, когда список нужной папки уже на экране.
        function lookInFolder() {
            dlog(`📨 Скроллим папку до ветки`);
            scrollCurrentFolderThenExpand();
        }

        // Переключаемся на папку ветки (клик в боковом меню), если папка другая ИЛИ
        // список сейчас вообще не отрисован (пользователь открыл письмо на весь
        // экран — это и есть основная причина бага «через раз»: сайдбар подсвечивает
        // папку письма как «активную» ДАЖЕ когда на экране открытое письмо, а не сам
        // список; тогда isActiveFolderLink() говорил «уже там», код пробовал скроллить
        // список, которого физически нет на экране, и сразу проваливался в хеш-фолбэк
        // — а там уже зависело от чистой случайности, покажет он ветку или письмо).
        // Клик по папке (даже «активной») принудительно переводит на страницу списка.
        const fid = info && info.fid;
        const folderLink = findFolderLinkByFid(fid);
        if (folderLink && (!isActiveFolderLink(folderLink) || !hasMessageListVisible())) {
            dlog(`📨 Переключаемся на папку ветки (fid=${fid}), список сейчас ${hasMessageListVisible() ? 'виден' : 'НЕ виден'}`);
            trace('клик по папке ветки', 'fid=' + (fid || '—') + ' | ' + describeEl(folderLink));
            try { folderLink.click(); } catch (e) { dlog('⚠️ Не удалось кликнуть по папке', e); }
            setTimeout(function () {
                if (abortIfUserTookOver(navFrom, 'Переход к письму')) return;
                lookInFolder();
            }, 900); // ждём загрузку списка новой папки
            return;
        }

        if (folderLink) {
            // Уже в нужной папке.
            lookInFolder();
            return;
        }

        // Ссылку на папку ветки найти не удалось (fid неизвестен или такой папки нет
        // в боковом меню). Скроллить ТЕКУЩУЮ бессмысленно: ветка может лежать совсем в другой папке, а
        // мы потратим секунды на прокрутку «Входящих» и всё равно ничего не найдём.
        dlog(`📨 Папка ветки неизвестна (fid=${fid || '—'})`);
        searchFallback();
    }

    // Открывает КОНКРЕТНОЕ последнее письмо в ветке
    // ВАЖНО: только хеш-навигация, без последующего поиска/переоткрытия.
    function openLastMessage(topic, info) {
        dlog(`📨 openLastMessage (письмо): "${topic}"`, info);

        // Для последнего письма предпочитаем mid конкретного письма
        const lastMid = (info && info.lastMid) || (info && info.mid);
        if (lastMid) {
            dlog(`📨 Открываем письмо по MID: ${lastMid}`);
            setMailHash('#/message/' + lastMid);
            return;
        }

        const tid = info && info.tid;
        if (tid) {
            dlog(`📨 Открываем письмо по TID: ${tid}`);
            setMailHash('#/message/' + tid);
            return;
        }

        // Фолбэк на поиск — ТОЛЬКО когда нет ни одного ID
        dlog(`📨 Фолбэк: поиск письма по теме "${topic}"`);
        searchAndScrollToMessage(topic, info, true, false); // true = с автором
    }

    // Ждет появления письма в списке и скроллит к нему
    function waitForMessageAndScroll(topic, messageId, expandThread, attempts, navFrom) {
        attempts = attempts || 0;
        const maxAttempts = 15; // ~3 секунды с интервалом 200ms
        // Ждём до трёх секунд — за это время человек успевает открыть письмо сам.
        if (navFrom === undefined) navFrom = navStart();
        
        const found = findMessageInList(topic, messageId);
        if (found) {
            dlog(`📨 Письмо найдено в списке, скроллим`);
            scrollToMessage(found);
            // Если нужно развернуть ветку — делаем это после скролла
            if (expandThread) {
                setTimeout(function() {
                    expandThreadInList(found);
                }, 500);
            }
            return;
        }
        
        if (attempts < maxAttempts) {
            dlog(`📨 Письмо не найдено, попытка ${attempts + 1}/${maxAttempts}`);
            setTimeout(function() {
                waitForMessageAndScroll(topic, messageId, expandThread, attempts + 1, navFrom);
            }, 200);
            return;
        }

        if (abortIfUserTookOver(navFrom, 'Поиск письма')) return;
        dlog(`📨 Письмо не найдено в списке, пробуем поиск`);
        const info = MEMORY_CACHE.results.get(topic);
        // При фолбэке после ожидания — ищем ветку без автора, но с разворотом
        searchAndScrollToMessage(topic, info, false, expandThread);
    }

    // Разворачивает ветку в списке писем
    function expandThreadInList(element) {
        if (!element) return;
        
        dlog(`📨 Пытаемся развернуть ветку`);
        
        // 1. Ищем кнопку разворота внутри элемента
        const expandSelectors = [
            '.ThreadCounter__root--DkL7Z',
            '.qa-MessagesListThreadCounter',
            '[data-testid="thread-counter"]',
            '.mail-MessageSnippet-ThreadCounter',
            '[class*="ThreadCounter"]',
            '[class*="thread-counter"]',
            'button[aria-expanded="false"]',
            '[role="button"][aria-expanded="false"]'
        ];
        
        // Кнопка вложений тоже подписана числом («1») и тоже лежит в строке письма —
        // а по селекторам «любой элемент с числом» попадала первой. В журнале это
        // видно как «разворачиваю ветку в списке ([Показать все вложения] «1»)»:
        // расширение раз за разом открывало вложения вместо разворота ветки.
        function isNotThreadButton(el) {
            if (!el) return true;
            const hay = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '') +
                        ' ' + String(el.className && el.className.baseVal !== undefined
                            ? el.className.baseVal : (el.className || ''));
            return /вложен|attach/i.test(hay);
        }

        let expandBtn = null;
        for (const selector of expandSelectors) {
            try {
                const btns = Array.from(element.querySelectorAll(selector));
                const btn = btns.find(function (b) { return !isNotThreadButton(b); });
                if (btn) {
                    expandBtn = btn;
                    break;
                }
            } catch (e) {}
        }
        
        // Если не нашли по селекторам — ищем любой элемент с числом писем
        if (!expandBtn) {
            const allElements = element.querySelectorAll('*');
            for (const el of allElements) {
                const text = el.textContent || '';
                // Ищем элемент с числом в скобках или с иконкой разворота
                if (/\(\d+\)/.test(text) || /^\d+$/.test(text.trim())) {
                    // Проверяем, что это не просто текст
                    const parent = el.closest('button, [role="button"], [class*="expand"], [class*="toggle"]');
                    if (parent && !isNotThreadButton(parent)) {
                        expandBtn = parent;
                        break;
                    }
                    // Если родитель не найден — пробуем сам элемент
                    if (el.closest('[class*="Thread"]') || el.closest('[class*="thread"]')) {
                        expandBtn = el;
                        break;
                    }
                }
            }
        }
        
        // Если нашли кнопку разворота — кликаем ТОЛЬКО по ней.
        // По строке письма НЕ кликаем: это открыло бы письмо, а не развернуло ветку.
        if (expandBtn) {
            dlog(`📨 Найдена кнопка разворота, кликаем`);
            try {
                trace('разворачиваю ветку в списке', describeEl(expandBtn));
                expandBtn.click();
                // Добавляем визуальный фидбек
                expandBtn.style.transition = 'background-color 0.3s ease';
                expandBtn.style.backgroundColor = 'rgba(102, 126, 234, 0.2)';
                setTimeout(function() {
                    expandBtn.style.backgroundColor = '';
                }, 1000);
                dlog(`📨 Ветка развернута`);
            } catch (e) {
                dlog(`⚠️ Ошибка при клике на кнопку разворота:`, e);
            }
        } else {
            // Кнопки разворота нет — вероятно, в ветке одно письмо. Ничего не открываем,
            // письмо уже подсвечено скроллом. Клик по строке здесь запрещён (откроет письмо).
            dlog(`📨 Кнопка разворота не найдена (возможно, ветка из одного письма)`);
        }
    }

    // Ищет строку письма в текущем списке почты.
    // Раньше здесь была ловушка: если тема не совпала, строка всё равно возвращалась,
    // когда её ТЕКСТ (отправитель, сниппет, цитата) где-то содержал искомое. Из-за
    // этого «показать ветку» уводило на первое попавшееся письмо — с чужой темой, где
    // совпало только название поставщика.
    //
    // Порядок теперь такой, от точного к грубому:
    //   1. messageId — id письма ИМЕННО ЭТОЙ строки. Самое точное совпадение.
    //   2. allIds — остальные id ветки. Свёрнутая ветка рисует в списке ОДНО
    //      представительское письмо, и его id обычно не тот, что у нашего, — но это
    //      та же переписка, и разворачивать надо именно эту строку.
    //   3. Тема — но только с подтверждением по дате письма и началу текста (opts,
    //      см. navMatchOpts). Без подтверждения по теме бралась ПЕРВАЯ подошедшая
    //      строка, а список отсортирован свежими вверх: «Энергия ООО» в понедельник
    //      и в четверг — разные переписки, открывалась не та.
    function findMessageInList(topic, messageId, allIds, opts) {
        const selectors = [
            '.qa-MessagesListItem',
            '.MessagesList__item',
            '[data-testid="messages-list_message-item"]',
            '.MessageListItem__root--qxe9X',
            '.mail-MessageSnippet',
            '.mail-FolderView-Item',
            '[class*="MessageListItem"]',
            '[class*="MessagesListItem"]'
        ];

        const items = [];
        const seenItems = new Set();
        for (const selector of selectors) {
            try {
                document.querySelectorAll(selector).forEach(function (el) {
                    if (seenItems.has(el)) return;
                    seenItems.add(el);
                    items.push(el);
                });
            } catch (e) { /* селектор не поддержан — пропускаем */ }
        }

        const diag = {
            'тема строки': String(topic || '').slice(0, 60),
            'строк в списке': items.length,
            'итог': 'не разбирали'
        };
        FIND_DIAG = diag;

        // 1) По идентификаторам — точное совпадение, а не «содержит».
        //    Два прохода: сначала id письма строки, потом остальные id ветки.
        //    Порядок важен: строку своего письма предпочитаем строке-соседке по ветке,
        //    но и её берём, если своей в списке нет.
        function idSet(v) {
            const out = new Set();
            (Array.isArray(v) ? v : [v]).forEach(function (x) {
                const id = stripThreadPrefix(String(x == null ? '' : x).trim());
                if (id) out.add(id);
            });
            return out;
        }
        const primary = idSet(messageId);
        const secondary = idSet(allIds);
        primary.forEach(function (id) { secondary.delete(id); });
        const hadIds = primary.size > 0 || secondary.size > 0;
        diag['id нужной строки'] = primary.size + secondary.size;

        function findByIds(set) {
            if (!set.size) return null;
            for (const item of items) {
                let ids = [];
                try { ids = collectRowMessageIds(item); } catch (e) { ids = []; }
                const hit = ids.some(function (id) { return set.has(stripThreadPrefix(id)); });
                if (hit) return item;
            }
            return null;
        }
        const byPrimary = findByIds(primary);
        if (byPrimary) { diag['итог'] = 'нашлась по id письма строки'; return byPrimary; }
        const bySecondary = findByIds(secondary);
        if (bySecondary) { diag['итог'] = 'нашлась по id ветки'; return bySecondary; }
        // Считаем ОТДЕЛЬНО, а не по ходу поиска: раньше счётчик стоял внутри findByIds,
        // а тот выходит сразу, когда искать нечего, — и в диагностике всегда было «0»,
        // даже если id в разметке есть у всех строк. Само по себе это ничего не
        // ломало, но сбивало с толку ровно там, где нужна ясность.
        let rowsWithIds = 0;
        for (const item of items) {
            let ids = [];
            try { ids = collectRowMessageIds(item); } catch (e) { ids = []; }
            if (ids.length) rowsWithIds++;
        }
        diag['строк с id в разметке'] = rowsWithIds;

        // 2) По теме строки. Собираем ВСЕ подошедшие и выбираем одну по приметам.
        //
        // Раньше на промахе по id здесь был безусловный выход. Но id расширение снимает
        // из ответа почты, а строка списка отдаёт его в data-атрибутах — в части
        // вёрсток (и в выдаче поиска) их там нет вовсе. Отсюда и было «ветка не
        // найдена» при живой переписке прямо на экране.
        const want = topic ? normForMatch(stripRowSubjectTail(topic)) : '';
        if (!want || want.length < 4) {
            diag['итог'] = want ? 'тема слишком короткая для разбора' : 'темы нет';
            return null;
        }

        const cands = [];
        for (const item of items) {
            let subj = '';
            try { subj = normForMatch(getRowSubject(item)); } catch (e) { subj = ''; }
            if (!subj) continue;
            let hit = subj === want;
            // Частичное совпадение — только для достаточно длинных тем, чтобы
            // не цеплять письмо по одному общему слову.
            if (!hit && subj.length >= 8 && want.indexOf(subj) !== -1) hit = true;
            if (!hit && want.length >= 8 && subj.indexOf(want) !== -1) hit = true;
            if (hit) cands.push(item);
        }
        diag['подошли по теме'] = cands.length;
        if (!cands.length) {
            diag['итог'] = 'ни одна строка списка не совпала по теме';
            return null;
        }

        return pickRowByHints(cands, opts, diag);
    }

    // Выбор одной строки из нескольких однотемных.
    //
    // ВАЖНО: если по теме что-то подошло, эта функция ВСЕГДА что-то возвращает, кроме
    // одного случая — opts.strictDay и дата явно говорит «это письмо другого дня».
    // Так и было до 2.68: подошло по теме — показываем. Отказывать наглухо нельзя:
    // получается «показала результаты поиска, выделить не удалось» вместо переписки,
    // которая тут же, на экране.
    //
    // opts.strictDay — за этим шагом есть ещё шаги (папка, прокрутка, поиск). Тогда
    // строку другого дня лучше пропустить: следующий шаг найдёт нужную. На последнем
    // шаге strictDay не ставится — там лучшая догадка полезнее пустого отказа.
    function pickRowByHints(cands, opts, diag) {
        diag = diag || {};
        const wantPre = normForMatch((opts && opts.preview) || '');
        const anchor = (opts && opts.ts) || 0;

        // Начало текста письма — самая надёжная примета среди писем ОДНОГО дня.
        // Сравниваем весь доступный общий префикс, а не первые 40 символов: письма
        // по шаблону («Доброй ночи. Водитель прибыл на загрузку …») совпадают
        // первыми сорока символами дословно.
        if (wantPre.length >= 8) {
            let withPreview = 0;      // у скольких строк начало текста вообще читается
            const byPreview = cands.filter(function (item) {
                let got = '';
                try { got = normForMatch(getRowFirstline(item)); } catch (e) { got = ''; }
                if (!got) return false;
                withPreview++;
                const n = Math.min(wantPre.length, got.length, 200);
                return n >= 8 && wantPre.slice(0, n) === got.slice(0, n);
            });
            diag['из них совпал текст'] = byPreview.length;
            if (byPreview.length === 1) {
                diag['итог'] = 'выбрана по началу текста письма';
                return byPreview[0];
            }
            if (byPreview.length) {
                cands = byPreview;
            } else if (withPreview) {
                // Начало текста нужного письма мы знаем, у строк оно читается — и НИ
                // ОДНА не совпала. Это не «нечем сравнить», это улика: перед нами
                // другие письма. Раньше пустой результат просто игнорировался, и
                // дальше решала дата — а по ней «не старше нужной» проходит любое
                // письмо той же темы, пришедшее позже. Отсюда и было: щёлкаешь одну
                // строку, а подсвечивается ветка соседней, с той же темой.
                diag['итог'] = 'начало текста не совпало ни с одной строкой — это другие письма';
                if (opts && opts.strictDay) return null;
            }
        }

        if (cands.length === 1 && !anchor) {
            diag['итог'] = 'единственная строка с такой темой';
            return cands[0];
        }

        // Дата письма: в списке она с точностью до дня, поэтому и сравниваем по дню.
        const DAY = 86400000;
        let dated = [];
        cands.forEach(function (item) {
            const ts = getRowDateMs(item);
            if (ts) dated.push({ item: item, day: startOfDayMs(ts) });
        });
        diag['из них с разобранной датой'] = dated.length;
        diag['якорь времени'] = anchor ? new Date(anchor).toLocaleString('ru-RU') : '—';
        diag['якорь — время последнего письма'] = !!(opts && opts.tsExact);

        if (anchor && dated.length) {
            const anchorDay = startOfDayMs(anchor);
            let best = null;
            if (opts && opts.tsExact) {
                // Знаем время ПОСЛЕДНЕГО письма ветки — ровно его и показывает строка.
                best = dated[0];
                dated.forEach(function (d) {
                    if (Math.abs(d.day - anchorDay) < Math.abs(best.day - anchorDay)) best = d;
                });
            } else {
                // Знаем только время письма, которое завели на контроль. Строка списка
                // не может быть старше него, но может быть свежее — на все ответы,
                // пришедшие с тех пор. Среди подходящих берём САМУЮ РАННЮЮ.
                const after = dated.filter(function (d) { return d.day >= anchorDay - DAY; });
                const pool = after.length ? after : dated;
                best = pool[0];
                pool.forEach(function (d) { if (d.day < best.day) best = d; });
            }
            const off = Math.abs(best.day - anchorDay) / DAY;
            diag['расхождение по дням'] = Math.round(off);
            // Сутки допуска: часовые пояса и письма около полуночи.
            if (Math.abs(best.day - anchorDay) <= DAY || !(opts && opts.strictDay)) {
                diag['итог'] = (Math.abs(best.day - anchorDay) <= DAY)
                    ? 'выбрана по дате письма'
                    : 'точной по дате нет — показываю ближайшую однотемную';
                return best.item;
            }
            // За этим шагом есть ещё шаги — пусть ищут они.
            diag['итог'] = 'строки нужного дня в этом списке нет — иду дальше';
            return null;
        }

        // Подтвердить нечем (дат со строк не снять или якоря нет). Ведём себя как до
        // 2.68: подошло по теме — показываем первую. Хуже прежнего это не будет.
        diag['итог'] = anchor
            ? 'даты со строк не читаются — беру первую по теме'
            : 'времени письма нет — беру первую по теме';
        return cands[0];
    }

    // Скроллит к элементу письма с подсветкой
    function scrollToMessage(element) {
        if (!element) return;
        
        try {
            element.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
            
            element.style.transition = 'background-color 0.5s ease';
            element.style.backgroundColor = 'rgba(102, 126, 234, 0.15)';
            setTimeout(function() {
                element.style.backgroundColor = '';
            }, 3000);
            
            dlog(`📨 Скролл к письму выполнен`);
        } catch (e) {
            dlog(`⚠️ Ошибка скролла:`, e);
        }
    }

    // Поиск с последующим скроллом к найденному письму
    // includeAuthor: true — добавляем автора в поиск (для конкретного письма)
    //                false — ищем только по теме + номеру (для всей ветки)
    // expandThread: true — разворачиваем ветку после перехода
    let CHIP_MARKUP_LOGGED = false;   // разметку чипа печатаем один раз за страницу
    const LAST_SEARCH = { key: '', at: 0 };   // защита от повторного запуска того же поиска

    function searchAndScrollToMessage(topic, info, includeAuthor, expandThread) {
        dlog(`📨 searchAndScrollToMessage: "${topic}", includeAuthor: ${includeAuthor}, expandThread: ${expandThread}`);
        // С этой секунды и ещё некоторое время список писем не перерисовываем кликом
        // по папке: он выбросил бы человека из результатов поиска.
        const navFrom = navStart();
        // Тот же поиск, запущенный секунду назад, — это повторный клик или наложение
        // отложенных шагов. В журнале это выглядело как семь одинаковых строк подряд.
        //
        // Ключ — ТЕМА ПЛЮС НОМЕР, а не одна тема. У складских строк темы совпадают
        // буквально («Перемещение Партизанский - Таборы» и «Перемещение партизанский
        // - таборы» — одна и та же строка после нормализации), а номера разные. По
        // одной теме клик по соседней строке в первые секунды просто проглатывался:
        // «щёлкаю — ничего не происходит».
        const searchKey = normForMatch(topic) + '|' +
            String((info && info.number) || '').trim().toLowerCase();
        if (LAST_SEARCH.key === searchKey && Date.now() - LAST_SEARCH.at < 2500) {
            dlog('📨 Тот же поиск только что запускали — не повторяю');
            return;
        }
        LAST_SEARCH.key = searchKey;
        LAST_SEARCH.at = Date.now();
        trace('поиск письма в почте', topic);

        const hints = navMatchOpts(info);
        const searchMid = (info && (info.shownMid || info.mid)) ? String(info.shownMid || info.mid) : '';
        const found = findMessageInList(topic, searchMid || (info && info.mid), threadIdsOf(info),
                                        Object.assign({ strictDay: true }, hints));
        if (found) {
            dlog(`📨 Письмо найдено в списке, скроллим`);
            scrollToMessage(found);
            if (expandThread) {
                setTimeout(function() {
                    expandThreadInList(found);
                }, 500);
            }
            return;
        }
        
        // Крестики на чипах фильтров поиска. Разметка у сборок разная, поэтому берём
        // несколько написаний; сработавшее печатаем, чтобы при неудаче было видно,
        // что именно не нашлось, — а не гадать по симптому «ищет не в той папке».
        const CHIP_CLOSE_SELECTORS = [
            '[class*="search" i] [class*="chip" i] [class*="close" i]',
            '[class*="search" i] [class*="Chip" i] button',
            '[class*="SearchFilter" i] [class*="close" i]',
            '[class*="search" i] [class*="chip" i] [class*="cross" i]',
            '[class*="search" i] [class*="chip" i] [class*="clear" i]',
            '[class*="search" i] [role="button"][aria-label*="далить" i]',
            '[class*="search" i] button[aria-label*="брос" i]',
            '[class*="search" i] button[aria-label*="чистить" i]'
        ];
        function clearMailSearchFilters() {
            let removed = 0;
            CHIP_CLOSE_SELECTORS.forEach(function (sel) {
                let nodes = [];
                try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { return; }
                nodes.forEach(function (el) {
                    if (!el || el.offsetParent === null) return;
                    try {
                        trace('снимаю чип фильтра поиска', describeEl(el));
                        el.click();
                        removed++;
                    } catch (e) { /* ignore */ }
                });
            });
            // Крестик не нашёлся — чип останется висеть рядом с полем. На область
            // поиска это уже не влияет (её задаёт адрес), но выглядит так, будто
            // ищем внутри папки. Один раз печатаем разметку чипа: по ней добавляется
            // селектор, и чип начнёт сниматься.
            if (!removed && !CHIP_MARKUP_LOGGED) {
                let chip = null;
                try {
                    chip = document.querySelector('[class*="search" i] [class*="chip" i], [class*="SearchFilter" i]');
                } catch (e) { /* ignore */ }
                if (chip && chip.offsetParent !== null) {
                    CHIP_MARKUP_LOGGED = true;
                    try {
                        console.warn('[Проблемные письма] Чип области поиска не снялся ' +
                            '(на сам поиск это не влияет — область задаёт адрес). Разметка: ' +
                            String(chip.outerHTML || '').slice(0, 400));
                    } catch (e) { /* ignore */ }
                }
            }
            return removed;
        }

        // Запрос почте строим так же, как его строит собственный поиск расширения
        // (apiGetInfo): есть номер ЗП/Перемещения — ищем ПО НОМЕРУ (он находит письмо,
        // даже когда в теме его нет), нет номера — по очищенной теме.
        //
        // Раньше в запрос уходили тема И номер сразу:
        //   0000-0728699, ООО ТК Зелёная Русь-исправить ЗП "0000-0728699"
        // Такой длинный запрос с запятыми, тире и кавычками почта нередко не находит
        // вовсе — и это было прямой причиной «ветка не найдена» при живой переписке в
        // ящике. Хвост вида «, 10:41» из темы убираем по той же причине: по теме со
        // временем поиск не находит ничего.
        //
        // Номера нет — тему берём В КАВЫЧКИ, целиком. Без кавычек почта разбирает её
        // на слова, и получается совсем не то:
        //   Перемещение Королёв Стан -Борисов   →   3339 писем
        // Во-первых, ищется ЛЮБОЕ из слов: в выдаче «Перемещение Королев Стан — Таборы»,
        // «Перемещение Заславль ДХ — Королёв Стан» и прочие чужие переписки.
        // Во-вторых — и это хуже — «-Борисов» почта читает как оператор ИСКЛЮЧЕНИЯ:
        // минус перед словом означает «без этого слова». То есть нужное письмо
        // выбрасывалось из выдачи ровно тем куском темы, который его и опознаёт.
        // В кавычках «-» — обычный символ фразы, а не оператор.
        const cleanTopic = stripRowSubjectTail(topic);
        const rowNumber = (info && info.number) || null;
        const searchNum = (rowNumber && looksLikeOrderNumber(rowNumber))
            ? String(rowNumber).trim()
            : extractNumberFromTopic(cleanTopic);
        // Свои кавычки внутри темы убираем — иначе фраза «порвётся» посередине.
        const topicPhrase = String(cleanTopic || topic).replace(/["«»]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        // Запасной запрос — та же тема, но без кавычек. Пригодится, если точной фразы
        // почта не найдёт: тема в таблице и тема письма могут отличаться на «Re:»,
        // лишний пробел или правку в переписке.
        // Запасные запросы — по очереди, каждый следующий шире предыдущего. Берём
        // следующий, только если почта не нашла НИ ОДНОГО письма: то есть текущий уже
        // провалился и хуже не будет.
        //   номер → тема в кавычках → тема без кавычек
        // Номер — самый точный путь, и на нём всё и остаётся: тема вида
        //   TIANJIN TEXTILE GROUP … Перемещение товаров СВХ (Колядичи)-0000-0342359
        // содержит номер 0000-0342359, по нему и ищется — ни скобки, ни точки, ни тире
        // в запрос не попадают и операторами стать не могут. Но если номер в почте не
        // найдётся (его переписали, письмо переслали без него), раньше на этом всё и
        // кончалось — теперь пробуем тему.
        const fallbackQueries = [];
        if (topicPhrase) {
            if (searchNum) fallbackQueries.push('"' + topicPhrase + '"');
            fallbackQueries.push(topicPhrase);
        }
        let query = searchNum || (topicPhrase ? '"' + topicPhrase + '"' : '');
        if (!query) query = String(cleanTopic || topic).trim();
        
        // Автора добавляем ТОЛЬКО для конкретного письма (openLastMessage)
        if (includeAuthor) {
            const author = info && info.lastAuthor;
            if (author && author !== 'неизвестный' && author !== 'неизвестен' && author.length > 2) {
                query = query + ' от:' + author;
                dlog(`📨 Поиск с автором: "${query}"`);
            }
        } else {
            dlog(`📨 Поиск без автора (для ветки): "${query}"`);
        }

        // Область поиска почта держит В САМОМ АДРЕСЕ:
        //   #/search?request=<запрос>          — по всему ящику
        //   #/search?request=<запрос>&fid=<id> — внутри папки
        // Поэтому надёжный способ искать по всей почте — перейти по адресу БЕЗ fid,
        // а не печатать в поле: печать наследует область прошлого поиска, и запрос
        // уходит внутрь прежней папки («в папке Королёв Стан ничего не нашлось»).
        // Чип рядом с полем при этом может остаться висеть от прошлого поиска —
        // это только оформление, область задаёт адрес.
        clearMailSearchFilters();

        const searchHash = '#/search?request=' + encodeURIComponent(query);
        // Запоминаем: из него человек открывает письмо, и в него же его надо вернуть
        // после «Выполнено» — прямо, а не гаданием по истории браузера.
        lastPanelSearchHash = searchHash;
        // Адрес браузер отдаёт то закодированным, то расшифрованным (зависит от того,
        // кто его ставил — мы или сама почта). Сравниваем расшифрованные.
        function decodedHash(h) {
            try { return decodeURIComponent(String(h || '')); } catch (e) { return String(h || ''); }
        }
        const alreadyThere = decodedHash(location.hash) === decodedHash(searchHash);
        if (!alreadyThere) {
            dlog('📨 Переходим к поиску адресом: ' + searchHash);
            setMailHash(searchHash);
        }
        setTimeout(function () {
            // Сборка адрес поняла — результаты уже грузятся.
            const h = String(location.hash || '');
            if (/#\/?search\?/.test(h)) {
                // Почта сама дописала папку в адрес — тогда поиск снова не по всей
                // почте, и это надо видеть, а не гадать по пустому результату.
                if (/[?&]fid=/.test(h)) {
                    try {
                        console.warn('[Проблемные письма] Почта вернула в адрес поиска папку: ' +
                            h + ' — искали по всему ящику, а получили внутри папки.');
                    } catch (e) { /* ignore */ }
                }
                scanResults();
                return;
            }
            // Не поняла — работаем прежним способом, через поле поиска. Но если за эти
            // полторы секунды человек открыл письмо сам, печатать запрос нельзя: поиск
            // закроет то, что он читает.
            if (abortIfUserTookOver(navFrom, 'Поиск письма')) return;
            dlog('📨 Адрес поиска сборкой не поддержан — печатаем в поле');
            typeQuery();
        }, alreadyThere ? 300 : 1500);

        // Ищет письмо среди результатов и показывает его. Общий хвост для обоих
        // способов поиска — адресом и печатью в поле.
        // Результаты поиска приходят не мгновенно, и почта успевает перерисовать список
        // (например, после отметки «Выполнено»). Одна проверка через полторы секунды
        // попадала в этот промежуток и объявляла «ветка не найдена» — а через мгновение
        // письмо появлялось на экране. Поэтому ждём появления, а не смотрим один раз.
        const SCAN_TRIES = 12;      // ~5 секунд при шаге 400 мс
        function scanResults(attempt) {
            const n = attempt || 0;
            // Здесь строго: результаты ещё догружаются, и впереди прокрутка списка.
            // Хватать однотемное письмо другого дня рано — это делает giveUp, но
            // только после того, как прокрутка ничего не нашла.
            const foundAfterSearch = findMessageInList(topic, searchMid || (info && info.mid),
                                                       threadIdsOf(info),
                                                       Object.assign({ strictDay: true }, hints));
            if (foundAfterSearch) {
                dlog(`📨 После поиска найдено письмо, скроллим`);
                scrollToMessage(foundAfterSearch);
                if (expandThread) {
                    setTimeout(function () { expandThreadInList(foundAfterSearch); }, 600);
                }
                return;
            }
            if (n < SCAN_TRIES) {
                setTimeout(function () { scanResults(n + 1); }, 400);
                return;
            }

            // Прокрутки результатов поиска здесь НЕТ и быть не должно. Она тут
            // появлялась как обход другой поломки: без кавычек тема разбиралась на
            // слова, «-Борисов» работал оператором исключения, и нужное письмо просто
            // выбрасывалось из выдачи — приходилось листать сотни чужих. Кавычки эту
            // причину убрали, выдача снова короткая, и листать нечего.
            giveUp();
        }

        // Сколько строк писем сейчас отрисовано. Ноль — почта ничего не нашла.
        function visibleRowCount() {
            try {
                return document.querySelectorAll(
                    '.qa-MessagesListItem, [class*="MessageListItem"], [class*="MessagesListItem"], ' +
                    '.mail-MessageSnippet, .mail-FolderView-Item'
                ).length;
            } catch (e) { return 0; }
        }

        function giveUp() {
            // Почта не нашла НИ ОДНОГО письма? Значит текущий запрос не подошёл:
            // номер переписали, тема разошлась на «Re:», лишний пробел или правку в
            // переписке. Берём следующий, более широкий, — хуже, чем «ничего», не
            // будет. Последний в очереди — тема без кавычек, ровно прежнее поведение.
            if (fallbackQueries.length && visibleRowCount() === 0) {
                query = fallbackQueries.shift();
                dlog('📨 Ничего не нашлось — повторяю запросом «' + query + '»');
                trace('повтор поиска другим запросом', query);
                setMailHash('#/search?request=' + encodeURIComponent(query));
                setTimeout(function () { scanResults(0); }, 1200);
                return;
            }

            dlog(`📨 После поиска письмо не найдено`);
            // Без этого «выделить не удалось» ничего не объясняет: печатаем, что
            // разбор увидел в списке результатов и на чём остановился.
            printFindDiag('в результатах поиска');
            try {
                console.warn('[Проблемные письма] Запрос, который ушёл в поиск: «' + query + '»');
            } catch (e) { /* ignore */ }

            // Результаты поиска при этом УЖЕ НА ЭКРАНЕ: почта их показала, выделить
            // нужную строку не вышло. Так и говорим — «ветка не найдена» звучало как
            // «письма нет в ящике», хотя оно тут же, в списке результатов.
            // Последняя попытка — уже без строгости по дню: если по теме что-то есть,
            // лучше показать ближайшее однотемное, чем ничего.
            const guess = findMessageInList(topic, searchMid || (info && info.mid),
                                            threadIdsOf(info), hints);
            if (guess) {
                dlog('📨 Точной строки нет — показываю ближайшую однотемную');
                scrollToMessage(guess);
                if (expandThread) setTimeout(function () { expandThreadInList(guess); }, 600);
                showToast('Точного письма в результатах нет — показала ближайшее с той же темой', 'info');
                return;
            }

            const msg = includeAuthor
                ? 'Показала результаты поиска — само письмо выделить не удалось'
                : 'Показала результаты поиска — саму ветку выделить не удалось';
            showToast(msg, 'info');
        }

        function typeQuery() {
        // Поле могло перерисоваться после выхода из поиска — берём его заново.
        const searchInput = document.querySelector('.textinput__control') ||
                           document.querySelector('input[placeholder="Поиск"]') ||
                           document.querySelector('input[placeholder*="Поиск"]') ||
                           document.querySelector('[data-testid="search-input"] input');
        if (!searchInput) {
            showToast('Не удалось открыть: поле поиска не найдено', 'error');
            return;
        }

        searchInput.value = '';
        searchInput.focus();

        setTimeout(function() {
            searchInput.value = query;

            const inputEvent = new Event('input', { bubbles: true });
            searchInput.dispatchEvent(inputEvent);
            
            const changeEvent = new Event('change', { bubbles: true });
            searchInput.dispatchEvent(changeEvent);
            
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            });
            searchInput.dispatchEvent(enterEvent);
            
            const form = searchInput.closest('form');
            if (form) {
                const submitEvent = new Event('submit', { bubbles: true });
                form.dispatchEvent(submitEvent);
            }
            
            setTimeout(scanResults, 1500);
        }, 300);
        }   // typeQuery
    }

    // === КОНЕЦ ФУНКЦИЙ ПЕРЕХОДА ===

    // === CSS ===
    // Оформление в стиле «liquid glass»: полупрозрачные слои с размытием фона,
    // мягкие тени и верхний блик. Все цвета вынесены в CSS-переменные, чтобы одна
    // и та же разметка работала в светлой и тёмной теме — тема переключается
    // классом .pm-dark на host-элементе (см. applyTheme).
    const CSS = `
        :host {
            all: initial;
            /* Светлая тема (по умолчанию) */
            --pm-accent1: #667eea;
            --pm-accent2: #764ba2;
            --pm-accent: #667eea;
            --pm-accent-soft: rgba(102, 126, 234, 0.10);
            --pm-accent-soft-2: rgba(102, 126, 234, 0.16);
            --pm-on-accent: #ffffff;

            --pm-text: #1a1a2e;
            --pm-text-strong: #2d3436;
            --pm-muted: #6b7280;
            --pm-faint: #9aa3b2;

            --pm-panel-bg: rgba(247, 249, 255, 0.72);
            --pm-aurora-1: rgba(102, 126, 234, 0.28);
            --pm-aurora-2: rgba(118, 75, 162, 0.22);
            --pm-header-bg: rgba(255, 255, 255, 0.42);
            --pm-strip-bg: rgba(255, 255, 255, 0.22);

            --pm-glass: rgba(255, 255, 255, 0.55);
            --pm-glass-strong: rgba(255, 255, 255, 0.74);
            --pm-glass-hover: rgba(255, 255, 255, 0.88);
            --pm-inset: rgba(102, 126, 234, 0.05);
            --pm-inset-hover: rgba(102, 126, 234, 0.08);

            --pm-border: rgba(102, 126, 234, 0.16);
            --pm-border-soft: rgba(102, 126, 234, 0.08);
            --pm-highlight: rgba(255, 255, 255, 0.7);
            --pm-shadow: rgba(60, 70, 120, 0.16);
            --pm-shadow-soft: rgba(102, 126, 234, 0.10);

            --pm-chip-bg: rgba(102, 126, 234, 0.10);
            --pm-field-bg: rgba(255, 255, 255, 0.66);
            --pm-scrim: rgba(20, 20, 35, 0.38);
            --pm-modal-bg: rgba(255, 255, 255, 0.82);

            --pm-warn: #c77700;
            --pm-warn-bg: rgba(253, 176, 34, 0.16);
            --pm-warn-line: #fdb022;
            --pm-danger: #d63a1e;
            --pm-danger-bg: rgba(225, 112, 85, 0.14);
            --pm-danger-line: #e17055;
        }
        :host(.pm-dark) {
            --pm-accent1: #8a9bff;
            --pm-accent2: #b483ff;
            --pm-accent: #9aa9ff;
            --pm-accent-soft: rgba(138, 155, 255, 0.14);
            --pm-accent-soft-2: rgba(138, 155, 255, 0.22);
            --pm-on-accent: #ffffff;

            --pm-text: #eef0ff;
            --pm-text-strong: #f4f5ff;
            --pm-muted: #a4a9c8;
            --pm-faint: #6e7391;

            --pm-panel-bg: rgba(17, 19, 32, 0.74);
            --pm-aurora-1: rgba(138, 155, 255, 0.24);
            --pm-aurora-2: rgba(180, 131, 255, 0.20);
            --pm-header-bg: rgba(255, 255, 255, 0.05);
            --pm-strip-bg: rgba(255, 255, 255, 0.03);

            --pm-glass: rgba(255, 255, 255, 0.055);
            --pm-glass-strong: rgba(255, 255, 255, 0.09);
            --pm-glass-hover: rgba(255, 255, 255, 0.13);
            --pm-inset: rgba(255, 255, 255, 0.04);
            --pm-inset-hover: rgba(255, 255, 255, 0.07);

            --pm-border: rgba(255, 255, 255, 0.13);
            --pm-border-soft: rgba(255, 255, 255, 0.07);
            --pm-highlight: rgba(255, 255, 255, 0.16);
            --pm-shadow: rgba(0, 0, 0, 0.55);
            --pm-shadow-soft: rgba(0, 0, 0, 0.20);

            --pm-chip-bg: rgba(138, 155, 255, 0.16);
            --pm-field-bg: rgba(255, 255, 255, 0.06);
            --pm-scrim: rgba(0, 0, 0, 0.55);
            --pm-modal-bg: rgba(30, 33, 48, 0.9);

            --pm-warn: #ffcf7a;
            --pm-warn-bg: rgba(253, 176, 34, 0.18);
            --pm-warn-line: #fdb022;
            --pm-danger: #ff9d86;
            --pm-danger-bg: rgba(225, 112, 85, 0.20);
            --pm-danger-line: #e17055;
        }
        * { box-sizing: border-box; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

        /* Стопка язычков: по одному на настроенную метку, сверху вниз в том порядке,
           в каком метки стоят в настройках. */
        .pm-toggle-stack {
            position: fixed; top: 45%; right: 0; z-index: 2147483000;
            transform: translateY(-50%);
            display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
            /* Сама стопка кликов не ловит — иначе её прозрачные поля перекрывали бы
               почту рядом с язычками. Кликабельны только сами язычки. */
            pointer-events: none;
        }
        .pm-toggle-col {
            display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        }
        /* Горизонтальная полоса «обновить метки всех плашек» — НАД стопкой.
           Показывается, только когда обновлять действительно есть что: пока всё
           синхронизировано, она не мозолит глаза. */
        .pm-sync-all {
            pointer-events: auto;
            display: none;
            align-items: center; justify-content: center; gap: 6px;
            align-self: stretch;
            background: linear-gradient(135deg, #e05555, #b93b3b);
            color: #fff;
            border-radius: 12px 0 0 12px;
            padding: 7px 12px;
            font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
            white-space: nowrap;
            cursor: pointer; user-select: none;
            box-shadow: -1px 3px 10px var(--pm-shadow-soft);
            transition: filter 0.2s ease;
        }
        .pm-sync-all.available, .pm-sync-all.stale, .pm-sync-all.busy { display: flex; }
        /* Обычное состояние — спокойное; красное значит «в таблице что-то менялось».
           Цвет можно поменять в Настройках, здесь — значение по умолчанию. */
        .pm-sync-all.available:not(.stale) { background: #6b7280; }
        .pm-sync-all:hover { filter: brightness(1.08); }
        .pm-sync-all.busy { opacity: 0.75; cursor: progress; }
        .pm-toggle .pm-toggle-btn.stale {
            background: #e05555;
            color: #fff;
        }
        .pm-toggle {
            position: relative;
            pointer-events: auto;
            background: linear-gradient(135deg, var(--pm-accent1), var(--pm-accent2));
            color: #fff; border-radius: 14px 0 0 14px;
            padding: 14px 12px; cursor: pointer;
            box-shadow: -1px 3px 10px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.35);
            font-size: 13px; font-weight: 600;
            display: flex; align-items: center; gap: 8px;
            user-select: none; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            letter-spacing: 0.3px;
            border: none;
        }
        .pm-toggle:hover {
            padding-right: 18px;
            transform: translateX(-4px);
            box-shadow: -2px 4px 14px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.4);
            /* При наведении чуть осветляем пользовательский цвет, если он задан */
            filter: brightness(1.08);
        }
        .pm-toggle .pm-badge {
            /* Подложка лёгкая: при 0.28 она забивала саму цифру. */
            background: rgba(255,255,255,0.14);
            color: #fff; border-radius: 20px;
            padding: 2px 10px; font-size: 12px;
            min-width: 20px; text-align: center;
            border: none;
        }
        /* Кнопка «проставить/снять метку» прямо на язычке — справа от счётчика.
           Появляется, когда меток больше одной: так их можно обновлять по одной,
           не открывая панель. */
        .pm-toggle .pm-toggle-btn {
            background: rgba(255,255,255,0.24);
            border: none;
            color: #fff; border-radius: 9px;
            padding: 3px 7px; font-size: 12px; line-height: 1.1;
            cursor: pointer; font-family: inherit;
            transition: background 0.15s, transform 0.15s;
        }
        .pm-toggle .pm-toggle-btn:hover { background: rgba(255,255,255,0.44); transform: scale(1.1); }
        .pm-toggle .pm-toggle-btn:disabled { opacity: 0.6; cursor: default; transform: none; }

        /* Плавающая кнопка «Выполнено» для открытого письма — видна, только когда
           открыто конкретное письмо/ветка (по хэшу адреса), не в списке. Отдельно от
           язычков, чтобы не путать с перетаскиванием и не мешать открытию панели. */
        /* Форма — та же плашка, что у язычков меток: кнопка стоит с ними в одном
           столбце и не должна выбиваться из общего вида. */
        /* Пустой значок (в покое эмодзи нет) не должен оставлять лишний отступ. */
        .pm-quick-done > span:empty { display: none; }
        .pm-quick-done {
            position: fixed; right: 0; top: 45%; z-index: 2147483000;
            background: linear-gradient(135deg, #34c759, #23a84a);
            color: #fff; border-radius: 14px 0 0 14px;
            padding: 14px 12px; cursor: pointer;
            box-shadow: -1px 3px 10px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.35);
            font-size: 13px; font-weight: 600;
            display: none; align-items: center; gap: 8px;
            user-select: none; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            letter-spacing: 0.3px;
            border: none;
        }
        .pm-quick-done.visible { display: flex; }
        .pm-quick-done:hover {
            padding-right: 18px;
            transform: translateX(-4px);
            box-shadow: -2px 4px 14px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.4);
        }
        .pm-quick-done:active { transform: translateX(-2px) scale(0.98); }
        .pm-quick-done.busy { opacity: 0.65; cursor: progress; pointer-events: none; }

        .pm-panel {
            position: fixed; top: 0; right: 0; height: 100vh; width: 440px; max-width: 94vw;
            background: var(--pm-panel-bg);
            backdrop-filter: blur(26px) saturate(165%);
            -webkit-backdrop-filter: blur(26px) saturate(165%);
            box-shadow: -12px 0 60px var(--pm-shadow);
            z-index: 2147483001;
            transform: translateX(100%);
            transition: transform 0.42s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex; flex-direction: column;
            color: var(--pm-text); font-size: 13px;
            border-left: 1px solid var(--pm-border);
            overflow: hidden;
        }
        /* Мягкое «сияние» на фоне панели — придаёт стеклу глубину. */
        .pm-panel::before {
            content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
            background:
                radial-gradient(120% 80% at 100% 0%, var(--pm-aurora-1), transparent 60%),
                radial-gradient(90% 60% at 0% 100%, var(--pm-aurora-2), transparent 55%);
            opacity: 0.9;
        }
        .pm-panel > * { position: relative; z-index: 1; }
        .pm-panel.open { transform: translateX(0); }

        .pm-header {
            display: flex; align-items: center; gap: 8px;
            padding: 16px 20px;
            background: var(--pm-header-bg);
            border-bottom: 1px solid var(--pm-border-soft);
            box-shadow: inset 0 1px 0 var(--pm-highlight);
            flex-wrap: wrap;
            flex-shrink: 0;
        }
        .pm-header .pm-icon {
            font-size: 20px;
            filter: drop-shadow(0 2px 6px var(--pm-shadow-soft));
        }
        .pm-title {
            font-weight: 700; font-size: 16px; flex: 1;
            color: var(--pm-text);
            letter-spacing: -0.3px;
        }
        .pm-title span {
            background: linear-gradient(135deg, var(--pm-accent1), var(--pm-accent2));
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .pm-header-actions {
            display: flex; gap: 6px; align-items: center;
        }
        .pm-btn {
            font-size: 12px; font-weight: 600; border-radius: 10px;
            padding: 6px 14px; cursor: pointer;
            border: none; transition: all 0.2s ease;
            display: flex; align-items: center; gap: 4px;
            font-family: inherit;
        }
        .pm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .pm-btn-outline {
            background: var(--pm-accent-soft);
            color: var(--pm-accent);
            border: 1px solid var(--pm-border-soft);
        }
        .pm-btn-outline:hover { background: var(--pm-accent-soft-2); }
        .pm-btn-outline:active { transform: scale(0.96); }
        .pm-icon-btn {
            padding: 6px 10px; font-size: 14px; line-height: 1;
        }
        .pm-btn-primary {
            background: linear-gradient(135deg, var(--pm-accent1), var(--pm-accent2));
            color: var(--pm-on-accent);
            box-shadow: 0 4px 14px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.3);
        }
        .pm-btn-primary:hover { filter: brightness(1.05); transform: translateY(-1px); }
        .pm-btn-primary:active { transform: scale(0.96); }
        .pm-btn-success {
            background: linear-gradient(135deg, #00c39a, #00a381);
            color: #fff;
            box-shadow: 0 4px 14px rgba(0, 163, 129, 0.28), inset 0 1px 0 rgba(255,255,255,0.3);
        }
        .pm-btn-success:hover { filter: brightness(1.05); transform: translateY(-1px); }
        .pm-btn-success:active { transform: scale(0.96); }
        .pm-close {
            background: var(--pm-inset);
            border: 1px solid var(--pm-border-soft); border-radius: 10px;
            font-size: 20px; line-height: 1;
            cursor: pointer; color: var(--pm-muted);
            padding: 4px 10px; transition: all 0.2s;
        }
        .pm-close:hover { background: var(--pm-inset-hover); color: var(--pm-text-strong); }

        .pm-count {
            color: var(--pm-muted); font-size: 12px; padding: 8px 20px 12px;
            font-weight: 500; flex-shrink: 0;
            border-bottom: 1px solid var(--pm-border-soft);
            background: var(--pm-strip-bg);
        }
        .pm-count strong {
            color: var(--pm-accent);
            font-weight: 700;
        }

        .pm-search-wrap {
            display: flex; align-items: center; gap: 8px;
            margin: 10px 16px 4px;
            padding: 7px 12px;
            border-radius: 12px;
            background: var(--pm-field-bg);
            border: 1px solid var(--pm-border);
            box-shadow: inset 0 1px 0 var(--pm-highlight);
            flex-shrink: 0;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .pm-search-wrap:focus-within {
            border-color: var(--pm-accent);
            box-shadow: inset 0 1px 0 var(--pm-highlight), 0 0 0 3px var(--pm-accent-soft);
        }
        .pm-search-icon { font-size: 13px; opacity: 0.7; }
        .pm-search {
            flex: 1; min-width: 0;
            border: none; outline: none; background: transparent;
            font-family: inherit; font-size: 13px; color: var(--pm-text);
        }
        .pm-search::placeholder { color: var(--pm-faint); }
        .pm-search::-webkit-search-cancel-button { display: none; }
        .pm-search-clear {
            border: none; background: transparent; cursor: pointer;
            color: var(--pm-muted); font-size: 16px; line-height: 1;
            padding: 0 2px; border-radius: 6px; display: none;
        }
        .pm-search-clear:hover { color: var(--pm-text-strong); }
        .pm-search-wrap.has-text .pm-search-clear { display: block; }

        .pm-controls {
            display: flex; gap: 8px; padding: 6px 16px 12px;
            flex-shrink: 0;
            border-bottom: 1px solid var(--pm-border-soft);
        }
        .pm-select {
            flex: 1; min-width: 0;
            font-family: inherit; font-size: 12px;
            color: var(--pm-text-strong);
            padding: 7px 10px; border-radius: 10px;
            border: 1px solid var(--pm-border);
            background: var(--pm-field-bg);
            box-shadow: inset 0 1px 0 var(--pm-highlight);
            cursor: pointer; outline: none;
            transition: border-color 0.2s;
        }
        .pm-select:focus { border-color: var(--pm-accent); }
        .pm-select option { color: #1a1a2e; }

        .pm-age {
            font-size: 11px; font-weight: 600;
            padding: 2px 10px; border-radius: 12px;
            background: var(--pm-accent-soft); color: var(--pm-accent);
        }
        .pm-age.warn { background: var(--pm-warn-bg); color: var(--pm-warn); }
        .pm-age.danger { background: var(--pm-danger-bg); color: var(--pm-danger); }
        .pm-card.pm-old { border-left: 3px solid var(--pm-warn-line); }
        .pm-card.pm-overdue { border-left: 3px solid var(--pm-danger-line); }

        .pm-list {
            overflow-y: auto; padding: 12px 16px 16px; flex: 1;
            scroll-behavior: smooth;
        }
        .pm-list::-webkit-scrollbar { width: 5px; }
        .pm-list::-webkit-scrollbar-track { background: transparent; }
        .pm-list::-webkit-scrollbar-thumb {
            background: var(--pm-accent-soft-2);
            border-radius: 4px;
        }
        .pm-list::-webkit-scrollbar-thumb:hover { background: var(--pm-accent); }

        .pm-card {
            background: var(--pm-glass);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid var(--pm-border-soft);
            border-radius: 16px;
            padding: 14px 16px;
            margin-bottom: 10px;
            box-shadow: 0 4px 16px var(--pm-shadow-soft), inset 0 1px 0 var(--pm-highlight);
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .pm-card:hover {
            background: var(--pm-glass-hover);
            border-color: var(--pm-border);
            box-shadow: 0 8px 28px var(--pm-shadow-soft), inset 0 1px 0 var(--pm-highlight);
            transform: translateY(-2px);
        }
        .pm-card.collapsed .pm-body { display: none; }
        .pm-card:not(.collapsed) .pm-body { display: block; }
        .pm-card:not(.collapsed) {
            background: var(--pm-glass-strong);
            border-color: var(--pm-border);
            box-shadow: 0 8px 32px var(--pm-shadow-soft), inset 0 1px 0 var(--pm-highlight);
        }

        .pm-card-header {
            display: flex; align-items: flex-start; gap: 10px;
        }
        .pm-thread-badge {
            flex: none;
            background: linear-gradient(135deg, var(--pm-accent1), var(--pm-accent2));
            color: #fff; border-radius: 50%;
            width: 30px; height: 30px;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700;
            flex-shrink: 0;
            box-shadow: 0 3px 12px var(--pm-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.35);
        }
        .pm-thread-badge.small { font-size: 11px; }
        /* Строка сейчас обновляется: часики крутятся прямо в её кружке. Фон плоский —
           у градиента при вращении «едет» блик, и крутится будто вся плашка. */
        .pm-thread-badge.syncing {
            background: #8a6a18;
            box-shadow: none;
            animation: pm-spin 1.4s linear infinite;
        }
        /* Плашка в очереди — часики стоят; плашка в работе — крутятся. */
        .pm-toggle .pm-toggle-btn.queued { background: #8a8a8a; color: #fff; }
        .pm-toggle .pm-toggle-btn.working {
            background: #8a6a18; color: #fff;
            animation: pm-spin 1.4s linear infinite;
        }
        /* Анимация — украшение: тем, кто её отключил, показываем то же статикой.
           Смысл не теряется — часики на месте, просто не вращаются. */
        @media (prefers-reduced-motion: reduce) {
            .pm-thread-badge.syncing, .pm-toggle .pm-toggle-btn.working { animation: none; }
        }
        /* Переписку в этой почте не нашли — кружок красный. */
        .pm-thread-badge.notfound {
            background: linear-gradient(135deg, #e05555, #b93b3b);
        }
        /* И тема тогда не кликабельна: искать в почте нечего. */
        .pm-card-title.notfound { cursor: default; opacity: 0.75; }
        .pm-card-title {
            flex: 1; font-weight: 600; font-size: 14px; line-height: 1.4;
            word-wrap: break-word; cursor: pointer;
            color: var(--pm-text-strong);
            transition: color 0.2s;
        }
        .pm-card-title:hover {
            color: var(--pm-accent);
            text-decoration: underline;
        }
        .pm-copy-btn {
            flex-shrink: 0;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 13px;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 6px;
            opacity: 0.55;
            transition: opacity 0.15s, background 0.15s;
        }
        .pm-copy-btn:hover { opacity: 1; background: var(--pm-accent-soft); }

        .pm-body {
            margin-top: 12px;
            animation: pm-fade-in 0.25s ease;
        }
        @keyframes pm-fade-in {
            from { opacity: 0; transform: translateY(-6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .pm-meta {
            color: var(--pm-muted); font-size: 12px; line-height: 1.6;
            margin-bottom: 8px;
            display: flex; align-items: center; gap: 12px;
            flex-wrap: wrap;
        }
        .pm-meta .pm-tag {
            background: var(--pm-chip-bg);
            padding: 2px 10px;
            border-radius: 12px;
            color: var(--pm-accent);
            font-size: 11px;
            font-weight: 500;
        }

        .pm-comment-wrap {
            margin-bottom: 10px;
            background: var(--pm-inset);
            border: 1px solid var(--pm-border-soft);
            border-radius: 12px;
            padding: 8px 12px;
        }
        .pm-comment-view {
            display: flex; align-items: flex-start; gap: 8px;
        }
        .pm-comment-text {
            flex: 1; color: var(--pm-text-strong); font-size: 13px; line-height: 1.5;
            word-wrap: break-word;
        }
        .pm-comment-text.empty {
            font-style: italic; opacity: 0.5;
        }
        .pm-comment-edit-btn {
            flex: none; background: none; border: none; cursor: pointer;
            font-size: 13px; padding: 2px 6px; border-radius: 6px;
            line-height: 1.5; opacity: 0.5; color: var(--pm-muted);
            transition: all 0.2s;
        }
        .pm-comment-edit-btn:hover {
            background: var(--pm-accent-soft);
            opacity: 1;
        }
        .pm-comment-input {
            display: block; width: 100%;
            color: var(--pm-text-strong); font-size: 13px; line-height: 1.5;
            padding: 8px 12px; border: 2px solid var(--pm-border);
            border-radius: 10px;
            resize: vertical; min-height: 48px;
            font-family: inherit; outline: none;
            background: var(--pm-field-bg);
            transition: border-color 0.2s;
        }
        .pm-comment-input:focus { border-color: var(--pm-accent); }
        .pm-comment-edit-actions { display: flex; gap: 6px; margin-top: 8px; }
        .pm-comment-error {
            color: var(--pm-danger); font-size: 12px; margin-top: 6px;
            word-wrap: break-word;
        }

        .pm-last-email {
            background: var(--pm-inset);
            border-radius: 12px; padding: 10px 12px;
            margin: 8px 0 12px;
            font-size: 13px; line-height: 1.5;
            color: var(--pm-text-strong);
            min-height: 50px;
            border: 1px solid var(--pm-border-soft);
            transition: all 0.3s;
        }
        .pm-last-email:hover {
            border-color: var(--pm-border);
            background: var(--pm-inset-hover);
        }
        .pm-email-meta {
            display: flex; justify-content: space-between;
            color: var(--pm-muted); font-size: 11px;
            margin-bottom: 4px;
            flex-wrap: wrap;
            gap: 4px;
        }
        .pm-email-preview {
            color: var(--pm-text-strong); font-size: 13px;
            word-break: break-word;
        }
        .pm-email-preview .pm-search-btn {
            margin-top: 6px; width: 100%;
            justify-content: center;
            font-size: 12px;
            padding: 7px 12px;
            border-radius: 10px;
            background: var(--pm-accent-soft);
            color: var(--pm-accent);
            border: 1px solid var(--pm-border-soft);
            cursor: pointer;
            transition: all 0.2s;
            font-weight: 600;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .pm-email-preview .pm-search-btn:hover {
            background: var(--pm-accent-soft-2);
            transform: translateY(-1px);
        }

        .pm-loading {
            display: flex; align-items: center; justify-content: center;
            gap: 10px; color: var(--pm-muted); padding: 6px;
        }
        .pm-loading-spinner {
            width: 16px; height: 16px;
            border: 2px solid var(--pm-accent-soft-2);
            border-top-color: var(--pm-accent);
            border-radius: 50%;
            animation: pm-spin 0.8s linear infinite;
        }
        @keyframes pm-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .pm-actions {
            display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;
        }
        .pm-empty {
            color: var(--pm-muted); text-align: center; padding: 40px 16px;
            font-size: 14px;
        }
        .pm-empty .pm-empty-icon {
            font-size: 40px; margin-bottom: 12px;
            opacity: 0.35;
        }
        .pm-error {
            color: var(--pm-danger); padding: 12px 16px; font-size: 13px;
            background: var(--pm-danger-bg);
            border: 1px solid var(--pm-border-soft);
            border-radius: 12px;
        }
        .pm-orphan-notice {
            margin: 0 0 12px 0; padding: 12px 14px;
            border-radius: 12px;
            background: var(--pm-warn-bg, rgba(224,85,85,0.12));
            color: var(--pm-text-strong);
            font-size: 12px; line-height: 1.45;
            display: flex; flex-direction: column; gap: 10px;
        }
        .pm-orphan-notice button { align-self: flex-start; }
        .pm-cache-info {
            font-size: 10px; color: var(--pm-faint); padding: 6px 20px;
            text-align: right;
            flex-shrink: 0;
            border-top: 1px solid var(--pm-border-soft);
            background: var(--pm-strip-bg);
        }

        .pm-email-preview .pm-preview-text { cursor: pointer; }
        .pm-email-preview .pm-preview-text:hover { color: var(--pm-accent); }
        /* Почта не вернула начало текста — показываем подпись, а не текст письма.
           Курсив и приглушённый цвет: иначе её читают как содержимое письма
           («что значит „письмо найдено“ в теле письма?»). */
        .pm-email-preview .pm-preview-text.pm-preview-missing {
            font-style: italic; opacity: 0.55;
        }

        .pm-toast-wrap {
            position: fixed; right: 24px; bottom: 28px;
            z-index: 2147483003;
            display: flex; flex-direction: column; gap: 8px;
            align-items: flex-end;
        }
        .pm-toast {
            background: rgba(45, 52, 54, 0.9);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: #fff; font-size: 13px; font-weight: 500;
            padding: 10px 16px; border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.14);
            max-width: 320px;
            animation: pm-toast-in 0.2s ease;
        }
        .pm-toast.success { background: rgba(0, 163, 129, 0.92); }
        .pm-toast.error { background: rgba(214, 58, 30, 0.92); }
        .pm-toast { display: flex; align-items: center; }
        .pm-toast-action {
            margin-left: 12px; flex-shrink: 0;
            background: rgba(255,255,255,0.22);
            border: 1px solid rgba(255,255,255,0.4);
            color: #fff; border-radius: 8px;
            padding: 4px 11px; font-size: 12px; font-weight: 700;
            cursor: pointer; font-family: inherit;
            transition: background 0.15s;
        }
        .pm-toast-action:hover { background: rgba(255,255,255,0.36); }
        @keyframes pm-toast-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Перетаскивание письма на панель (drag-and-drop). */
        .pm-toggle.pm-drop-armed {
            background: linear-gradient(135deg, #00c39a, #00a381);
            box-shadow: -2px 10px 34px rgba(0,163,129,0.45), inset 0 1px 0 rgba(255,255,255,0.35);
            transform: translateX(-3px) scale(1.05);
        }
        /* Курсор над язычком — сюда и надо отпустить письмо (панель не открываем). */
        .pm-toggle.pm-drop-over {
            transform: translateX(-10px) scale(1.12);
            outline: 2px dashed rgba(255,255,255,0.9);
            outline-offset: 3px;
            box-shadow: -4px 12px 42px rgba(0,163,129,0.6), inset 0 1px 0 rgba(255,255,255,0.45);
            filter: brightness(1.15);
        }
        .pm-toggle.pm-drop-busy { cursor: progress; }
        .pm-dropzone {
            display: none;
            margin: 10px 16px 4px;
            padding: 20px 16px;
            border: 2px dashed var(--pm-accent);
            border-radius: 14px;
            background: var(--pm-accent-soft);
            color: var(--pm-accent);
            font-weight: 700; font-size: 13.5px; line-height: 1.35;
            text-align: center;
            align-items: center; justify-content: center; gap: 8px;
            flex-shrink: 0;
            transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
        }
        .pm-dropzone.visible { display: flex; }
        .pm-dropzone.hover {
            background: rgba(0,163,129,0.16);
            border-color: #00a381; color: #00a381;
            transform: scale(1.015);
        }
        .pm-dropzone .pm-dropzone-sub {
            display: block; font-weight: 500; font-size: 11.5px;
            color: var(--pm-muted); margin-top: 4px;
        }

        .pm-modal-overlay {
            position: fixed; inset: 0;
            background: var(--pm-scrim);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            z-index: 2147483004;
            display: flex; align-items: center; justify-content: center;
            animation: pm-fade-in 0.15s ease;
        }
        .pm-modal {
            background: var(--pm-modal-bg);
            backdrop-filter: blur(24px) saturate(160%);
            -webkit-backdrop-filter: blur(24px) saturate(160%);
            color: var(--pm-text-strong);
            border: 1px solid var(--pm-border);
            border-radius: 18px; padding: 22px;
            width: 320px; max-width: 90vw;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3), inset 0 1px 0 var(--pm-highlight);
        }
        /* pre-line — чтобы переносы строк в тексте вопроса были видны: длинное
           предупреждение о дубле читается построчно, а не одной простынёй. */
        .pm-modal-text { font-size: 14px; line-height: 1.5; margin-bottom: 16px; white-space: pre-line; }
        .pm-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    `;

    const TEMPLATE = `
        <div class="pm-toggle-stack" id="pm-toggle-stack"></div>
        <div class="pm-quick-done" id="pm-quick-done" title="Пометить выполненным и снять метку — без открытия панели.&#10;Кнопку можно перетащить мышью в удобное место."><span id="pm-quick-done-icon"></span><span>Выполнено</span></div>
        <div class="pm-panel" id="pm-panel">
            <div class="pm-header">
                <span class="pm-icon">✉</span>
                <span class="pm-title"><span id="pm-title-name">Проблемные</span> <span>письма</span></span>
                <div class="pm-header-actions">
                    <button class="pm-btn pm-btn-outline pm-icon-btn" id="pm-theme" title="Светлая/тёмная тема">🌙</button>
                    <button class="pm-btn pm-btn-outline pm-icon-btn" id="pm-backfill" title="Дозаполнить пустые поля из почты">🪄</button>
                    <button class="pm-btn pm-btn-outline pm-icon-btn" id="pm-label-all" title="Проставить метку по всем письмам таблицы">🏷️</button>
                    <button class="pm-btn pm-btn-outline pm-icon-btn" id="pm-refresh" title="Обновить">⟳</button>
                    <button class="pm-btn pm-btn-outline pm-icon-btn" id="pm-toggle-all" title="Свернуть/развернуть все">☰</button>
                    <button class="pm-close" id="pm-close">×</button>
                </div>
            </div>
            <div class="pm-count" id="pm-count"></div>
            <div class="pm-search-wrap" id="pm-search-wrap">
                <span class="pm-search-icon">🔍</span>
                <input class="pm-search" id="pm-search" type="search" placeholder="Поиск по теме, номеру, складу…" autocomplete="off">
                <button class="pm-search-clear" id="pm-search-clear" title="Очистить">×</button>
            </div>
            <div class="pm-controls">
                <select class="pm-select" id="pm-sort" title="Сортировка">
                    <option value="old">Сначала старые</option>
                    <option value="new">Сначала новые</option>
                    <option value="warehouse">По складу</option>
                    <option value="sheet">Как в таблице</option>
                </select>
                <select class="pm-select" id="pm-filter" title="Фильтр по складу">
                    <option value="">Все склады</option>
                </select>
            </div>
            <div class="pm-dropzone" id="pm-dropzone">
                <div id="pm-dropzone-main">
                    <span id="pm-dropzone-text">📥 Отпустите письмо здесь — добавлю в таблицу</span>
                    <span class="pm-dropzone-sub">Дата, склад и вид подтянутся по письму автоматически</span>
                </div>
                <div id="pm-dropzone-busy" style="display:none;"></div>
            </div>
            <div class="pm-list" id="pm-list"></div>
            <div class="pm-cache-info" id="pm-cache-info">💾 Загрузка...</div>
        </div>
    `;

    // === СОЗДАНИЕ SHADOW DOM ===
    function ensureHost() {
        let host = document.getElementById(HOST_ID);
        if (host && host.shadowRoot) {
            return host.shadowRoot;
        }
        
        host = document.createElement('div');
        host.id = HOST_ID;
        document.documentElement.appendChild(host);
        
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>' + CSS + '</style>' + TEMPLATE;
        return shadow;
    }

    const shadow = ensureHost();
    const stackEl = shadow.getElementById('pm-toggle-stack');
    const quickDoneEl = shadow.getElementById('pm-quick-done');
    const quickDoneIconEl = shadow.getElementById('pm-quick-done-icon');

    // === КНОПКА «ВЫПОЛНЕНО» ДЛЯ ОТКРЫТОГО ПИСЬМА (без захода в панель) ===
    // Видна только когда открыто конкретное письмо/ветка — определяем по хэшу адреса
    // (#/message/<id> или #/thread/<id>). Селекторы темы — те же, что в content-capture.js
    // для формы захвата (файлы изолированы друг от друга, копия сознательная).
    const OPEN_SUBJECT_SELECTORS = [
        '[data-testid="message-subject"]',
        '[class*="Title__subject"]',
        '.mail-Message-Toolbar-Subject',
        '.mail-Message-Header h1',
        '.mail-Message-Header-Title',
        '.message__subject'
    ];
    function getOpenMessageId() {
        const m = String(location.hash || '').match(/#\/(?:message|thread)\/(t?\d+)/);
        if (m) return m[1];
        // В раскладке «письмо справа от списка» адрес остаётся на папке или метке
        // (#/label/179), а письмо открывается в правой панели — id из адреса не
        // достать. Ищем его в разметке самого открытого письма.
        const scopes = ['[class*="MessageHead"]', '[class*="Message__root"]', '.mail-Message'];
        for (const sel of scopes) {
            let root;
            try { root = document.querySelector(sel); } catch (e) { continue; }
            if (!root) continue;
            const holder = root.closest('[data-mid],[data-id],[id]') || root;
            const raw = holder.getAttribute && (holder.getAttribute('data-mid') ||
                        holder.getAttribute('data-id') || holder.getAttribute('id'));
            const num = String(raw || '').match(/(t?\d{10,})/);
            if (num) return num[1];
        }
        return '';
    }
    function getOpenEmailSubject() {
        for (const selector of OPEN_SUBJECT_SELECTORS) {
            let el;
            try { el = document.querySelector(selector); } catch (e) { continue; }
            if (!el) continue;
            const s = stripSubjectCounter(el);
            if (s) return s;
        }
        return '';
    }
    // Метка на открытом письме пишется рядом с заголовком и часто с крестиком снятия —
    // отрезаем его и счётчик, иначе «Архив ✕» не совпал бы с «Архив».
    function labelChipKey(text) {
        return normLabelName(String(text || '')
            .replace(/[\s×✕✖]+$/, '')
            .replace(/\s*\d+\s*$/, ''));
    }

    // Тексты меток ОТКРЫТОГО письма (не строки списка).
    function openEmailLabelTexts() {
        // Порядок — от узкого к широкому. Раньше первым шёл MessageViewer (вся ветка
        // целиком), и перебор селекторов меток шёл по сотням узлов открытой переписки.
        const scopes = [
            '[class*="MessageHead"]',
            '[class*="Message__root"]',
            '.mail-Message',
            '[class*="MessageViewer"]'
        ];
        const subject = getOpenEmailSubject();
        for (const sel of scopes) {
            let el = null;
            try { el = document.querySelector(sel); } catch (e) { continue; }
            if (!el) continue;
            const texts = collectRowLabelTexts(el, subject);
            if (texts.length) return texts;
        }
        return [];
    }

    // Кнопка нужна только там, где ей есть что делать: письмо открыто И на нём висит
    // одна из наших меток. Иначе она появлялась на любом письме, а нажатие ничего не
    // давало — строки такого письма в таблице нет.
    // id ВСЕЙ переписки открытого письма. В колонке «ID письма» лежат id тех писем,
    // что были видны в момент перетаскивания, — свежий ответ в ту же ветку туда не
    // попадал, и кнопка «Выполнено» на нём уже не находила свою строку.
    async function openThreadIdSet(openId, openSubject) {
        const set = new Set();
        const bare = stripThreadPrefix(openId);
        if (bare) set.add(bare);
        try {
            const prefer = parseStoredIds(openId);
            const info = await apiGetInfo(openSubject || '', '', null, prefer.any ? prefer : null);
            if (info) {
                if (info.tid) set.add(stripThreadPrefix(info.tid));
                if (info.mid) set.add(stripThreadPrefix(info.mid));
                (await fullThreadIds(info)).forEach(function (x) { set.add(stripThreadPrefix(x)); });
            }
        } catch (e) { /* останется хотя бы id самого письма */ }
        return set;
    }

    // Пересекается ли колонка «ID письма» строки с id этой переписки.
    function rowIdsIntersect(row, idSet) {
        return String(row && row.mailId || '').split(',').some(function (part) {
            const id = stripThreadPrefix(String(part || '').trim());
            return id && idSet.has(id);
        });
    }

    // Открыто ли СЕЙЧАС письмо этой строки. Возвращает id открытого письма или ''.
    //
    // Раньше это сравнение переписывалось вручную в двух местах обработчика
    // «Выполнено», и оба раза без нормализации: колонка «ID письма» хранит и
    // «t123» (ветка), и «ts:…», и «u:…», а getOpenMessageId умеет вернуть «t123»
    // там, где в колонке лежит «123». Совпадение выходило случайным — из-за чего
    // письмо своей же строки часто не опознавалось, не закрывалось после
    // «Выполнено» и не попадало в приметы подметания.
    function openMessageIdOfRow(row) {
        let open = '';
        try { open = String(getOpenMessageId() || ''); } catch (e) { return ''; }
        if (!open) return '';
        const bare = stripThreadPrefix(open);
        return rowIdsIntersect(row, new Set([bare])) ? open : '';
    }

    // Строки таблицы, к которым может относиться ОТКРЫТОЕ письмо.
    //
    // Пробы идут от самой надёжной приметы к самой слабой, и как только какая-то дала
    // результат, дальше не идём. Пустой массив — связать не удалось.
    //
    // Почему понадобился шаг по НОМЕРУ. У строки, заведённой сменщицей, в колонке «ID
    // письма» лежат id ЕЁ ящика (пометка u:<uid>) — в нашей почте они не значат ничего
    // и не совпадут ни с открытым письмом, ни с его веткой. Остаётся тема, но и она
    // расходится: в ответе к теме нередко дописывают второй номер, и получается
    // «СМАРТЛИНК ООО, 0000-0804943 0000-0804939 запрос УПД без НДС» против строки
    // «СМАРТЛИНК ООО, 0000-0804943 запрос УПД без НДС». Ни точного совпадения, ни
    // вхождения одного в другое — лишний номер стоит В СЕРЕДИНЕ. Кнопка честно
    // отвечала «письмо не найдено среди невыполненных строк», хотя строка есть и
    // видна в самой панели.
    //
    // А номер ЗП/перемещения при этом совпадает и стоит в обоих. Он и есть та примета,
    // которая переживает и чужие id, и дописанную тему.
    function rowsForOpenLetter(rows, openId, openSubject, threadIds) {
        const list = Array.isArray(rows) ? rows : [];

        // 1. Сохранённый id письма совпал напрямую. Через rowIdsIntersect, а не
        // сравнением строк: колонка хранит и «t…» (ветка), и ts:/u:, а getOpenMessageId
        // умеет вернуть «t123» там, где в колонке лежит «123».
        const bare = openId ? stripThreadPrefix(openId) : '';
        if (bare) {
            const byId = list.filter(function (r) { return rowIdsIntersect(r, new Set([bare])); });
            if (byId.length) return byId;
        }

        // 2. Любое письмо ТОЙ ЖЕ переписки — «Выполнено» должно срабатывать не только
        // на том письме, которое когда-то перетащили.
        if (threadIds && threadIds.size) {
            const byThread = list.filter(function (r) { return rowIdsIntersect(r, threadIds); });
            if (byThread.length) return byThread;
        }

        const subj = normForMatch(openSubject || '');

        // 3. Номер ЗП/перемещения строки встречается в теме письма.
        if (subj) {
            const byNumber = list.filter(function (r) {
                const num = String(r.number || '').trim() || extractNumberFromTopic(r.topic) || '';
                // В колонку «Номер» иногда пишут произвольный текст (название
                // поставщика) — по нему искать нельзя, подцепим чужую ветку.
                if (!num || !looksLikeOrderNumber(num)) return false;
                const key = normForMatch(num);
                return !!key && subj.indexOf(key) !== -1;
            });
            if (byNumber.length) return byNumber;
        }

        // 4. Тема — сначала точно, потом с запасом (одна содержит другую).
        const want = normForMatch(stripRowSubjectTail(openSubject || ''));
        if (!want) return [];
        const exact = list.filter(function (r) {
            return normForMatch(stripRowSubjectTail(r.topic)) === want;
        });
        if (exact.length) return exact;
        return list.filter(function (r) {
            const t = normForMatch(stripRowSubjectTail(r.topic));
            if (!t || t.length < 8) return false;
            return want.indexOf(t) !== -1 || (want.length >= 8 && t.indexOf(want) !== -1);
        });
    }

    // Опрос кнопки «Выполнено» — самый частый код в панели, и он шарит по разметке
    // открытого письма селекторами вида [class*="Label" i], которые браузер не умеет
    // ускорять. Поэтому: пока адрес письма не менялся и ответ не менялся, опрашиваем
    // редко; сразу после смены письма — часто, пока почта дорисовывает метки.
    let qdLastHash = null;      // адрес на момент прошлого разбора разметки
    let qdHashChangedAt = 0;    // когда открыли другое письмо
    let qdLastScanAt = 0;       // когда в последний раз лазили в разметку
    function quickDoneScanDue() {
        const now = Date.now();
        const hash = String(location.hash || '');
        if (hash !== qdLastHash) {
            qdLastHash = hash;
            qdHashChangedAt = now;
            return true;                       // письмо сменилось — смотрим сразу
        }
        // Первые 10 секунд после открытия письма опрашиваем часто (почта дорисовывает
        // метки не сразу), дальше — раз в 3 секунды.
        const gap = (now - qdHashChangedAt) < 10000 ? 700 : 3000;
        return (now - qdLastScanAt) >= gap;
    }

    // В раскладке «письмо справа от списка» адрес при переходе между письмами не
    // меняется, поэтому смена письма по нему не видна и кнопка обновлялась бы раз в
    // три секунды. Клик по списку — верный признак, что письмо могло смениться:
    // возвращаемся к частому опросу на десять секунд, как при смене адреса.
    document.addEventListener('click', function () {
        qdHashChangedAt = Date.now();
    }, true);

    function updateQuickDoneVisibility(force) {
        if (!quickDoneEl) return;
        if (!force && !quickDoneScanDue()) return;
        qdLastScanAt = Date.now();
        // Настройки меток объявлены ниже по файлу — до их инициализации просто ждём
        // (иначе первый же вызов падал бы и обрывал остальную настройку панели).
        let names = [];
        try { names = (labelCfg && labelCfg.names) || []; } catch (e) { return; }
        let show = false;
        // Раньше кнопка требовала id письма из адреса. В раскладке «письмо справа от
        // списка» его там нет, и кнопка не появлялась вовсе — хотя письмо открыто и
        // метка на нём есть. Обработчик клика давно умеет работать и по теме, так что
        // показываем кнопку по тому же признаку: есть id ИЛИ тема открытого письма.
        if ((getOpenMessageId() || getOpenEmailSubject()) && names.length) {
            const onEmail = openEmailLabelTexts().map(labelChipKey);
            show = names.some(function (n) {
                return onEmail.indexOf(labelChipKey(n)) !== -1;
            });
        }
        quickDoneEl.classList.toggle('visible', show);
    }
    // Ставим кнопку сразу под стопкой язычков (не в углу экрана отдельно) — измеряем
    // её реальную высоту, а не жёстко считаем в CSS: язычков может быть 1, а может 5.
    function positionQuickDoneUnderToggles() {
        if (!quickDoneEl || !stackEl) return;
        // Кнопку передвинули руками — держим её там, где оставил пользователь.
        if (quickDonePos) { applyQuickDonePos(); return; }
        const rect = stackEl.getBoundingClientRect();
        if (rect.height > 0) {
            quickDoneEl.style.top = (rect.bottom + 10) + 'px';
        }
    }
    window.addEventListener('resize', function () {
        if (quickDonePos) clampQuickDonePos();
        positionQuickDoneUnderToggles();
    });

    // === ПЕРЕТАСКИВАНИЕ КНОПКИ «ВЫПОЛНЕНО» ===
    // Место кнопки — личная настройка: хранится в local (не в sync), поэтому у каждого
    // своё и коллегам не переезжает. Не трогали — остаётся под язычками, как было.
    let quickDonePos = null;   // { x, y } — левый верхний угол кнопки, в пикселях

    // Вид кнопки «Выполнено» из настроек: цвет, цвет текста, непрозрачность.
    // Не задан — остаётся зелёная по умолчанию (как в стилях панели).
    function applyQuickDoneSkin() {
        if (!quickDoneEl) return;
        // labelCfg объявлен ниже по файлу (let) — до его инициализации обращение
        // бросает ReferenceError и обрывает построение панели целиком.
        let cfg = null;
        try { cfg = labelCfg; } catch (e) { return; }
        const st = cfg && cfg.quickDone;
        if (!st || !st.color) {
            quickDoneEl.style.background = '';
            quickDoneEl.style.color = '';
            return;
        }
        const pct = Math.max(10, Math.min(100, Number(st.opacity) || 100));
        quickDoneEl.style.background = hexToRgba(st.color, pct / 100);
        quickDoneEl.style.color = st.textColor || '#ffffff';
        quickDoneEl.style.border = 'none';
    }

    // Вид полосы «Обновить метки» из настроек. Красное состояние настройкой не
    // перебиваем: красный — это сигнал «в таблице что-то менялось», а не оформление.
    function applySyncAllSkin() {
        if (!syncAllEl) return;
        let cfg = null;
        try { cfg = labelCfg; } catch (e) { return; }
        const st = cfg && cfg.syncAll;
        if (!st || !st.color || syncAllEl.classList.contains('stale')) {
            syncAllEl.style.background = '';
            syncAllEl.style.color = '';
            return;
        }
        const pct = Math.max(10, Math.min(100, Number(st.opacity) || 100));
        syncAllEl.style.background = hexToRgba(st.color, pct / 100);
        syncAllEl.style.color = st.textColor || '#ffffff';
    }

    function applyQuickDonePos() {
        if (!quickDoneEl || !quickDonePos) return;
        quickDoneEl.style.left = quickDonePos.x + 'px';
        quickDoneEl.style.top = quickDonePos.y + 'px';
        quickDoneEl.style.right = 'auto';
        // Кнопку «прилепили» к правому краю скруглением — сдвинутая по экрану она
        // должна выглядеть цельной плашкой.
        quickDoneEl.style.borderRadius = '14px';
    }

    // После смены размера окна кнопка не должна оказаться за экраном.
    function clampQuickDonePos() {
        if (!quickDoneEl || !quickDonePos) return;
        const w = quickDoneEl.offsetWidth || 120;
        const h = quickDoneEl.offsetHeight || 44;
        quickDonePos.x = Math.max(0, Math.min(quickDonePos.x, window.innerWidth - w));
        quickDonePos.y = Math.max(0, Math.min(quickDonePos.y, window.innerHeight - h));
        applyQuickDonePos();
    }

    function saveQuickDonePos() {
        try { chrome.storage.local.set({ quickDonePos: quickDonePos }); } catch (e) { /* не критично */ }
    }

    function initQuickDoneDrag() {
        if (!quickDoneEl) return;
        try {
            chrome.storage.local.get(['quickDonePos'], function (st) {
                const p = st && st.quickDonePos;
                if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                    quickDonePos = { x: p.x, y: p.y };
                    clampQuickDonePos();
                }
            });
        } catch (e) { /* не критично */ }

        let drag = null;   // { dx, dy, moved }
        quickDoneEl.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || quickDoneEl.classList.contains('busy')) return;
            const rect = quickDoneEl.getBoundingClientRect();
            drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
            try { quickDoneEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        quickDoneEl.addEventListener('pointermove', function (e) {
            if (!drag) return;
            const x = e.clientX - drag.dx;
            const y = e.clientY - drag.dy;
            // Пока не увели курсор на 4 пикселя — это ещё клик, а не перетаскивание.
            if (!drag.moved) {
                const rect = quickDoneEl.getBoundingClientRect();
                if (Math.abs(x - rect.left) < 4 && Math.abs(y - rect.top) < 4) return;
                drag.moved = true;
                // На время перетаскивания глушим hover-анимацию — иначе плашка
                // «убегает» от курсора на свои же transform-сдвиги.
                quickDoneEl.style.transition = 'none';
            }
            quickDonePos = { x: x, y: y };
            clampQuickDonePos();
        });
        function endDrag(e) {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            quickDoneEl.style.transition = '';
            try { quickDoneEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            if (moved) {
                saveQuickDonePos();
                // Клик после перетаскивания не должен «выполнять» письмо.
                quickDoneEl._pmSkipClick = true;
                setTimeout(function () { quickDoneEl._pmSkipClick = false; }, 0);
            }
        }
        quickDoneEl.addEventListener('pointerup', endDrag);
        quickDoneEl.addEventListener('pointercancel', endDrag);

        // Возврата «на место» по двойному клику нет намеренно: двойной клик — это два
        // обычных клика, и первый же отмечал письмо выполненным. Кому нужно другое
        // место — просто перетаскивает кнопку обратно.
    }
    initQuickDoneDrag();
    setTimeout(applyQuickDoneSkin, 0);   // после инициализации настроек меток
    if (quickDoneEl) {
        // hashchange не срабатывает, когда почта меняет адрес через свой внутренний
        // роутинг (history.pushState при обычном клике по письму) — событие браузер
        // генерирует только при прямом присваивании location.hash (как в нашей кнопке
        // «Перейти к последнему письму»). Поэтому опрашиваем адрес сами.
        window.addEventListener('hashchange', function () { updateQuickDoneVisibility(true); });
        // Тик частый, но внутри стоит своя проверка «пора ли»: пока письмо и ответ не
        // менялись, разметку не трогаем совсем.
        setInterval(function () { updateQuickDoneVisibility(false); }, 700);
        // Первую проверку откладываем на конец текущего кадра: к этому моменту
        // инициализация панели дошла до настроек меток.
        setTimeout(function () { updateQuickDoneVisibility(true); }, 0);

        quickDoneEl.onclick = async function () {
            if (quickDoneEl.classList.contains('busy')) return;
            if (quickDoneEl._pmSkipClick) return;   // это было перетаскивание, не клик
            const openId = getOpenMessageId();
            const openSubject = getOpenEmailSubject();
            if (!openId && !openSubject) {
                showToast('Не удалось определить письмо — откройте его целиком', 'error');
                return;
            }
            quickDoneEl.classList.add('busy');
            if (quickDoneIconEl) quickDoneIconEl.textContent = '⏳';
            try {
                const res = await send({ type: 'pm-list-all' });
                const rows = ((res && res.ok && res.rows) || []).filter(function (row) { return !row.done; });
                // Ветку открытого письма спрашиваем сразу: она нужна второй пробой,
                // а лишний запрос тут дешевле, чем ещё один круг сопоставления.
                let threadIds = null;
                if (openId) {
                    try { threadIds = await openThreadIdSet(openId, openSubject); }
                    catch (e) { threadIds = null; }
                }
                const matches = rowsForOpenLetter(rows, openId, openSubject, threadIds);
                if (!matches.length) {
                    showToast('Это письмо не найдено среди невыполненных строк таблицы', 'error');
                    return;
                }
                // Несколько строк — это НЕ ошибка и не повод отказываться.
                //
                // Одно письмо часто относится к нескольким заказам сразу: в теме
                // «СМАРТЛИНК ООО, 0000-0804943 0000-0804939 запрос УПД без НДС» два
                // номера, и в таблице под них две строки. Раньше кнопка на это отвечала
                // «отметьте вручную в панели» — то есть находила всё, что нужно, и
                // отправляла человека делать работу руками. Спрашиваем и закрываем все.
                if (matches.length > 1) {
                    const list = matches.map(function (x) {
                        return '• ' + String(x.topic || '').slice(0, 70);
                    }).join('\n');
                    const yes = await pmConfirm('Письмо относится к ' + matches.length + ' строкам:\n\n' +
                        list + '\n\nОтметить их выполненными?');
                    if (!yes) return;
                }

                let openMid = null;
                try { openMid = getOpenMessageId(); } catch (e) { openMid = null; }

                const closed = [];
                const failed = [];
                for (const r of matches) {
                    const doneRes = await send({ type: 'pm-markDone', rowNumber: r.sheetRow, topic: r.topic });
                    if (!doneRes || !doneRes.ok) {
                        failed.push({ row: r, error: (doneRes && doneRes.error) || 'неизвестная' });
                        continue;
                    }
                    noteSelfLabelChange(r.label || labelCfg.names[0] || '');
                    // Таблица уже отмечена — плашку метки убираем с экрана СРАЗУ, не
                    // дожидаясь поиска письма и ответа почты (это пара секунд). Не
                    // получится снять — вернём её на место.
                    // Строку письма подметание опознаёт само: по id открытого письма
                    // (самый точный источник — оно сейчас на экране), а если id не
                    // подойдут (строку заводила сменщица, у неё свои) — по теме, дате
                    // письма и началу текста.
                    const hiddenChips = hideLabelChipsFor(
                        r.label ? [r.label] : labelCfg.names, 6000, labelScopeForRow(r, openMid));
                    applyLabelForTopic(r.topic, r.number, false, r.dateAdded,
                                       r.label || '', r.mailId || '', r.preview || '')
                        .then(function (lr) {
                            if (!lr || !lr.ok) { restoreLabelChips(hiddenChips); return; }
                            // Метки в почте больше нет — теперь заставляем почту это
                            // показать, а не только прячем плашку у себя.
                            refreshAfterDone();
                        })
                        .catch(function () { restoreLabelChips(hiddenChips); });

                    // Если строка сейчас видна в открытой панели — уберём карточку.
                    const card = listEl.querySelector('.pm-card[data-row-number="' +
                                                      cssEscape(String(r.sheetRow)) + '"]');
                    if (card) card.style.display = 'none';
                    latestRows = latestRows.filter(function (x) { return x.sheetRow !== r.sheetRow; });
                    MEMORY_CACHE.results.delete(String(r.sheetRow));
                    MEMORY_CACHE.updatedAt.delete(String(r.sheetRow));
                    closed.push({ row: r, card: card });
                }
                updateBadges();
                saveCacheToStorage();

                if (failed.length) {
                    showToast('Не удалось отметить ' + failed.length + ' из ' + matches.length +
                              ': ' + failed[0].error, 'error');
                }
                if (!closed.length) return;

                // Письмо отработано — закрываем его, как было раньше.
                closeOpenLetterAfterDone();

                // Отмена одной кнопкой на всё, что закрыли этим нажатием.
                const label = closed.length === 1
                    ? ('✅ «' + closed[0].row.topic + '» отмечено выполненным')
                    : ('✅ Отмечено выполненными: ' + closed.length);
                showActionToast(label, 'Отмена', function () {
                    closed.forEach(function (it) {
                        const r = it.row;
                        send({ type: 'pm-unmarkDone', rowNumber: r.sheetRow, topic: r.topic })
                            .then(function (res2) {
                                if (!res2 || !res2.ok) {
                                    showToast('Не удалось отменить: ' +
                                              (res2 && res2.error ? res2.error : 'ошибка'), 'error');
                                    return;
                                }
                                noteSelfLabelChange(r.label || labelCfg.names[0] || '');
                                applyLabelForTopic(r.topic, r.number, true, r.dateAdded,
                                                   r.label || '', r.mailId || '', r.preview || '');
                                if (!latestRows.some(function (x) { return x.sheetRow === r.sheetRow; })) {
                                    latestRows.push(r);
                                }
                                if (it.card) it.card.style.display = '';
                                updateBadges();
                                showToast('Отменено', 'success');
                            })
                            .catch(function (err) {
                                showToast('Не удалось отменить: ' + err.message, 'error');
                            });
                    });
                }, 'success', 8000);
            } catch (e) {
                showToast('Ошибка: ' + friendlyErrorMessage(e), 'error');
            } finally {
                quickDoneEl.classList.remove('busy');
                if (quickDoneIconEl) quickDoneIconEl.textContent = '';   // без эмодзи, только «Выполнено»
            }
        };
    }
    const panelEl = shadow.getElementById('pm-panel');
    const closeEl = shadow.getElementById('pm-close');
    const refreshEl = shadow.getElementById('pm-refresh');
    const backfillEl = shadow.getElementById('pm-backfill');
    const labelAllEl = shadow.getElementById('pm-label-all');
    const toggleAllEl = shadow.getElementById('pm-toggle-all');
    const countEl = shadow.getElementById('pm-count');
    const listEl = shadow.getElementById('pm-list');
    const cacheInfoEl = shadow.getElementById('pm-cache-info');
    const sortEl = shadow.getElementById('pm-sort');
    const filterEl = shadow.getElementById('pm-filter');
    const themeEl = shadow.getElementById('pm-theme');
    const searchEl = shadow.getElementById('pm-search');
    const searchWrapEl = shadow.getElementById('pm-search-wrap');
    const searchClearEl = shadow.getElementById('pm-search-clear');
    const dropzoneEl = shadow.getElementById('pm-dropzone');
    const dropzoneMainEl = shadow.getElementById('pm-dropzone-main');
    const dropzoneTextEl = shadow.getElementById('pm-dropzone-text');
    const dropzoneBusyEl = shadow.getElementById('pm-dropzone-busy');
    const titleNameEl = shadow.getElementById('pm-title-name');

    // === ЯЗЫЧКИ ПО МЕТКАМ ===
    // Плашка в почте называется именем метки. Метки задаются списком в настройках,
    // поэтому плашек столько же, сколько меток, и в том же порядке. Поведение у всех
    // одинаковое: клик открывает одну общую панель, перетаскивание добавляет письмо
    // в таблицу и вешает на него ИМЕННО ЭТУ метку.
    const TOGGLE_DEFAULT_LABEL = 'Проблемные';
    let TOGGLES = [];                              // [{ el, iconEl, labelEl, badgeEl, btnEl, name }]
    let syncAllEl = null;                          // вертикальная кнопка «обновить все метки»

    function renderSyncAllFace(el, progress, staleCount) {
        if (!el) return;
        if (progress) { el.textContent = '🏷️ Обновляю ' + progress; return; }
        // Число в скобках — сколько плашек изменилось в таблице. Кнопка при этом
        // проверяет ВСЕ: изменения в почте (метку сняли руками) отсюда не видны.
        el.textContent = staleCount > 0
            ? ('🏷️ Обновить метки (' + staleCount + ')')
            : '🏷️ Обновить метки';
    }

    let labelCfg = { enabled: false, names: [] };  // кэш настроек меток
    let activeToggle = null;                       // язычок, к которому относится панель
    let draggingNow = false;                       // идёт перетаскивание письма

    // Оформление плашки метки из настроек: цвет фона, его непрозрачность и цвет
    // текста. Возвращает null, если для метки цвет не выбран — тогда работает
    // штатное оформление панели.
    function labelSkin(name) {
        const key = String(name || '').toLowerCase();
        const bg = labelCfg.colors && labelCfg.colors[key];
        if (!bg) return null;
        const text = (labelCfg.textColors && labelCfg.textColors[key]) || '#ffffff';
        let pct = labelCfg.opacity && labelCfg.opacity[key];
        pct = (pct === undefined || pct === null) ? 100 : Math.max(10, Math.min(100, Number(pct) || 100));
        // Подложку счётчика подбираем под ЯРКОСТЬ выбранного текста, а не по строгому
        // «белый или нет»: цвет текста теперь любой. Тёмные буквы → тёмная подложка,
        // светлые → светлая (светлая накладка на светлом фоне попросту не видна).
        const ink = isLightColor(text) ? '255,255,255' : '0,0,0';
        return {
            background: hexToRgba(bg, pct / 100),
            text: text,
            // Рамок нет: плашка держится на цвете и тени. Раньше поверх CSS ложилась
            // ещё и инлайновая окантовка — по левому краю она читалась как лишняя
            // светлая полоска.
            border: 'none',
            // Подложка счётчика — лёгкая: при 0.28 она забивала цифру, особенно на
            // пастельных плашках со своим цветом текста.
            badgeBg: 'rgba(' + ink + ',0.14)',
            badgeBorder: 'none'
        };
    }

    // Светлый ли цвет — по воспринимаемой яркости (формула W3C для контраста).
    // Неразобранный цвет считаем светлым: по умолчанию текст на плашках белый.
    function isLightColor(hex) {
        const h = String(hex || '').trim().replace(/^#/, '');
        const full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
        if (!/^[0-9a-f]{6}$/i.test(full)) return true;
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
    }

    // #rrggbb (или #rgb) + прозрачность → rgba(). Непрозрачность 100 % оставляем
    // как есть, чтобы не плодить лишние rgba в разметке.
    function hexToRgba(hex, alpha) {
        const h = String(hex || '').trim().replace(/^#/, '');
        const full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
        if (!/^[0-9a-f]{6}$/i.test(full)) return hex;
        if (alpha >= 1) return '#' + full;
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.round(alpha * 100) / 100 + ')';
    }

    // Лицо язычка: во время перетаскивания — 📥, во время добавления — ⏳ и текст
    // прогресса, в покое — ✉ и имя метки. Цвет всей плашки берётся из настроек.
    function renderToggleFace(t) {
        if (t.busy) {
            t.iconEl.textContent = '⏳';
            t.labelEl.textContent = t.busyText || 'Добавляю…';
            t.el.style.background = '';
            return;
        }
        t.iconEl.textContent = draggingNow ? '📥' : '✉';
        t.labelEl.textContent = t.name || TOGGLE_DEFAULT_LABEL;
        // Применяем цвет метки из настроек ко всей плашке
        const skin = labelSkin(t.name);
        if (skin) {
            t.el.style.background = skin.background;
            t.el.style.color = skin.text;
            t.el.style.border = skin.border;
            t.el.style.borderRight = 'none';
            t.badgeEl.style.background = skin.badgeBg;
            t.badgeEl.style.color = skin.text;
            t.badgeEl.style.border = skin.badgeBorder;
        } else {
            t.el.style.background = '';
            t.el.style.color = '';
            t.el.style.border = '';
            t.el.style.borderRight = '';
            t.badgeEl.style.background = '';
            t.badgeEl.style.color = '';
            t.badgeEl.style.border = '';
        }
    }

    // Строки, относящиеся к метке. Считаем по колонке «Метка» в таблице; строки
    // без неё (добавленные до появления колонки) относим к ПЕРВОЙ метке — иначе
    // старые письма не попали бы ни в одну плашку.
    function labelHasPill(labelKey) {
        return (labelCfg.names || []).some(function (n) { return normLabelName(n) === labelKey; });
    }

    // opts.strict — для ДЕЙСТВИЙ (простановка меток, слепок синхронизации): берём
    // только свои строки. Без strict — для ПОКАЗА: сюда же попадают «беспризорные»
    // строки, у которых метка есть, но плашки под неё нет.
    //
    // Раньше такие строки не попадали НИКУДА: бейдж расширения считал их (94), а в
    // плашках их не было вовсе — «сверху одно число, в плашках другое, и обновление
    // будто не работает». Так бывает, когда список плашек поменяли (у себя или у
    // сменщицы), а в таблице остались строки со старыми метками.
    function rowsOfLabel(rows, labelName, opts) {
        const list = Array.isArray(rows) ? rows : [];
        if (labelCfg.names.length <= 1) return list;
        const strict = !!(opts && opts.strict);
        const want = normLabelName(labelName || '');
        const isFirst = normLabelName(labelCfg.names[0] || '') === want;
        return list.filter(function (r) {
            const has = normLabelName(r.label || '');
            if (!has) return isFirst;               // строка без метки — за первой плашкой
            if (has === want) return true;
            // Метка есть, плашки под неё нет: показываем в первой плашке, но метку
            // первой плашки на такие письма НЕ ставим — у них своя.
            return !strict && isFirst && !labelHasPill(has);
        });
    }

    // Строки, метка которых не соответствует ни одной плашке.
    function orphanRows(rows) {
        return (Array.isArray(rows) ? rows : []).filter(function (r) {
            const has = normLabelName(r.label || '');
            return has && !labelHasPill(has);
        });
    }

    // === «МЕТКИ УСТАРЕЛИ» ===
    // Работая в одиночку, видишь: сколько строк в таблице — столько писем с меткой в
    // почте. Вдвоём (или назавтра) таблица уже другая, а метки в ТВОЕЙ почте прежние,
    // и понять это без нажатия 🏷️ было нельзя. Поэтому после каждой удачной
    // синхронизации запоминаем состав строк плашки; пока он тот же — кнопка спокойная,
    // изменился (коллега добавила письмо или закрыла своё) — красная.
    // Слепок хранится в local: он про ЭТУ почту, у сменщицы своя картина.
    let labelSyncMarks = {};        // метка → слепок на момент последней синхронизации
    const LABEL_SYNC_KEY = 'labelSyncMarks';

    function labelRowsSignature(labelName) {
        return rowsOfLabel(latestRows, labelName, { strict: true })
            .map(function (r) { return String(r.sheetRow); })
            .sort()
            .join(',');
    }

    // Метки, состав которых меняли МЫ САМИ (перетащили письмо, нажали «Выполнено»,
    // отменили). Метку при этом расширение уже поставило или сняло, так что краснеть
    // не из-за чего: при следующей загрузке строк слепок просто перезапишется.
    const selfChangedLabels = new Set();
    function noteSelfLabelChange(labelName) {
        const key = normLabelName(labelName);
        if (key) selfChangedLabels.add(key);
    }

    // Вызывается после КАЖДОЙ удачной загрузки строк: к этому моменту таблица уже
    // содержит наши правки, поэтому слепок можно смело обновить.
    function adoptSelfLabelChanges() {
        if (!selfChangedLabels.size) return;
        let touched = false;
        labelCfg.names.forEach(function (n) {
            const key = normLabelName(n);
            if (!selfChangedLabels.has(key)) return;
            // Плашку, которую ни разу не синхронизировали, не начинаем отслеживать
            // здесь: иначе первое же перетаскивание включало бы слежение задним числом.
            if (labelSyncMarks[key] === undefined) return;
            labelSyncMarks[key] = labelRowsSignature(n);
            touched = true;
        });
        selfChangedLabels.clear();
        if (touched) {
            try { chrome.storage.local.set({ [LABEL_SYNC_KEY]: labelSyncMarks }); } catch (e) { /* не критично */ }
        }
    }

    function markLabelSynced(labelName) {
        const key = normLabelName(labelName);
        if (!key) return;
        labelSyncMarks[key] = labelRowsSignature(labelName);
        try { chrome.storage.local.set({ [LABEL_SYNC_KEY]: labelSyncMarks }); } catch (e) { /* не критично */ }
    }

    // Нужна ли синхронизация.
    // Слепка ещё нет — значит в ЭТОЙ почте метки этой плашки не проставляли ни разу
    // (плашку только что завели, или расширение поставили недавно). Раньше в этом
    // случае молчали, чтобы не заливать всё красным на пустом месте, — и получалось
    // ровно наоборот: письмо коллеги легло в новую плашку, счётчик вырос, а сигнала
    // нет. Поэтому теперь: писем нет — молчим (синхронизировать нечего), письма
    // есть — красное. Одно нажатие 🏷️ и плашка успокаивается.
    function labelNeedsSync(labelName) {
        const key = normLabelName(labelName);
        if (!key) return false;
        const sig = labelRowsSignature(labelName);
        if (labelSyncMarks[key] === undefined) return sig !== '';
        return labelSyncMarks[key] !== sig;
    }

    function updateSyncMarks() {
        const staleNames = [];
        TOGGLES.forEach(function (t) {
            if (!t.name) return;
            const stale = labelNeedsSync(t.name);
            if (stale) staleNames.push(t.name);
            if (t.btnEl) {
                t.btnEl.classList.toggle('stale', stale);
                t.btnEl.title = stale
                    ? 'Состав писем этой плашки изменился — метки в почте устарели. Нажмите, чтобы обновить.'
                    : 'Синхронизировать метку «' + t.name + '» с таблицей';
            }
        });
        if (syncAllEl) {
            // Полоса доступна ВСЕГДА, когда плашек больше одной. Раньше она появлялась
            // только при изменениях в таблице — а самый частый повод обновить всё
            // (метки сняли руками в почте) расширение как раз и не видит, и нажать
            // было нечего. Красный цвет остался подсказкой «здесь что-то менялось»,
            // но нажать можно в любой момент.
            const labelCount = TOGGLES.filter(function (t) { return !!t.name; }).length;
            syncAllEl.classList.toggle('available', labelCount > 1);
            syncAllEl.classList.toggle('stale', staleNames.length > 0);
            syncAllEl.title = staleNames.length
                ? ('Изменения в: ' + staleNames.join(', ') + '. Нажмите, чтобы проверить все метки.')
                : 'Проверить все метки (в таблице изменений нет, но в почте их могли снять вручную)';
            // Во время прогона на кнопке счётчик «3/5» — не затираем его.
            if (!syncAllEl.classList.contains('busy')) {
                renderSyncAllFace(syncAllEl, '', staleNames.length);
            }
            applySyncAllSkin();
        }
    }

    try {
        chrome.storage.local.get([LABEL_SYNC_KEY], function (st) {
            if (st && st[LABEL_SYNC_KEY] && typeof st[LABEL_SYNC_KEY] === 'object') {
                labelSyncMarks = st[LABEL_SYNC_KEY];
                updateSyncMarks();
            }
        });
    } catch (e) { /* не критично */ }

    // Счётчик на каждой плашке — число невыполненных писем именно её метки.
    function updateBadges() {
        const failed = !!latestLoadError && !latestRows.length;
        const waiting = !rowsEverLoaded && !latestRows.length && !latestLoadError;
        TOGGLES.forEach(function (t) {
            t.badgeEl.textContent = failed ? '—'
                : (waiting ? '…' : String(rowsOfLabel(latestRows, t.name).length));
            t.badgeEl.title = failed ? ('Таблица не прочиталась: ' + latestLoadError)
                : (waiting ? 'Читаю таблицу…' : '');
        });
        updateSyncMarks();
    }

    function togglePanel() {
        panelEl.classList.toggle('open');
        isPanelOpen = panelEl.classList.contains('open');
        // Наблюдатель за разметкой почты нужен только при открытой панели.
        ensureObserver();
        if (isPanelOpen) {
            // При открытии подтягиваем свежие строки из таблицы, а не только
            // перепроверяем почту по уже загруженным — иначе новые письма не видно.
            autoRefresh(true);
        }
    }

    // Панель одна на все метки, поэтому запоминаем, с какого язычка её открыли или
    // на какой сейчас целятся: его метку и получит письмо, бро́шенное в саму панель.
    function setActiveToggle(t) {
        if (!t || activeToggle === t) return;
        activeToggle = t;
        updatePanelTitle();
        updateDropzoneHint();
    }

    // Панель одна на все метки, поэтому она подписывается именем той плашки, из
    // которой её открыли, и показывает её письма — иначе «Запрос скана» открывался
    // с заголовком «Проблемные» и чужим списком.
    function updatePanelTitle() {
        if (!titleNameEl) return;
        titleNameEl.textContent = (activeToggle && activeToggle.name) || TOGGLE_DEFAULT_LABEL;
    }

    function updateDropzoneHint() {
        if (!dropzoneTextEl) return;
        const n = activeToggle && activeToggle.name;
        dropzoneTextEl.textContent = n
            ? '📥 Отпустите письмо здесь — добавлю в таблицу и поставлю «' + n + '»'
            : '📥 Отпустите письмо здесь — добавлю в таблицу';
    }

    // Кнопка простановки меток в шапке панели нужна только когда меток НЕ задано
    // (плашка одна и без имени). Как только есть хотя бы одна именованная метка,
    // кнопка 🏷️ живёт прямо на плашке (по кнопке на метку) — и для одной метки тоже.
    function updateHeaderLabelBtn() {
        const hasNamed = labelCfg.names.length >= 1;
        labelAllEl.style.display = hasNamed ? 'none' : '';
        const n = labelCfg.names[0] || '';
        labelAllEl.title = n
            ? 'Синхронизировать метку «' + n + '» с таблицей'
            : 'Синхронизировать метки с таблицей';
    }

    function buildToggles() {
        const names = labelCfg.names.slice();
        // Меток не задано — оставляем одну плашку с прежним названием.
        const specs = names.length ? names : [''];
        // Кнопка 🏷️ живёт на КАЖДОЙ именованной плашке — и когда метка одна тоже
        // (раньше при одной метке кнопка пряталась в шапку панели).
        const showBulkBtn = names.length >= 1;
        const prevName = activeToggle && activeToggle.name;

        stackEl.innerHTML = '';
        TOGGLES = [];
        syncAllEl = null;


        // Плашек больше одной — над стопкой встаёт полоса «обновить все». В смену с
        // семью плашками жать 🏷️ на каждой слишком долго. Полоса скрыта, пока
        // плашка одна (см. .pm-sync-all в стилях): для одной метки полоса была бы
        // вторым способом нажать её собственную кнопку 🏷️.
        if (names.length > 1) {
            const bar = document.createElement('div');
            bar.className = 'pm-sync-all';
            renderSyncAllFace(bar, '');
            bar.addEventListener('click', function (e) {
                e.stopPropagation();
                syncAllLabels(bar);
            });
            stackEl.appendChild(bar);
            syncAllEl = bar;
        }

        // Колонка плашек — под полосой.
        const col = document.createElement('div');
        col.className = 'pm-toggle-col';
        stackEl.appendChild(col);
        specs.forEach(function (name) {
            const el = document.createElement('div');
            el.className = 'pm-toggle';

            const iconEl = document.createElement('span');
            const labelEl = document.createElement('span');
            const badgeEl = document.createElement('span');
            badgeEl.className = 'pm-badge';
            el.appendChild(iconEl);
            el.appendChild(labelEl);
            el.appendChild(badgeEl);

            const t = { el: el, iconEl: iconEl, labelEl: labelEl, badgeEl: badgeEl,
                        btnEl: null, name: name, busy: false, busyText: '' };

            if (showBulkBtn && name) {
                const btn = document.createElement('button');
                btn.className = 'pm-toggle-btn';
                btn.textContent = '🏷️';
                btn.title = 'Синхронизировать метку «' + name + '» с таблицей: поставить на свои письма, снять с чужих';
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();  // клик по кнопке не должен открывать панель
                    bulkApplyLabels(name, btn);
                });
                el.appendChild(btn);
                t.btnEl = btn;
            }

            el.addEventListener('click', function () {
                // Панель открыта из другой плашки — не закрываем её, а переключаемся.
                if (isPanelOpen && activeToggle !== t) {
                    setActiveToggle(t);
                    render(latestRows, null);
                    autoRefresh(true);
                    return;
                }
                setActiveToggle(t);
                togglePanel();
            });
            attachToggleDnD(t);

            renderToggleFace(t);
            col.appendChild(el);
            TOGGLES.push(t);
        });

        // Сохраняем выбранный язычок между перестроениями (настройки могли измениться).
        const same = TOGGLES.find(function (t) { return t.name === prevName; });
        activeToggle = same || TOGGLES[0] || null;
        updateBadges();
        updateHeaderLabelBtn();
        updatePanelTitle();
        updateDropzoneHint();
        positionQuickDoneUnderToggles();
    }

    // Перечитывает настройки меток и перестраивает язычки.
    async function reloadLabelCfg() {
        labelCfg = await getLabelConfig();
        buildToggles();
        applyQuickDoneSkin();
    }

    // === НОВЫЕ МЕТКИ КОЛЛЕГ ===
    // Колонка «Метка» в таблице заполняется сама — в неё пишется метка плашки, на
    // которую письмо было брошено (см. README). Если коллега в свою смену завела
    // НОВУЮ метку (плашку) в СВОИХ настройках расширения — эти настройки локальные
    // (chrome.storage.sync), у второго пользователя её нет, и в таблице появляются
    // строки с меткой, которой нет в списке «Метки на письме». Раньше это заметили бы
    // только вручную, открыв настройки и таблицу. Теперь при обновлении данных панель
    // сама сравнивает метки строк со своим списком и предлагает МОДАЛЬНЫМ ОКНОМ (как
    // подтверждение «Выполнено») добрать недостающие — без похода в настройки. Именно
    // окно, а не тост: тост легко пропустить и он сам закрывается, а тут решение
    // важное (правит настройки), поэтому окно ждёт явного клика.
    let SUGGESTION_MODAL_SHOWING = false;

    // Метки строк, которых нет в текущем labelCfg.names (без повторов, в порядке
    // первого появления).
    // Похоже ли значение на настоящую метку (текст, который человек вписал в
    // настройках), а не на число/дату. Иногда колонка «Метка» физически совпадает или
    // соседствует с другой колонкой (напр. «Дата»/«Вид») из-за настройки полей —
    // тогда в неё попадает то серийный номер даты Google Sheets (дни с 1899г. + доля
    // суток, отсюда вид «46246.604...»), то число вида/номера. Такие значения — НЕ
    // метки, предлагать их для «плашек» нельзя.
    function looksLikeLabelCandidate(s) {
        const t = String(s || '').trim();
        if (!t) return false;
        if (/^-?\d+([.,]\d+)?$/.test(t)) return false; // чисто число или дробь (в т.ч. серийная дата)
        return true;
    }

    function collectUnknownLabelsFromRows(rows) {
        const known = new Set((labelCfg.names || []).map(normLabelName));
        const out = [];
        const seen = new Set();
        (Array.isArray(rows) ? rows : []).forEach(function (r) {
            const raw = String((r && r.label) || '').trim();
            if (!raw || !looksLikeLabelCandidate(raw)) return;
            const key = normLabelName(raw);
            if (!key || known.has(key) || seen.has(key)) return;
            seen.add(key);
            out.push(raw);
        });
        return out;
    }

    // Дописывает имена в labelNames настроек (+ выбранные в модалке цвета в
    // labelColors) и сразу перестраивает язычки — метка коллеги становится СВОЕЙ
    // плашкой сразу нужного цвета, без похода в настройки. Метка на почте (если её
    // ещё нет в этом ящике) создастся сама при первом реальном применении — тем же
    // механизмом, что и обычная авто-метка (см. createLabelInMail), и подхватит тот
    // же цвет (там ключ цвета — такой же простой toLowerCase, как здесь).
    async function addSuggestedLabels(names, colors) {
        try {
            const st = await chrome.storage.sync.get(['labelNames', 'labelColors']);
            const current = Array.isArray(st.labelNames) ? st.labelNames.slice() : [];
            const seen = new Set(current.map(normLabelName));
            names.forEach(function (n) {
                const key = normLabelName(n);
                if (key && !seen.has(key)) { seen.add(key); current.push(n); }
            });

            const currentColors = Object.assign({}, st.labelColors || {});
            names.forEach(function (n) {
                const chosen = colors && colors[n];
                const colorKey = String(n || '').trim().toLowerCase();
                if (colorKey && chosen) currentColors[colorKey] = chosen;
            });

            await chrome.storage.sync.set({ labelNames: current, labelColors: currentColors });
            await reloadLabelCfg();
            render(latestRows, null); // счётчики и цвета плашек сразу учтут новую метку
            showToast('Добавлено в «Метки на письме»: ' + names.join(', '), 'success');
        } catch (e) {
            showToast('Не удалось добавить метки: ' + friendlyErrorMessage(e), 'error');
        }
    }

    // «Не сейчас» / тост сам закрылся по таймауту — запоминаем ЛОКАЛЬНО (это
    // предпочтение именно этого браузера, не синхронизируем), чтобы не спрашивать
    // про эти же метки на каждое обновление таблицы.
    async function dismissSuggestedLabels(names) {
        try {
            const st = await chrome.storage.local.get(['pm_dismissed_label_suggestions']);
            const current = Array.isArray(st.pm_dismissed_label_suggestions)
                ? st.pm_dismissed_label_suggestions.slice() : [];
            const seen = new Set(current);
            names.forEach(function (n) {
                const key = normLabelName(n);
                if (key && !seen.has(key)) { seen.add(key); current.push(key); }
            });
            await chrome.storage.local.set({ pm_dismissed_label_suggestions: current });
        } catch (e) { /* не критично */ }
    }

    // Разные цвета по умолчанию для новых меток — раньше ВСЕ новые метки (и свои,
    // и от коллег) получали один и тот же дефолт (#ef7f5f, оранжевый), потому что
    // это единственный фолбэк-цвет во всём коде. Здесь — только для предложения
    // от коллег: каждой новой метке в модалке достаётся свой цвет из палитры
    // (по порядку, с повтором по кругу, если меток больше), а не одинаковый оранжевый.
    const NEW_LABEL_COLOR_PALETTE = [
        '#ef7f5f', '#5fa8ef', '#7fd77f', '#d77fd7',
        '#efc75f', '#5fd7c7', '#d75f7f', '#a8ef5f'
    ];

    // Модальное окно предложения (как подтверждение «Выполнено») — в отличие от
    // тоста, само не закрывается и не пропадает случайно, пока пользователь явно
    // не нажмёт «Добавить» или «Не сейчас»/клик вне окна. У каждой метки — свой
    // выбор цвета плашки (он же ляжет и на реальную метку в почте): цвет можно
    // оставить предложенный или сразу поменять здесь же, не заходя в настройки.
    function showNewLabelsModal(names) {
        return new Promise(function (resolve) {
            const overlay = document.createElement('div');
            overlay.className = 'pm-modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'pm-modal';

            const title = document.createElement('div');
            title.style.cssText = 'font-weight:600; font-size:15px; margin-bottom:8px;';
            title.textContent = names.length === 1
                ? '🏷️ Новая метка от коллеги'
                : '🏷️ Новые метки от коллег';
            modal.appendChild(title);

            const text = document.createElement('div');
            text.className = 'pm-modal-text';
            text.textContent = (names.length === 1
                ? 'В таблице встретилась метка «' + names[0] + '», которой нет в ваших «Метки на письме».'
                : 'В таблице встретились метки, которых нет в ваших «Метки на письме»: ' +
                  names.map(function (n) { return '«' + n + '»'; }).join(', ') + '.') +
                ' Добавить в свои настройки и завести для них плашки прямо сейчас? Цвет плашки можно выбрать сразу.';
            modal.appendChild(text);

            // Строка на каждую метку: название + выбор цвета плашки (и метки на почте).
            const list = document.createElement('div');
            list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin:12px 0;';
            const colorInputs = {};
            names.forEach(function (n, i) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px;';

                const label = document.createElement('span');
                label.textContent = n;
                label.style.cssText = 'font-size:13px; overflow:hidden; text-overflow:ellipsis;';
                row.appendChild(label);

                const color = document.createElement('input');
                color.type = 'color';
                color.value = NEW_LABEL_COLOR_PALETTE[i % NEW_LABEL_COLOR_PALETTE.length];
                color.title = 'Цвет плашки и метки на почте для «' + n + '» — можно сразу выбрать свой';
                color.style.cssText = 'width:36px; height:28px; padding:0; border:none; border-radius:6px; cursor:pointer; flex:none;';
                colorInputs[n] = color;
                row.appendChild(color);

                list.appendChild(row);
            });
            modal.appendChild(list);

            const actions = document.createElement('div');
            actions.className = 'pm-modal-actions';

            const cancel = document.createElement('button');
            cancel.className = 'pm-btn pm-btn-outline';
            cancel.textContent = 'Не сейчас';

            const ok = document.createElement('button');
            ok.className = 'pm-btn pm-btn-success';
            ok.textContent = '➕ Добавить себе';

            function close(result) {
                overlay.remove();
                resolve(result);
            }
            cancel.onclick = function () { close(false); };
            ok.onclick = function () {
                const colors = {};
                names.forEach(function (n) { colors[n] = colorInputs[n].value; });
                close(colors); // непустой объект — «добавить», false — «не сейчас»
            };
            overlay.onclick = function (e) { if (e.target === overlay) close(false); };

            actions.appendChild(cancel);
            actions.appendChild(ok);
            modal.appendChild(actions);
            overlay.appendChild(modal);
            shadow.appendChild(overlay);
            ok.focus();
        });
    }

    // Смотрит на свежие строки таблицы и, если среди их меток есть незнакомые
    // (и про них ещё не спрашивали и не отклоняли) — предлагает модальным окном
    // добавить их в свои настройки одним кликом. Окно НЕ закрывается само —
    // ждёт явного решения пользователя (в отличие от прежнего тоста, который легко
    // было пропустить).
    async function maybeSuggestNewLabels(rows) {
        if (SUGGESTION_MODAL_SHOWING) return; // окно уже показано — не наслаиваем
        const unknown = collectUnknownLabelsFromRows(rows);
        if (!unknown.length) return;

        let dismissed = [];
        try {
            const st = await chrome.storage.local.get(['pm_dismissed_label_suggestions']);
            dismissed = Array.isArray(st.pm_dismissed_label_suggestions) ? st.pm_dismissed_label_suggestions : [];
        } catch (e) { /* считаем, что ничего не отклоняли */ }
        const dismissedSet = new Set(dismissed);
        const fresh = unknown.filter(function (n) { return !dismissedSet.has(normLabelName(n)); });
        if (!fresh.length) return;

        SUGGESTION_MODAL_SHOWING = true;
        try {
            // showNewLabelsModal возвращает объект { имя: выбранныйЦвет } при согласии
            // или false при «Не сейчас»/клике вне окна.
            const colors = await showNewLabelsModal(fresh);
            if (colors) {
                await addSuggestedLabels(fresh, colors);
            } else {
                await dismissSuggestedLabels(fresh);
            }
        } finally {
            SUGGESTION_MODAL_SHOWING = false;
        }
    }

    // Настройки поменяли на странице настроек — подхватываем без перезагрузки почты.
    try {
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== 'sync') return;
            if (changes.labelNames || changes.labelName || changes.labelEnabled ||
                changes.labelColors || changes.labelTextColors || changes.labelOpacity ||
                changes.quickDoneStyle || changes.syncAllStyle) {
                reloadLabelCfg().catch(function () {});
            }
        });
    } catch (e) { /* не критично */ }

    // Состояние вида списка (сортировка/фильтр/поиск). Пороги «возраста на контроле».
    const VIEW = { sort: 'old', filter: '', search: '' };

    // Сортировка и фильтр по складу — личная настройка вида, а не общая: храним их в
    // браузере сотрудника. Раньше при каждой загрузке почты снова вставало «Сначала
    // старые», и выбор приходилось делать заново по десять раз на день.
    const VIEW_KEY = 'pm_view';

    function saveView() {
        try {
            chrome.storage.local.set({ [VIEW_KEY]: { sort: VIEW.sort, filter: VIEW.filter } });
        } catch (e) { /* не критично: просто не запомнится */ }
    }

    function loadView() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get([VIEW_KEY], function (st) {
                    const v = st && st[VIEW_KEY];
                    if (v && typeof v === 'object') {
                        if (v.sort) VIEW.sort = v.sort;
                        if (typeof v.filter === 'string') VIEW.filter = v.filter;
                    }
                    resolve();
                });
            } catch (e) { resolve(); }
        });
    }
    const AGE_WARN_DAYS = 3;
    const AGE_DANGER_DAYS = 7;

    // === ТЕМА (светлая/тёмная) ===
    // 'auto' — следуем системной теме; 'light'/'dark' — ручной выбор пользователя.
    // Выбор храним в chrome.storage.local, чтобы он был единым для попапа и настроек.
    const THEME_KEY = 'pm_theme';
    let themePref = 'auto';
    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function isDarkNow() {
        if (themePref === 'dark') return true;
        if (themePref === 'light') return false;
        return !!(mql && mql.matches);
    }

    function applyTheme() {
        const dark = isDarkNow();
        shadow.host.classList.toggle('pm-dark', dark);
        if (themeEl) {
            // Иконка показывает, КУДА переключимся по клику.
            themeEl.textContent = dark ? '☀' : '🌙';
            themeEl.title = dark ? 'Светлая тема' : 'Тёмная тема';
        }
    }

    async function loadTheme() {
        try {
            const r = await chrome.storage.local.get(THEME_KEY);
            if (r && (r[THEME_KEY] === 'light' || r[THEME_KEY] === 'dark' || r[THEME_KEY] === 'auto')) {
                themePref = r[THEME_KEY];
            }
        } catch (e) { /* по умолчанию auto */ }
        applyTheme();
    }

    if (mql) {
        const onSchemeChange = function () { if (themePref === 'auto') applyTheme(); };
        if (mql.addEventListener) mql.addEventListener('change', onSchemeChange);
        else if (mql.addListener) mql.addListener(onSchemeChange);
    }

    if (themeEl) {
        themeEl.onclick = function () {
            // Клик задаёт явную тему, противоположную текущей.
            themePref = isDarkNow() ? 'light' : 'dark';
            applyTheme();
            try { chrome.storage.local.set({ [THEME_KEY]: themePref }); } catch (e) {}
        };
    }

    // Тема может смениться в другом окне (попап/настройки) — подхватываем.
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[THEME_KEY]) {
            const v = changes[THEME_KEY].newValue;
            if (v === 'light' || v === 'dark' || v === 'auto') {
                themePref = v;
                applyTheme();
            }
        }
    });

    // Возраст строки в днях (с даты добавления) или null.
    function ageInDays(row) {
        if (!row.dateAdded) return null;
        const t = new Date(row.dateAdded).getTime();
        if (isNaN(t)) return null;
        return Math.floor((Date.now() - t) / 86400000);
    }

    function pluralDays(n) {
        return plural(n, 'день', 'дня', 'дней');
    }

    // Применяет поиск, фильтр по складу и сортировку к строкам.
    function applyView(rows) {
        let out = rows.slice();
        // Меток несколько — панель показывает письма своей плашки (столько же, сколько
        // на её счётчике). С одной меткой фильтровать нечего — показываем всё.
        if (labelCfg.names.length > 1 && activeToggle) {
            out = rowsOfLabel(out, activeToggle.name);
        }
        if (VIEW.search) {
            const q = VIEW.search.toLowerCase();
            out = out.filter(function (r) {
                return [r.topic, r.number, r.warehouse, r.comment, r.label]
                    .some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
            });
        }
        if (VIEW.filter) {
            out = out.filter(function (r) { return (r.warehouse || '') === VIEW.filter; });
        }
        if (VIEW.sort === 'old' || VIEW.sort === 'new') {
            out.sort(function (a, b) {
                const ta = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
                const tb = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
                return VIEW.sort === 'old' ? ta - tb : tb - ta;
            });
        } else if (VIEW.sort === 'warehouse') {
            out.sort(function (a, b) {
                return String(a.warehouse || '').localeCompare(String(b.warehouse || ''), 'ru');
            });
        }
        // 'sheet' — оставляем исходный порядок
        return out;
    }

    // Наполняет фильтр по складу уникальными значениями из строк.
    function updateFilterOptions(rows) {
        const warehouses = [];
        const seen = new Set();
        rows.forEach(function (r) {
            const w = r.warehouse || '';
            if (w && !seen.has(w)) { seen.add(w); warehouses.push(w); }
        });
        warehouses.sort(function (a, b) { return a.localeCompare(b, 'ru'); });

        const current = VIEW.filter;
        filterEl.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'Все склады';
        filterEl.appendChild(allOpt);
        warehouses.forEach(function (w) {
            const opt = document.createElement('option');
            opt.value = w;
            opt.textContent = w;
            filterEl.appendChild(opt);
        });
        // Сохраняем выбранный склад, если он ещё есть в списке. Если склада больше нет
        // (письма по нему закрыли), сбрасываем и сам фильтр: иначе в выпадающем стоит
        // «Все склады», а список при этом отфильтрован в пустоту.
        if (current && !seen.has(current)) VIEW.filter = '';
        filterEl.value = VIEW.filter;
        VIEW.filter = filterEl.value;
    }

    // === ОБРАБОТЧИКИ ===
    ['keydown', 'keypress', 'keyup'].forEach(function (evt) {
        shadow.addEventListener(evt, function (e) {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') e.stopPropagation();
        });
    });

    closeEl.onclick = function() {
        panelEl.classList.remove('open');
        isPanelOpen = false;
        ensureObserver();
    };

    sortEl.value = VIEW.sort;
    sortEl.onchange = function () {
        VIEW.sort = sortEl.value;
        saveView();
        render(latestRows, null);
    };
    filterEl.onchange = function () {
        VIEW.filter = filterEl.value;
        saveView();
        render(latestRows, null);
    };

    // Поиск по списку: тема / номер / склад / комментарий. Фильтруем на лету.
    if (searchEl) {
        searchEl.oninput = function () {
            VIEW.search = searchEl.value.trim();
            searchWrapEl.classList.toggle('has-text', searchEl.value.length > 0);
            render(latestRows, null);
        };
        searchEl.onkeydown = function (e) {
            if (e.key === 'Escape' && searchEl.value) {
                e.stopPropagation();
                searchEl.value = '';
                VIEW.search = '';
                searchWrapEl.classList.remove('has-text');
                render(latestRows, null);
            }
        };
    }
    if (searchClearEl) {
        searchClearEl.onclick = function () {
            searchEl.value = '';
            VIEW.search = '';
            searchWrapEl.classList.remove('has-text');
            render(latestRows, null);
            searchEl.focus();
        };
    }

    // === ОБРАБОТКА СООБЩЕНИЙ ===
    // Строки, пришедшие, пока пользователь писал комментарий. Применим по blur.
    let pendingRows = null;

    function applyRows(rows) {
        latestRows = rows || [];
        adoptSelfLabelChanges();
        pruneCache(latestRows);
        // Сначала показываем свежий список из таблицы
        render(latestRows, null);
        // Перепоиск по почте — только когда панель открыта: при закрытой панели
        // эта информация не видна, а частый фоновый опрос зря бил бы по API почты.
        if (isPanelOpen) setTimeout(() => refreshAllTopics(), 500);
    }

    // Отпустили поле комментария — доносим отложенное обновление.
    shadow.addEventListener('focusout', function (e) {
        if (!pendingRows) return;
        if (!e.target || e.target.tagName !== 'TEXTAREA') return;
        const rows = pendingRows;
        pendingRows = null;
        setTimeout(function () { applyRows(rows); }, 0);
    });

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'pm-rows') {
            // Пока пишут комментарий, перерисовывать список нельзя — уедет курсор.
            // Но и ВЫБРАСЫВАТЬ обновление нельзя: раньше эта порция данных терялась
            // насовсем, и панель оставалась на старом списке до следующего тика.
            // Придерживаем её и применяем, как только поле отпустят.
            if (shadow.activeElement && shadow.activeElement.tagName === 'TEXTAREA') {
                pendingRows = msg.rows || [];
                return;
            }
            applyRows(msg.rows || []);
            return;
        }
        // Попап после добавления письма просит повесить метку на его ветку.
        if (msg && msg.action === 'pm-apply-label' && msg.topic) {
            applyLabelForTopic(msg.topic, msg.number || '', true, null, msg.labelName || '')
                .then(function (res) {
                    // Письмо добавили МЫ, и метку расширение тут же поставило — краснеть
                    // плашке не из-за чего. Раньше эту отметку делал только путь «добавить
                    // из панели», а добавление ИЗ ПОПАПА её не делало: у того, кто добавил
                    // письмо, ярлычок загорался красным сразу после его же правильного
                    // действия. Отмечаем только реально поставленные метки — если метка не
                    // легла, красный сигнал должен остаться.
                    if (!res || !res.applied || !res.applied.length) return;
                    res.applied.forEach(function (n) { noteSelfLabelChange(n); });
                    // Слепок перезаписывается при следующей удачной загрузке строк —
                    // просим её сразу, иначе плашка краснела бы до ближайшего обновления.
                    autoRefresh(true);
                })
                .catch(function () { /* ошибку уже показали тостом */ });
            // ответ не обязателен — действие фоновое
        }
    });

    // === РЕНДЕРИНГ ===
    // Подпись того, что видно в списке: сами строки плюс состояние вида (фильтр,
    // поиск, выбранная плашка). Совпала — перерисовывать нечего. Собираем через
    // JSON: разделители не спутаются с содержимым ячеек.
    function renderSignature(rows, error) {
        if (error) return JSON.stringify(['error', String(error)]);
        try {
            return JSON.stringify([
                VIEW.sort || '',        // без неё смена сортировки не перерисовывала список
                VIEW.filter || '',
                VIEW.search || '',
                (activeToggle && activeToggle.name) || '',
                labelCfg.names,
                (rows || []).map(function (r) {
                    return [r.sheetRow, r.topic, r.number, r.warehouse, r.type,
                            r.comment, r.label, r.mailId, r.preview, r.dateAdded];
                })
            ]);
        } catch (e) {
            return null;   // не смогли посчитать — перерисуем, как раньше
        }
    }
    let lastRenderSig = null;

    // Показ ошибки чтения БЕЗ потери уже показанных строк. Раньше каждый неудачный
    // ⟳ (или неудачная загрузка при старте) звал render([], причина) — а render
    // присваивает latestRows, то есть один сорвавшийся запрос обнулял счётчики на
    // всех плашках. Со стороны это выглядело как «данные пропали».
    function showLoadError(msg) {
        const text = String(msg || 'Не удалось загрузить данные');
        if (latestRows.length) {
            render(latestRows, null);
            showToast('Список показан из сохранённого: ' + text +
                      '. Нажмите ⟳, чтобы повторить.', 'error');
            return;
        }
        render([], text);
    }

    function render(rows, error) {
        latestRows = rows || [];
        latestLoadError = error || null;
        rowsEverLoaded = true;
        updateBadges();

        // Список пересобирается ПОЛНОСТЬЮ: listEl.innerHTML = '' и заново каждая
        // карточка со всеми обработчиками. Раньше это происходило на каждом тике
        // будильника — то есть регулярно на данных, которые не изменились ни на байт,
        // и заодно сбрасывало прокрутку и раскрытые карточки. Ничего не изменилось —
        // не трогаем DOM вообще.
        const sig = renderSignature(latestRows, error);
        if (sig !== null && sig === lastRenderSig && listEl.childElementCount) return;
        lastRenderSig = sig;

        if (!error) maybeSuggestNewLabels(latestRows).catch(function () {});

        if (error) {
            listEl.innerHTML = '';
            const div = document.createElement('div');
            div.className = 'pm-error';
            div.textContent = '⚠️ ' + error;
            listEl.appendChild(div);
            countEl.textContent = '';
            updateCacheInfo();
            return;
        }

        if (!latestRows.length) {
            countEl.textContent = '';
            listEl.innerHTML = `
                <div class="pm-empty">
                    <div class="pm-empty-icon">📭</div>
                    Нет активных проблемных писем<br>
                    <span style="font-size:12px;opacity:0.6;">Все письма обработаны!</span>
                </div>
            `;
            updateCacheInfo();
            return;
        }

        updateFilterOptions(latestRows);
        const viewRows = applyView(latestRows);

        const total = (labelCfg.names.length > 1 && activeToggle)
            ? rowsOfLabel(latestRows, activeToggle.name).length
            : latestRows.length;
        const shown = viewRows.length;
        if (VIEW.filter || VIEW.search) {
            countEl.innerHTML = `Показано <strong>${shown}</strong> из ${total} ${plural(total, 'письма', 'писем', 'писем')}`;
        } else {
            countEl.innerHTML = `Всего <strong>${total}</strong> ${plural(total, 'письмо', 'письма', 'писем')}`;
        }
        listEl.innerHTML = '';

        // Строки с меткой, под которую нет плашки, показываются в первой плашке —
        // но об этом надо сказать прямо, иначе непонятно, почему их метки не
        // проставляются кнопкой 🏷️ (у них своя метка, не этой плашки).
        renderOrphanNotice();

        if (!viewRows.length) {
            const div = document.createElement('div');
            div.className = 'pm-empty';
            const msg = VIEW.search
                ? 'Ничего не найдено по запросу «' + VIEW.search + '»'
                : 'Нет писем по выбранному складу';
            const icon = document.createElement('div');
            icon.className = 'pm-empty-icon';
            icon.textContent = '🔍';
            div.appendChild(icon);
            div.appendChild(document.createTextNode(msg));
            listEl.appendChild(div);
            updateCacheInfo();
            return;
        }

        viewRows.forEach(function (r) {
            const card = document.createElement('div');
            card.className = 'pm-card collapsed';
            card.dataset.rowNumber = r.sheetRow;
            card.dataset.topic = r.topic;

            // Подсветка по возрасту на контроле.
            const age = ageInDays(r);
            if (age !== null && age >= AGE_DANGER_DAYS) {
                card.classList.add('pm-overdue');
            } else if (age !== null && age >= AGE_WARN_DAYS) {
                card.classList.add('pm-old');
            }

            const header = document.createElement('div');
            header.className = 'pm-card-header';

            const rowKey = String(r.sheetRow);
            const notFound = NOT_FOUND_ROWS.has(rowKey) && !MEMORY_CACHE.results.has(rowKey);

            const badge = document.createElement('div');
            badge.className = 'pm-thread-badge small';
            badge.textContent = '✉';
            if (SYNCING_ROWS.has(rowKey)) {
                // Список перерисовали посреди прогона — строка всё ещё в работе.
                badge.classList.add('syncing');
                badge.textContent = '⏳';
                badge.title = 'Обновляю метку этого письма…';
            } else if (notFound) {
                paintThreadBadge(badge, null);
            }
            header.appendChild(badge);

            const title = document.createElement('div');
            title.className = 'pm-card-title' + (notFound ? ' notfound' : '');
            title.textContent = r.topic;
            title.title = notFound
                ? 'Этого письма нет в вашей почте — искать нечего'
                : 'Показать ветку в списке писем';
            title.onclick = function (e) {
                e.stopPropagation();
                // Поиск честно ответил «письма в этом ящике нет» — не лезем в почту
                // вообще. Раньше клик всё равно запускал переход и в итоге вбивал тему
                // в поисковую строку, показывая первое похожее чужое письмо.
                if (NOT_FOUND_ROWS.has(rowKey) && !MEMORY_CACHE.results.has(rowKey)) {
                    showToast('Этого письма нет в вашей почте — искать нечего', 'info');
                    return;
                }
                // info берём в момент клика — он мог обновиться после отрисовки.
                // Ключ — sheetRow, не тема: у разных строк тема может совпадать.
                const cachedInfo = MEMORY_CACHE.results.get(String(r.sheetRow));
                const navInfo = Object.assign({}, cachedInfo || {}, { number: (cachedInfo && cachedInfo.number) || r.number || null });
                // id из таблицы сюда НЕ подставляем: они сняты из ящика того, кто
                // добавлял письмо, а у каждого сотрудника свои id — переход по чужому
                // id открыл бы пустоту. Для перехода годятся только id, найденные
                // поиском в ЭТОМ ящике (они и лежат в cachedInfo). Из таблицы берём
                // лишь временную метку — по ней openThread решает, старая ветка или нет.
                if (!navInfo.lastTs && !navInfo.firstTs) {
                    const storedTs = parseStoredIds(r.mailId).ts;
                    if (storedTs) {
                        navInfo.lastTs = storedTs;
                        // Это время ЗАВЕДЁННОГО письма, а не последнего письма ветки:
                        // сверять строку списка «день в день» по нему нельзя (в списке
                        // стоит дата последнего письма). См. navMatchOpts.
                        navInfo.lastTsFromSheet = true;
                    }
                }
                // id письма ИЗ ТАБЛИЦЫ — для перехода. Раньше их сюда не подставляли
                // вовсе: «id сняты из ящика того, кто добавлял письмо, а у каждого
                // сотрудника свои». Это верно, но теперь колонка помечена владельцем
                // (u:<uid>), и своё от чужого отличается точно. Без этого переход по
                // клику на тему шёл по ТЕМЕ — то есть в своей папке открывал первое
                // письмо с такой же темой, а в чужой уходил в глобальный поиск.
                // Берём строго: только когда владелец колонки — этот самый ящик.
                const storedForNav = parseStoredIds(r.mailId);
                if (storedForNav.owner && MAILBOX_UID && storedForNav.owner === MAILBOX_UID) {
                    // Вычитать id веток из id писем НЕЛЬЗЯ: у переписки из одного
                    // письма это одно и то же число, и вычиталось бы всё. Просто
                    // предпочитаем id, не помеченный как ветка; нет такого — берём любой.
                    const storedList = Array.from(storedForNav.all);
                    const preferMid = storedList.find(function (x) {
                        return !storedForNav.tids.has(x);
                    }) || storedList[0];
                    if (!navInfo.shownMid && preferMid) navInfo.shownMid = preferMid;
                    if (!navInfo.tid && storedForNav.tids.size) {
                        navInfo.tid = 't' + Array.from(storedForNav.tids)[0];
                    }
                }
                // Начало текста письма из таблицы — вторая примета строки списка.
                // Оно различает однотемные письма ОДНОГО дня, когда дата не помогает.
                if (r.preview && !notPreviewPlaceholder(navInfo.lastPreview)) navInfo.preview = r.preview;
                // Дата письма из таблицы — последний якорь возраста: она есть всегда,
                // в отличие от времени писем из поиска и метки ts: в «ID письма».
                if (r.dateAdded) {
                    const t = Date.parse(r.dateAdded);
                    if (!isNaN(t)) navInfo.rowTs = t;
                }
                openThread(r.topic, navInfo);
            };
            header.appendChild(title);

            // Копирование темы вынесено на отдельную кнопку (клик по теме теперь
            // открывает ветку). Кнопка не влияет на сворачивание карточки — обработчик
            // card.onclick игнорирует клики по <button>.
            const copyBtn = document.createElement('button');
            copyBtn.className = 'pm-copy-btn';
            copyBtn.textContent = '📋';
            copyBtn.title = 'Скопировать тему';
            copyBtn.onclick = function (e) {
                e.stopPropagation();
                copyToClipboard(String(r.topic), copyBtn, shadow);
            };
            header.appendChild(copyBtn);

            card.onclick = function(e) {
                if (e.target.closest('.pm-card-title') || e.target.closest('button') || e.target.closest('.pm-comment-edit')) return;
                card.classList.toggle('collapsed');
            };

            card.appendChild(header);

            const body = document.createElement('div');
            body.className = 'pm-body';

            const meta = document.createElement('div');
            meta.className = 'pm-meta';
            const dateStr = r.dateAdded ? new Date(r.dateAdded).toLocaleDateString() : 'дата неизвестна';
            const whSpan = document.createElement('span');
            whSpan.textContent = '🏢 ' + (r.warehouse || 'не указан');
            const dateTag = document.createElement('span');
            dateTag.className = 'pm-tag';
            dateTag.textContent = '📅 ' + dateStr;
            meta.appendChild(whSpan);
            meta.appendChild(dateTag);

            // Метка письма — видно, к какой плашке оно относится. Показываем только
            // когда меток несколько: с одной меткой подпись ничего не добавляет.
            if (labelCfg.names.length > 1) {
                const labelTag = document.createElement('span');
                labelTag.className = 'pm-tag';
                labelTag.textContent = '🏷️ ' + (r.label || labelCfg.names[0] || 'без метки');
                if (!r.label) labelTag.title = 'Метка в таблице не указана — письмо считается за первой плашкой';
                // Применяем цвет метки из настроек
                const skin = labelSkin(r.label || labelCfg.names[0] || '');
                if (skin) {
                    labelTag.style.background = skin.background;
                    labelTag.style.color = skin.text;
                    labelTag.style.border = skin.border;
                }
                meta.appendChild(labelTag);
            }

            // age уже вычислен выше (для подсветки карточки).
            if (age !== null) {
                const ageTag = document.createElement('span');
                ageTag.className = 'pm-age' + (age >= AGE_DANGER_DAYS ? ' danger' : age >= AGE_WARN_DAYS ? ' warn' : '');
                ageTag.textContent = age === 0 ? '⏳ сегодня' : '⏳ ' + age + ' ' + pluralDays(age);
                meta.appendChild(ageTag);
            }
            body.appendChild(meta);

            // === КОММЕНТАРИЙ ===
            const commentWrap = document.createElement('div');
            commentWrap.className = 'pm-comment-wrap';

            const commentView = document.createElement('div');
            commentView.className = 'pm-comment-view';

            const commentText = document.createElement('span');
            commentText.className = 'pm-comment-text' + (r.comment ? '' : ' empty');
            commentText.textContent = r.comment || 'Добавьте комментарий...';
            commentView.appendChild(commentText);

            const commentEditBtn = document.createElement('button');
            commentEditBtn.className = 'pm-comment-edit-btn';
            commentEditBtn.textContent = '✎';
            commentEditBtn.title = 'Редактировать комментарий';
            commentView.appendChild(commentEditBtn);
            commentWrap.appendChild(commentView);

            const commentEdit = document.createElement('div');
            commentEdit.className = 'pm-comment-edit';
            commentEdit.style.display = 'none';

            const commentInput = document.createElement('textarea');
            commentInput.className = 'pm-comment-input';
            commentInput.value = r.comment || '';

            const commentEditActions = document.createElement('div');
            commentEditActions.className = 'pm-comment-edit-actions';

            const commentSaveBtn = document.createElement('button');
            commentSaveBtn.className = 'pm-btn pm-btn-primary';
            commentSaveBtn.textContent = 'Сохранить';

            const commentCancelBtn = document.createElement('button');
            commentCancelBtn.className = 'pm-btn pm-btn-outline';
            commentCancelBtn.textContent = 'Отмена';

            const commentError = document.createElement('div');
            commentError.className = 'pm-comment-error';
            commentError.style.display = 'none';

            function openCommentEdit() {
                commentInput.value = r.comment || '';
                commentError.style.display = 'none';
                commentView.style.display = 'none';
                commentEdit.style.display = 'block';
                commentInput.focus();
            }

            function closeCommentEdit() {
                commentEdit.style.display = 'none';
                commentView.style.display = 'flex';
            }

            commentEditBtn.onclick = function (e) {
                e.stopPropagation();
                openCommentEdit();
            };

            commentCancelBtn.onclick = function (e) {
                e.stopPropagation();
                closeCommentEdit();
            };

            commentSaveBtn.onclick = function (e) {
                e.stopPropagation();
                const newComment = commentInput.value;
                commentSaveBtn.disabled = true;
                commentSaveBtn.textContent = 'Сохраняю…';
                commentError.style.display = 'none';

                send({ type: 'pm-editComment', rowNumber: r.sheetRow, topic: r.topic, comment: newComment }).then(function (res) {
                    commentSaveBtn.disabled = false;
                    commentSaveBtn.textContent = 'Сохранить';
                    if (res && res.ok) {
                        r.comment = newComment;
                        commentText.textContent = newComment || 'Добавьте комментарий...';
                        commentText.classList.toggle('empty', !newComment);
                        closeCommentEdit();
                    } else {
                        commentError.textContent = '⚠️ ' + ((res && res.error) || 'неизвестная ошибка');
                        commentError.style.display = 'block';
                    }
                }).catch(function (err) {
                    commentSaveBtn.disabled = false;
                    commentSaveBtn.textContent = 'Сохранить';
                    commentError.textContent = '⚠️ ' + (err && err.message ? err.message : String(err));
                    commentError.style.display = 'block';
                });
            };

            commentEditActions.appendChild(commentSaveBtn);
            commentEditActions.appendChild(commentCancelBtn);
            commentEdit.appendChild(commentInput);
            commentEdit.appendChild(commentEditActions);
            commentEdit.appendChild(commentError);
            commentWrap.appendChild(commentEdit);

            body.appendChild(commentWrap);

            // === ПОСЛЕДНЕЕ ПИСЬМО - МГНОВЕННО ИЗ КЭША ===
            const emailBlock = document.createElement('div');
            emailBlock.className = 'pm-last-email';
            
            // Сразу показываем из кэша (ключ — sheetRow: тема может совпадать у разных строк)
            const cached = MEMORY_CACHE.results.get(String(r.sheetRow));
            if (cached) {
                updateEmailBlock(emailBlock, cached, r.topic);
                const badge2 = card.querySelector('.pm-thread-badge');
                if (badge2) paintThreadBadge(badge2, cached);
            } else if (notFound) {
                // Уже искали и не нашли — показываем это сразу, без «Поиск…».
                updateEmailBlock(emailBlock, null, r.topic);
            } else {
                emailBlock.innerHTML = `
                    <div class="pm-loading">
                        <div class="pm-loading-spinner"></div>
                        <span>Поиск...</span>
                    </div>
                `;
                // Асинхронно ищем
                setTimeout(() => {
                    const info = getEmailInfoSmart(r.sheetRow, r.topic, r.preview, r.mailId);
                    if (info) {
                        updateEmailBlock(emailBlock, info, r.topic);
                        const badge2 = card.querySelector('.pm-thread-badge');
                        if (badge2) paintThreadBadge(badge2, info);
                    }
                }, 100);
            }
            body.appendChild(emailBlock);

            // === ДЕЙСТВИЯ ===
            const actions = document.createElement('div');
            actions.className = 'pm-actions';

            const doneBtn = document.createElement('button');
            doneBtn.className = 'pm-btn pm-btn-success';
            doneBtn.innerHTML = '✅ Выполнено';
            doneBtn.onclick = function (e) {
                e.stopPropagation();
                markRowDone(r, card, doneBtn);
            };
            actions.appendChild(doneBtn);

            body.appendChild(actions);
            card.appendChild(body);
            listEl.appendChild(card);
        });
        
        updateCacheInfo();
    }

    // Содержимое письма (тема/автор/превью) — недоверенный текст из чужой почты,
    // поэтому вставляем строго через textContent, без innerHTML.
    // «Выполнено» по карточке в панели.
    //
    // Вынесено из render(): там это был обработчик на семьдесят строк с тремя
    // уровнями вложенных .then внутри цикла по строкам — то есть самый глубокий и
    // самый нечитаемый кусок отрисовки, притом что к отрисовке он отношения не имеет.
    //
    // Порядок важен и держится на одном: в таблицу пишем ПЕРВЫМ делом, а всё
    // остальное (метка в почте, карточка, счётчики) — уже после успеха. Иначе при
    // сбое записи панель показывала бы выполненным то, что в таблице не отмечено.
    function markRowDone(r, card, doneBtn) {
        const restore = function () {
            doneBtn.disabled = false;
            doneBtn.innerHTML = '✅ Выполнено';
        };
        const recount = function () {
            const n = visibleCardCount();
            countEl.innerHTML = 'Всего <strong>' + n + '</strong> ' +
                plural(n, 'письмо', 'письма', 'писем');
        };

        // Без подтверждения заранее — сразу выполняем, а на случай мисклика даём тост
        // с кнопкой «Отмена» (как при добавлении письма).
        doneBtn.disabled = true;
        doneBtn.textContent = '⏳';

        send({ type: 'pm-markDone', rowNumber: r.sheetRow, topic: r.topic }).then(function (res) {
            if (!res || !res.ok) {
                restore();
                showToast('Ошибка: ' + (res && res.error ? res.error : 'неизвестная'), 'error');
                return;
            }
            // Метка строки известна из таблицы — снимаем именно её; у старых строк её
            // нет, тогда снимаем все настроенные.
            noteSelfLabelChange(r.label || labelCfg.names[0] || '');

            // Строку письма подметание опознаёт само — см. labelScopeForRow. Открытое
            // сейчас письмо берём в приметы, ТОЛЬКО если оно этой же строки: человек
            // может читать совсем другое.
            const openMid = openMessageIdOfRow(r) || null;
            const hiddenChips = hideLabelChipsFor(
                r.label ? [r.label] : labelCfg.names, 6000, labelScopeForRow(r, openMid));

            applyLabelForTopic(r.topic, r.number, false, r.dateAdded,
                               r.label || '', r.mailId || '', r.preview || '')
                .then(function (lr) {
                    // Снять метку не удалось — возвращаем плашку, чтобы экран не врал.
                    if (!lr || !lr.ok) { restoreLabelChips(hiddenChips); return; }
                    refreshAfterDone();
                })
                .catch(function () { restoreLabelChips(hiddenChips); });

            // Если на экране открыто ИМЕННО это письмо — закрываем его. Чужое открытое
            // письмо не трогаем: человек его читает.
            if (openMid) closeOpenLetterAfterDone();

            // Строку убрали из таблицы — убираем и из списка панели, чтобы счётчики
            // плашек сошлись по меткам.
            card.style.display = 'none';
            latestRows = latestRows.filter(function (x) { return x.sheetRow !== r.sheetRow; });
            updateBadges();
            recount();
            MEMORY_CACHE.results.delete(String(r.sheetRow));
            MEMORY_CACHE.updatedAt.delete(String(r.sheetRow));
            saveCacheToStorage();
            updateCacheInfo();

            showActionToast('✅ Отмечено как выполненное', 'Отмена', function () {
                undoRowDone(r, card, doneBtn, recount, restore);
            }, 'success', 8000);
        }).catch(function (err) {
            restore();
            showToast('Ошибка: ' + err.message, 'error');
        });
    }

    // «Отмена» после «Выполнено»: снимаем галку в таблице, возвращаем метку на письмо
    // и строку — в список панели.
    function undoRowDone(r, card, doneBtn, recount, restore) {
        send({ type: 'pm-unmarkDone', rowNumber: r.sheetRow, topic: r.topic }).then(function (res) {
            if (!res || !res.ok) {
                showToast('Не удалось отменить: ' + (res && res.error ? res.error : 'ошибка'), 'error');
                return;
            }
            noteSelfLabelChange(r.label || labelCfg.names[0] || '');
            applyLabelForTopic(r.topic, r.number, true, r.dateAdded,
                               r.label || '', r.mailId || '', r.preview || '');
            card.style.display = '';
            restore();
            if (!latestRows.some(function (x) { return x.sheetRow === r.sheetRow; })) latestRows.push(r);
            updateBadges();
            recount();
            showToast('Отменено', 'success');
        }).catch(function (err) {
            showToast('Не удалось отменить: ' + err.message, 'error');
        });
    }

    function updateEmailBlock(emailBlock, info, topic) {
        emailBlock.textContent = '';

        const meta = document.createElement('div');
        meta.className = 'pm-email-meta';

        if (info) {
            const dateSpan = document.createElement('span');
            dateSpan.textContent = '📅 ' + info.lastDate;
            const authorSpan = document.createElement('span');
            authorSpan.textContent = '👤 ' + info.lastAuthor;
            meta.appendChild(dateSpan);
            meta.appendChild(authorSpan);

            if (info.count > 1) {
                const countSpan = document.createElement('span');
                countSpan.style.cssText = 'font-size:10px;opacity:0.6;';
                countSpan.textContent = '📬 ' + info.count + ' писем';
                meta.appendChild(countSpan);
            }

            const preview = document.createElement('div');
            preview.className = 'pm-email-preview';

            const previewText = document.createElement('div');
            previewText.className = 'pm-preview-text';
            // Начало текста показанного письма. Почта отдаёт его не всегда (в ответе
            // firstline бывает пустым) — тогда вместо него идёт подпись, и она
            // помечается классом, чтобы не выглядеть текстом письма.
            //
            // Текст из колонки «Текст письма» сюда НЕ подставляем нарочно: он снят в
            // момент перетаскивания, то есть относится к первому письму ветки, а
            // карточка показывает опознанное письмо строки — обычно другое. Показать
            // одно вместо другого — просто другой способ соврать.
            const shownPreview = notPreviewPlaceholder(info.lastPreview);
            previewText.textContent = shownPreview || PREVIEW_MISSING_TEXT;
            previewText.classList.toggle('pm-preview-missing', !shownPreview);
            if (info.mid || info.tid) {
                previewText.title = 'Открыть последнее письмо';
                previewText.onclick = function (e) {
                    e.stopPropagation();
                    openLastMessage(topic, info);
                };
            }
            preview.appendChild(previewText);

            const searchBtn = document.createElement('button');
            searchBtn.className = 'pm-search-btn';
            searchBtn.textContent = '📩 Перейти к последнему письму';
            searchBtn.onclick = function (e) {
                e.stopPropagation();
                openLastMessage(topic, info);
            };
            preview.appendChild(searchBtn);

            emailBlock.appendChild(meta);
            emailBlock.appendChild(preview);
        } else {
            const notFound = document.createElement('span');
            notFound.textContent = '❌ Не найдено';
            meta.appendChild(notFound);

            const preview = document.createElement('div');
            preview.className = 'pm-email-preview';
            preview.style.opacity = '0.6';
            preview.textContent = 'Письма по теме не найдены';

            emailBlock.appendChild(meta);
            emailBlock.appendChild(preview);
        }
    }

    // Плашка первая — предупреждаем о письмах с «чужими» метками и предлагаем завести
    // под них плашки. Предложение показывается СНОВА, даже если когда-то нажали
    // «Не сейчас»: иначе письма так и останутся без своей плашки, а их метки —
    // непроставленными.
    function renderOrphanNotice() {
        if (labelCfg.names.length <= 1 || !activeToggle) return;
        if (normLabelName(activeToggle.name) !== normLabelName(labelCfg.names[0] || '')) return;
        const orphans = orphanRows(latestRows);
        if (!orphans.length) return;
        const names = [];
        const seen = new Set();
        orphans.forEach(function (r) {
            const raw = String(r.label || '').trim();
            const key = normLabelName(raw);
            if (!key || seen.has(key)) return;
            seen.add(key);
            names.push(raw);
        });

        const box = document.createElement('div');
        box.className = 'pm-orphan-notice';
        const text = document.createElement('div');
        text.textContent = '⚠️ ' + orphans.length + ' ' +
            plural(orphans.length, 'письмо', 'письма', 'писем') +
            ' с метками, под которые нет плашки: ' + names.join(', ') +
            '. Они показаны здесь, но кнопка 🏷️ этой плашки их не трогает — у них своя метка.';
        box.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'pm-btn pm-btn-outline';
        btn.textContent = '➕ Завести плашки для этих меток';
        btn.onclick = async function () {
            btn.disabled = true;
            try {
                const colors = await showNewLabelsModal(names);
                if (colors) await addSuggestedLabels(names, colors);
            } catch (e) {
                showToast('Не удалось добавить плашки: ' + friendlyErrorMessage(e), 'error');
            } finally {
                btn.disabled = false;
            }
        };
        box.appendChild(btn);
        listEl.appendChild(box);
    }

    // Объём кэша считается полной сериализацией, а подпись обновляют из тех же горячих
    // мест, что и сам кэш — по строке за раз. Поэтому объём пересчитываем не чаще раза
    // в 15 секунд и только при открытой панели (в закрытой подписи не видно), а между
    // пересчётами показываем последнее известное значение. Счётчик записей дешёвый
    // (.size) и обновляется всегда.
    let cacheSizeText = '';
    let cacheSizeAt = 0;
    const CACHE_SIZE_TTL = 15000;

    function updateCacheInfo() {
        if (!cacheInfoEl) return;
        const count = MEMORY_CACHE.results.size;
        const now = Date.now();
        if (isPanelOpen && now - cacheSizeAt > CACHE_SIZE_TTL) {
            cacheSizeAt = now;
            try {
                const bytes = JSON.stringify(Array.from(MEMORY_CACHE.results.entries())).length;
                cacheSizeText = bytes > 102400 ? ` (${Math.round(bytes / 1024)} КБ)` : '';
            } catch (e) { /* не критично */ }
        }
        cacheInfoEl.textContent = `💾 Сохранено ${count} записей о письмах${cacheSizeText} · v${PM_VERSION}`;
    }

    // Расширение обновили (или выключили-включили), а вкладка почты осталась открытой.
    // Тогда скрипт на странице продолжает жить, но связь с расширением обрывается
    // навсегда: chrome.runtime исчезает, и КАЖДЫЙ запрос падает с
    // «Cannot read properties of undefined (reading 'sendMessage')».
    // Снаружи это выглядит как «сломалось вообще всё»: строк нет, метки не ставятся,
    // «Не удалось добавить», счётчики по нулям. Лечится одним F5, но догадаться об
    // этом по такой ошибке невозможно — поэтому говорим прямо.
    let extensionGone = false;

    function extensionAlive() {
        try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
        catch (e) { return false; }
    }

    const EXT_GONE_MSG = 'расширение обновилось — обновите вкладку почты (F5)';

    function noteExtensionGone() {
        if (extensionGone) return;
        extensionGone = true;
        try {
            console.warn('[Проблемные письма] Связь с расширением потеряна: его обновили ' +
                'или перезагрузили, а эта вкладка почты осталась открытой со старой ' +
                'копией скрипта. Ничего работать не будет, пока вкладку не обновить (F5).');
        } catch (e) { /* ignore */ }
        try { trace('связь с расширением потеряна — нужен F5'); } catch (e) { /* ignore */ }
        try { showLoadError(EXT_GONE_MSG); } catch (e) { /* ignore */ }
        try { showToast('Расширение обновилось. Обновите вкладку почты (F5) — до этого ничего не заработает', 'error'); }
        catch (e) { /* ignore */ }
        // Тост исчезает, а состояние это не временное: работать не будет НИЧЕГО, пока
        // вкладку не обновят. Поэтому вешаем полосу, которая никуда не денется.
        try {
            if (listEl && listEl.parentNode && !shadow.querySelector('.pm-ext-gone')) {
                const bar = document.createElement('div');
                bar.className = 'pm-error pm-ext-gone';
                bar.textContent = '⚠️ Расширение обновилось. Обновите вкладку почты (F5) — ' +
                    'до этого не работают ни список, ни метки, ни добавление писем.';
                listEl.parentNode.insertBefore(bar, listEl);
            }
        } catch (e) { /* ignore */ }
    }

    function send(msg) {
        if (!extensionAlive()) {
            noteExtensionGone();
            return Promise.reject(new Error(EXT_GONE_MSG));
        }
        try {
            return chrome.runtime.sendMessage(msg);
        } catch (e) {
            noteExtensionGone();
            return Promise.reject(new Error(EXT_GONE_MSG));
        }
    }

    function plural(n, one, few, many) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return one;
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
        return many;
    }

    async function copyToClipboard(text, btn, root) {
        let success = false;
        try {
            await navigator.clipboard.writeText(text);
            success = true;
        } catch (err) {
            try {
                const textarea = root.createElement ? root.createElement('textarea') : document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                root.appendChild(textarea);
                textarea.focus();
                textarea.select();
                success = document.execCommand('copy');
                root.removeChild(textarea);
            } catch (err2) {
                success = false;
            }
        }
        // Показываем отклик, не теряя исходный текст при повторных кликах.
        // Оригинал запоминаем ОДИН раз — пока нет активного таймера; каждый
        // следующий клик лишь перезапускает таймер. Иначе при втором клике за
        // секунду «оригиналом» становилось бы уже показанное «✅» и тема после
        // копирования навсегда оставалась галочкой.
        if (btn._pmCopyTimer) {
            clearTimeout(btn._pmCopyTimer);
        } else {
            btn._pmCopyOriginal = btn.textContent;
        }
        btn.textContent = success ? '✅' : '❌';
        btn._pmCopyTimer = setTimeout(function () {
            btn.textContent = btn._pmCopyOriginal;
            btn._pmCopyTimer = null;
            btn._pmCopyOriginal = undefined;
        }, 1000);
    }

    // Тихое автообновление списка (без окна входа): при открытии панели и при
    // возврате на вкладку почты. Тротлинг, чтобы частое переключение вкладок не
    // дёргало таблицу. Ошибки глушим — это фон, для явного обновления есть ⟳.
    let lastAutoRefreshAt = 0;
    const AUTO_REFRESH_MIN_GAP = 45000; // не чаще раза в 45 секунд

    function autoRefresh(force) {
        if (extensionGone || !extensionAlive()) { noteExtensionGone(); return; }
        const now = Date.now();
        if (!force && now - lastAutoRefreshAt < AUTO_REFRESH_MIN_GAP) return;
        lastAutoRefreshAt = now;
        send({ type: 'pm-refresh-silent' }).then(function (res) {
            if (res && res.ok) {
                latestRows = res.rows || [];
                adoptSelfLabelChanges();    // наши собственные правки уже в таблице
                pruneCache(latestRows);
                render(latestRows, null);   // здесь же обновляются счётчики на плашках
                // Перепоиск писем в почте — только при открытой панели: при закрытой
                // эта информация не видна, а лишний опрос зря бил бы по API почты.
                if (isPanelOpen) setTimeout(() => refreshAllTopics(), 300);
            }
        }).catch(function () { /* фоновое обновление — молчим */ });
    }

    // Возврат к почте перечитывает таблицу — с тротлингом в 45 секунд.
    // ВАЖНО: обновляем и при ЗАКРЫТОЙ панели. Счётчик на плашке виден всегда, и когда
    // в один день работают вдвоём, письма коллеги должны появляться в нём сами, без
    // открывания панели. Раньше условие isPanelOpen оставляло счётчик замороженным на
    // том значении, которое было при загрузке страницы.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) autoRefresh(false);
    });
    // Переключение между окнами браузера не всегда даёт visibilitychange — ловим и focus.
    window.addEventListener('focus', function () { autoRefresh(false); });
    // Переход между папками/вкладками внутри самой почты (адрес меняется, страница — нет).
    window.addEventListener('hashchange', function () { autoRefresh(false); });

    // === КНОПКИ ===
    refreshEl.onclick = function() {
        refreshEl.disabled = true;
        refreshEl.textContent = '⟳';
        send({ type: 'pm-refresh' }).then(function(res) {
            refreshEl.disabled = false;
            refreshEl.textContent = '⟳';
            if (res && res.ok) {
                latestRows = res.rows || [];
                adoptSelfLabelChanges();
                pruneCache(latestRows);
                render(latestRows, null);
                setTimeout(() => refreshAllTopics(true), 300);
            } else {
                showLoadError((res && res.error) || 'Ошибка обновления');
            }
        }).catch(function(err) {
            refreshEl.disabled = false;
            refreshEl.textContent = '⟳';
            showLoadError(err && err.message);
        });
    };

    // === ДОЗАПОЛНЕНИЕ ТАБЛИЦЫ ИЗ ПОЧТЫ ===
    // По невыполненным строкам заполняет ТОЛЬКО пустые поля: дату (самое раннее письмо
    // ветки из почты), номер (regex по теме), склад (по словарю складов из текста темы).
    // Существующие значения не трогает. Пишет одним пакетом и показывает отчёт.
    let isBackfilling = false;

    function tsToISODate(ms) {
        const d = new Date(ms);
        if (isNaN(d)) return null;
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + mo + '-' + day;
    }

    // Склад по тексту темы (для исторических строк меток письма у нас нет, поэтому
    // ищем ключевые слова словаря складов прямо в теме — best-effort).
    function matchWarehouseInText(text, dict) {
        const lower = String(text || '').toLowerCase();
        for (const entry of (dict || [])) {
            if (entry && entry.keyword && lower.includes(String(entry.keyword).toLowerCase())) {
                return entry.warehouse;
            }
        }
        return '';
    }

    async function backfillFromMail() {
        if (isBackfilling) return;
        if (!window.confirm('Дозаполнить пустые поля (дата/номер/склад/вид) по невыполненным строкам, ища письма в почте? Склад и вид подтягиваются по метке письма. Существующие значения не изменятся.')) return;

        isBackfilling = true;
        backfillEl.disabled = true;
        backfillEl.textContent = '⏳';
        try {
            const res = await send({ type: 'pm-refresh-silent' });
            if (!res || !res.ok) { showToast('Не удалось прочитать таблицу', 'error'); return; }
            const rows = res.rows || [];

            let warehouseDict = [];
            let typeDict = [];
            try {
                const st = await chrome.storage.sync.get(['warehouseDictionary', 'typeDictionary']);
                warehouseDict = Array.isArray(st.warehouseDictionary) ? st.warehouseDictionary : [];
                typeDict = Array.isArray(st.typeDictionary) ? st.typeDictionary : [];
            } catch (e) { /* без словарей просто не дозаполним склад/вид */ }

            // Номер вычисляем локально сразу (regex по теме). Дату, а также склад и вид по
            // метке письма — через почту: в web-api письма лежат его метки. В очередь на
            // почту берём строку, если пуста дата ИЛИ склад ИЛИ вид (склад/вид тянем по метке).
            const items = [];
            const needApi = [];
            rows.forEach(function (r) {
                const fields = {};
                if (!r.number) {
                    const n = extractNumberFromTopic(r.topic);
                    if (n) fields.number = n;
                }
                const item = {
                    rowNumber: r.sheetRow,
                    topic: r.topic,
                    number: r.number || fields.number || '',
                    dateAdded: r.dateAdded || null,
                    fields: fields,
                    needDate: !r.dateAdded,
                    needWarehouse: !r.warehouse,
                    needType: !r.type,
                    // Запасной вариант для склада, если метки нет/не совпала — по тексту темы.
                    warehouseFromTopic: !r.warehouse ? matchWarehouseInText(r.topic, warehouseDict) : ''
                };
                items.push(item);
                if (item.needDate || item.needWarehouse || item.needType) needApi.push(item);
            });

            // Поиск по почте с ограниченной параллельностью: одним запросом на строку
            // достаём и дату (самое раннее письмо ветки), и метки (для склада/вида).
            let done = 0;
            const queue = needApi.slice();
            async function worker() {
                while (queue.length) {
                    const it = queue.shift();
                    let labelNames = [];
                    try {
                        const info = await apiGetInfo(it.topic, it.number, it.dateAdded, null, it.preview);
                        if (info) {
                            if (it.needDate) {
                                const iso = (info.lastTs || info.firstTs) ? tsToISODate(info.lastTs || info.firstTs) : null;
                                if (iso) it.fields.date = iso;
                                else it.noDate = true;
                            }
                            if (info.labelIds && info.labelIds.length) {
                                try { labelNames = await lidsToNames(info.labelIds); } catch (e) { /* без имён меток */ }
                            }
                            dlog('🏷️ backfill', it.topic, '→ lids', info.labelIds, '→ имена', labelNames);
                        } else if (it.needDate) {
                            it.noDate = true;
                        }
                    } catch (e) { if (it.needDate) it.noDate = true; }

                    // Имён меток не набралось (в ответе поиска их нет, либо метка
                    // системная и её нет в списке пользовательских) — снимем тексты
                    // меток прямо со строки письма, если она сейчас видна в списке.
                    if (!labelNames.length && (it.needWarehouse || it.needType)) {
                        try {
                            const row = findEmailsByTopic(it.topic)[0];
                            if (row) labelNames = collectRowLabelTexts(row, it.topic);
                        } catch (e) { /* строки в списке нет — не критично */ }
                    }

                    // Склад: сначала по меткам письма (ВСЕ совпавшие, через ", " — письмо
                    // с двумя складскими метками получает оба склада, не только первый),
                    // затем запасной вариант по тексту темы.
                    if (it.needWarehouse) {
                        const whByLabel = matchDictByLabels(labelNames, warehouseDict, 'warehouse');
                        const wh = (whByLabel.length ? whByLabel.join(', ') : '') || it.warehouseFromTopic;
                        if (wh) it.fields.warehouse = wh;
                    }
                    // Вид: только по метке письма (по тексту темы вид не угадываем). Тоже
                    // все совпавшие метки, а не только первая.
                    if (it.needType) {
                        const tpByLabel = matchDictByLabels(labelNames, typeDict, 'type');
                        if (tpByLabel.length) it.fields.type = tpByLabel.join(', ');
                    }

                    done++;
                    backfillEl.title = 'Дозаполнение: ' + done + '/' + needApi.length;
                }
            }
            const workers = [];
            for (let i = 0; i < Math.min(REFRESH_CONCURRENCY, needApi.length); i++) workers.push(worker());
            await Promise.all(workers);

            // Собираем записи (строки, которым нужен только номер, уже получили fields.number).
            const toWrite = items.filter(function (it) { return Object.keys(it.fields).length > 0; })
                .map(function (it) { return { rowNumber: it.rowNumber, fields: it.fields }; });

            const notFoundDate = needApi.filter(function (it) { return it.needDate && it.noDate; }).length;

            if (!toWrite.length) {
                showToast('Нечего дозаполнять: пустых полей нет или письма не найдены' +
                    (notFoundDate ? ' (не найдено дат: ' + notFoundDate + ')' : ''), 'info');
                return;
            }

            const writeRes = await send({ type: 'pm-backfill-write', items: toWrite });
            if (!writeRes || !writeRes.ok) {
                showToast('Ошибка записи: ' + ((writeRes && writeRes.error) || 'неизвестно'), 'error');
                return;
            }

            // Счётчики — из фактически записанного (поля с выключенной колонкой не в счёт).
            const bf = (writeRes && writeRes.byField) || {};
            showToast('Готово: дата +' + (bf.date || 0) + ', номер +' + (bf.number || 0) +
                ', склад +' + (bf.warehouse || 0) + ', вид +' + (bf.type || 0) +
                (notFoundDate ? '; не найдено дат: ' + notFoundDate : ''), 'success');

            autoRefresh(true);
        } catch (err) {
            showToast('Ошибка дозаполнения: ' + err.message, 'error');
        } finally {
            isBackfilling = false;
            backfillEl.disabled = false;
            backfillEl.textContent = '🪄';
            backfillEl.title = 'Дозаполнить пустые поля из почты';
        }
    }

    backfillEl.onclick = backfillFromMail;
    labelAllEl.onclick = function () { bulkApplyLabels('', labelAllEl); };

    toggleAllEl.onclick = function() {
        const cards = listEl.querySelectorAll('.pm-card');
        if (cards.length === 0) return;
        
        let allCollapsed = true;
        for (const card of cards) {
            if (!card.classList.contains('collapsed')) {
                allCollapsed = false;
                break;
            }
        }
        
        for (const card of cards) {
            card.classList.toggle('collapsed', !allCollapsed);
        }
    };

    // === ПЕРЕТАСКИВАНИЕ ПИСЬМА НА ПАНЕЛЬ (drag-and-drop) ===
    // Ловим стандартный HTML5 drag прямо у себя: это надёжнее, чем перетаскивание в
    // папку/метку (не зависим от внутренних do-move/do-label Яндекса). Тему письма
    // снимаем в момент dragstart (в drop dataTransfer у Яндекса часто пустой), затем
    // переиспользуем готовый конвейер: apiGetInfo → дата/метки → склад/вид → номер →
    // pm-append в background. Итог — тост «Добавлено» с кнопкой «Отменить».

    // Селекторы строк письма и темы внутри строки (те же, что в findEmailsByTopic).
    const DRAG_ROW_SELECTOR = '.qa-MessagesListItem, .MessagesList__item, ' +
        '[data-testid="messages-list_message-item"], .MessageListItem__root--qxe9X, ' +
        '.mail-MessageSnippet, .mail-FolderView-Item';
    const DRAG_SUBJECT_SELECTORS = [
        '.MessageListItem__subject--Kqkku .Text',
        '.qa-MessagesListSubject .Text',
        '[data-testid="messages-list_subject"] .Text',
        '.mail-MessageSnippet-Subject span',
        '[class*="Subject"] span',
        '[class*="subject"] span',
        '[class*="Subject" i]'
    ];
    // Селекторы «первой строки текста» письма в списке — той серой приписки после
    // темы. Её же почта диктует в aria-label сразу за темой, из-за чего тело письма
    // уезжало в тему («перемещение - таборы, Подтвеждаем. Примите, …»).
    const DRAG_FIRSTLINE_SELECTORS = [
        '[data-testid="messages-list-firstline_root"]',
        '[data-testid*="firstline" i]',
        '[class*="firstline" i]',
        '[class*="FirstLine" i]',
        '.mail-MessageSnippet-Content'
    ];

    // Селекторы «чипсов» меток внутри строки письма — те же, что в форме захвата
    // (content-capture.js). Частичное совпадение класса/data-testid переживает смену
    // хэш-суффиксов вёрстки.
    const DRAG_LABEL_SELECTORS = [
        '[data-testid*="label" i]',
        '[data-testid*="mark" i]',
        '[class*="Label" i]',
        '[class*="Marks" i]'
    ];

    let draggedItems = [];               // письма, которые сейчас тащат: [{topic, labels}]
    let isDropBusy = false;              // идёт обработка drop
    const dropDicts = { warehouse: [], type: [] };

    // Убирает «слипшийся» счётчик ветки из темы (лист рисует число писем как отдельный
    // мелкий узел) — та же идея, что extractSubjectText в форме захвата.
    function stripSubjectCounter(el) {
        try {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('*').forEach(function (node) {
                if (node.children.length === 0) {
                    const t = (node.textContent || '').trim();
                    if (/^\d{1,2}$/.test(t)) node.remove();
                }
            });
            return (clone.innerText || clone.textContent || '').trim();
        } catch (e) {
            return (el.innerText || el.textContent || '').trim();
        }
    }

    // Настоящая тема письма из aria-label строки — надёжнее любых CSS-селекторов.
    // Яндекс кладёт туда полный набор данных одной строкой: "[Свёрнуто/Развёрнуто,
    // N писем,][С вложениями,][с метками,] Отправитель, ТЕМА[, Папка], Дата, Превью".
    // На ответах внутри развёрнутой ветки видимый текст строки — это ПРЕВЬЮ (первая
    // строка тела письма), а не тема; сама тема (с номером заказа и т.п.) видна только
    // здесь. Имя отправителя, папку и дату берём из соседних data-testid-узлов (они не
    // зависят от хеш-суффиксов вёрстки) — по ним вырезаем тему из середины строки.
    // Отрезает от темы служебные хвосты, которые почта дописывает в aria-label строки:
    // время («, 10:41»), дату («, 25 августа», «, 25.08.2026»), «Вчера/Сегодня».
    // Из-за них тема уезжала в таблицу как «Дёке-Запад ООО, 10:41», и потом письмо по
    // ней уже не находилось.
    // «Re:», «Fwd:» и их русские варианты — это не часть темы, а пометка почты.
    // Яндекс лепит их и в начало, и в конец («Re: Юдилен-холод Re:»), причём в
    // строке ВЕТКИ и в строке отдельного письма по-разному. Из-за этого одна и та
    // же переписка попадала в таблицу под двумя разными темами, а поиск по теме с
    // «Re:» терял часть писем. Режем с обоих концов, сколько бы их ни было.
    const REPLY_MARK_HEAD = /^\s*(re|fw|fwd|ре|отв|ответ|пересылка|пересылаемое сообщение)\s*(\[\d+\])?\s*:\s*/i;
    const REPLY_MARK_TAIL = /\s*(re|fw|fwd|ре|отв|ответ)\s*(\[\d+\])?\s*:\s*$/i;
    function stripReplyMarks(text) {
        let out = String(text || '').trim();
        let changed = true;
        while (changed) {
            changed = false;
            const a = out.replace(REPLY_MARK_HEAD, '');
            if (a !== out) { out = a.trim(); changed = true; }
            const b = out.replace(REPLY_MARK_TAIL, '');
            if (b !== out) { out = b.trim(); changed = true; }
        }
        // Всё оказалось пометками (тема была «Re:») — оставляем исходное, иначе
        // получилась бы пустая тема.
        return out || String(text || '').trim();
    }

    function stripRowSubjectTail(text) {
        let out = stripReplyMarks(text);
        const tails = [
            /[,\s]+\d{1,2}:\d{2}(:\d{2})?$/,                        // 10:41
            /[,\s]+\d{1,2}\s+[а-яё]{3,}(\s+\d{4})?$/i,               // 25 августа 2026
            /[,\s]+\d{1,2}\.\d{1,2}(\.\d{2,4})?$/,                   // 25.08.2026
            /[,\s]+(вчера|сегодня|позавчера)$/i
        ];
        let changed = true;
        while (changed) {
            changed = false;
            for (const re of tails) {
                const next = out.replace(re, '');
                if (next !== out) { out = next.trim(); changed = true; }
            }
        }
        return out.replace(/[,\s]+$/, '').trim();
    }

    function getRowSubjectFromAria(row) {
        let aria = '';
        try {
            // aria-label висит не на самой row (.qa-MessagesListItem), а на её родителе
            // (role="listitem", .qa-MessagesListItemWrap) — closest() находит его, а заодно
            // саму row, если атрибут вдруг окажется на ней.
            const ariaEl = row.closest('[aria-label]');
            aria = ariaEl ? (ariaEl.getAttribute('aria-label') || '') : '';
        } catch (e) { return ''; }
        if (!aria) return '';
        function textOf(selector) {
            try {
                const el = row.querySelector(selector);
                return el ? (el.textContent || '').trim() : '';
            } catch (e) { return ''; }
        }
        const sender = textOf('[data-testid="message-common_sender-name"]');
        let rest = aria;
        if (sender) {
            const si = aria.indexOf(sender);
            if (si !== -1) rest = aria.slice(si + sender.length);
        }
        rest = rest.replace(/^[,\s]+/, '');
        // Дату и папку вырезаем ГДЕ БЫ они ни стояли: в списке письма они идут после
        // темы через запятую, а в результатах поиска — в самом конце строки, и прежняя
        // проверка «ровно такой суффикс» их не находила.
        function cutOut(text, piece) {
            const val = String(piece || '').trim();
            if (!val) return text;
            const i = text.lastIndexOf(val);
            if (i === -1) return text;
            return (text.slice(0, i) + ' ' + text.slice(i + val.length))
                .replace(/\s*,\s*,\s*/g, ', ')
                .replace(/\s{2,}/g, ' ');
        }
        rest = cutOut(rest, textOf('[data-testid="messages-list_message-date"]'));
        rest = cutOut(rest, textOf('[data-testid="message-common_folder-name"]'));
        // Начало текста письма почта диктует сразу ЗА темой, через запятую. Если его
        // не вырезать, в тему уезжает тело: «перемещение - таборы, Подтвеждаем.
        // Примите, 0000-0440205. Спасибо!». Режем по позиции: всё, что после начала
        // текста, к теме уже не относится (там дата, папка и прочая служебка).
        try {
            const fl = getRowFirstline(row);
            if (fl) {
                const head = fl.slice(0, 40);
                const i = head ? rest.indexOf(head) : -1;
                if (i > 0) rest = rest.slice(0, i);
                else if (i === 0) rest = '';
                else rest = cutOut(rest, fl);
            }
        } catch (e) { /* превью нет — не страшно */ }
        rest = rest.replace(/[,\s]+$/, '');
        // Метки письма («Архив», «Партизан») в aria-label тоже перечислены до темы —
        // вырезаем их, иначе они уезжают в тему вместе с ней.
        try {
            collectRowLabelTexts(row, '').forEach(function (t) { rest = cutOut(rest, t); });
        } catch (e) { /* меток нет — не страшно */ }
        rest = rest.replace(/^[,\s]+/, '');
        // …и на всякий случай убираем оставшийся хвост со временем/датой.
        return stripRowSubjectTail(rest).slice(0, 200);
    }

    // Начало текста письма из строки списка. Используем и как отдельное поле для
    // таблицы, и чтобы вырезать тело письма из aria-label при разборе темы.
    function getRowFirstline(row) {
        for (const selector of DRAG_FIRSTLINE_SELECTORS) {
            let el;
            try { el = row.querySelector(selector); } catch (e) { continue; }
            if (!el) continue;
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) return t.slice(0, 200);
        }
        return '';
    }

    function getRowSubject(row) {
        // Сначала — сам узел темы в разметке: там ровно тема, без служебных приписок.
        // aria-label оставляем запасным вариантом (в части вёрсток узла темы нет), но
        // именно из него в тему попадали папка и время.
        const fromNodes = getRowSubjectFromNodes(row);
        if (fromNodes) return fromNodes;
        const fromAria = getRowSubjectFromAria(row);
        if (fromAria) return fromAria;
        return getRowSubjectFallback(row);
    }

    // querySelectorAll, а не querySelector: у некоторых вёрсток тема разбита на
    // несколько узлов, подходящих под один и тот же селектор (например, отдельно
    // префикс «Re:» и сам текст темы) — querySelector брал бы только первый узел
    // («Re:») и терял остальное. Склеиваем все найденные куски по порядку в DOM.
    function getRowSubjectFromNodes(row) {
        for (const selector of DRAG_SUBJECT_SELECTORS) {
            let nodes;
            try { nodes = row.querySelectorAll(selector); } catch (e) { continue; }
            if (!nodes.length) continue;
            const parts = [];
            nodes.forEach(function (el) {
                const t = stripSubjectCounter(el);
                if (t) parts.push(t);
            });
            const s = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (s) return stripRowSubjectTail(s).slice(0, 200);
        }
        return '';
    }

    // Ни один селектор темы не подошёл (вёрстка почты сменилась) — фолбэк.
    function getRowSubjectFallback(row) {
        // row.textContent слипает весь текст строки в одну «строку» без переносов
        // (отправитель+метка+тело+дата подряд), поэтому используем innerText — он
        // учитывает раскладку и расставляет переносы по видимым блокам/строкам, —
        // и берём среди строк самую длинную: тема обычно длиннее имени отправителя,
        // даты или ярлыка метки.
        const lines = (row.innerText || row.textContent || '')
            .split('\n')
            .map(function (l) { return l.trim(); })
            .filter(Boolean);
        if (!lines.length) return '';
        let best = lines[0];
        for (const l of lines) { if (l.length > best.length) best = l; }
        return stripRowSubjectTail(best).slice(0, 200);
    }

    // Определяет выделенные строки (мультивыбор). Если перетаскиваемая строка не входит
    // в выделение — работаем только с ней.
    function getSelectedRows() {
        const rows = [];
        const seen = new Set();
        document.querySelectorAll(DRAG_ROW_SELECTOR).forEach(function (row) {
            if (row.offsetParent === null) return;
            const cb = row.querySelector('input[type="checkbox"]');
            const isSelected =
                row.getAttribute('aria-selected') === 'true' ||
                /(^|[\s_-])(selected|checked|active)([\s_-]|$)/i.test(row.className) ||
                (cb && cb.checked);
            if (isSelected && !seen.has(row)) { seen.add(row); rows.push(row); }
        });
        return rows;
    }

    // Подсветка язычков на время перетаскивания. Панель специально НЕ открываем:
    // письмо бросают прямо на нужный язычок, а какой именно — видно по его имени.
    function armDropUI(on) {
        draggingNow = !!on;
        TOGGLES.forEach(function (t) {
            t.el.classList.toggle('pm-drop-armed', !!on);
            if (!on) t.el.classList.remove('pm-drop-over');
            renderToggleFace(t);
        });
        if (on) {
            if (isPanelOpen) dropzoneEl.classList.add('visible');
        } else {
            dropzoneEl.classList.remove('visible');
            dropzoneEl.classList.remove('hover');
        }
    }

    // Тексты меток, нарисованных прямо в строке письма («Архив», «Проблемные», …).
    // Берём их так же, как форма захвата берёт метки открытого письма, — из DOM.
    // Это принципиально надёжнее меток из ответа API-поиска: там приходят только id
    // (lid), а системные метки (тот же «Архив») в списке ПОЛЬЗОВАТЕЛЬСКИХ меток
    // отсутствуют, поэтому их имя по lid не восстановить и склад/вид не подтянуть.
    function collectRowLabelTexts(row, subject) {
        const out = [];
        const seen = new Set();
        const skip = normForMatch(subject || '');
        const combined = DRAG_LABEL_SELECTORS.join(',');
        DRAG_LABEL_SELECTORS.forEach(function (selector) {
            let nodes;
            try { nodes = row.querySelectorAll(selector); } catch (e) { return; }
            nodes.forEach(function (el) {
                // Берём только «листовые» совпадения: контейнер меток тоже подходит под
                // селектор, но его текст — это все метки, слипшиеся в одну строку.
                try { if (el.querySelector(combined)) return; } catch (e) { /* ignore */ }
                const text = (el.innerText || el.textContent || '').trim();
                // Метка — короткий текст; длинное — это уже тема/сниппет письма.
                if (!text || text.length > 40) return;
                const key = normForMatch(text);
                if (!key || key === skip || seen.has(key)) return;
                seen.add(key);
                out.push(text);
            });
        });
        return out;
    }

    // Достаёт id письма/ветки прямо из строки списка. По ним метка и пометка
    // прочитанным ставятся БЕЗ повторного поиска письма в почте: поиск иногда не
    // находит ветку (тема слишком общая, номер только в теле, индекс не успел
    // обновиться) — и тогда при перетаскивании метка молча не ставилась, а письмо
    // оставалось непрочитанным.
    const ROW_ID_ATTRS = ['data-mid', 'data-id', 'data-message-id', 'data-thread-id'];
    function collectRowMessageIds(row) {
        const plain = [];   // id письма
        const threads = []; // id ветки (с префиксом t)
        const seen = new Set();
        function add(v) {
            const raw = String(v == null ? '' : v).trim();
            if (!raw || seen.has(raw)) return;
            // id письма — длинное число, иногда с префиксом t (ветка). Всё остальное
            // (счётчики, индексы, служебные строки) отсекаем.
            if (!/^t?\d{8,}$/.test(raw)) return;   // id письма — длинное число, счётчики и индексы отсекаем
            seen.add(raw);
            (raw.charAt(0) === 't' ? threads : plain).push(raw);
        }
        // 1) явные data-атрибуты — на самой строке и внутри неё
        function scanAttrs(el) {
            let attrs;
            try { attrs = el.attributes; } catch (e) { return; }
            if (!attrs) return;
            for (let i = 0; i < attrs.length; i++) {
                const name = String(attrs[i].name || '');
                const value = String(attrs[i].value || '');
                if (!/^(id|data-)/i.test(name)) continue;
                // Значение целиком (data-mid="19512345678")…
                add(value);
                // …или id внутри строки вида "thread:19512345678" / "message_19512345678".
                const m = value.match(/(?:^|[^0-9a-z])(t?\d{8,})(?:[^0-9]|$)/i);
                if (m) add(m[1]);
            }
        }
        try { scanAttrs(row); } catch (e) { /* ignore */ }
        try { row.querySelectorAll('*').forEach(scanAttrs); } catch (e) { /* ignore */ }
        // 2) ссылки на письмо/ветку
        try {
            row.querySelectorAll('a[href]').forEach(function (a) {
                const m = String(a.getAttribute('href') || '').match(/(?:message|thread)\/(t?\d{5,})/);
                if (m) add(m[1]);
            });
        } catch (e) { /* ignore */ }
        // Сначала id писем, потом id веток — do-label понимает и то, и другое.
        return plain.concat(threads);
    }

    // Визуальная «ветка» в списке (шапочная свёрнутая строка + отдельный контейнер
    // с развёрнутыми письмами-ответами) — это группировка ТОЛЬКО на уровне интерфейса
    // (по отправителю и времени), а не настоящая переписка на бэкенде: у входящих в
    // неё писем бывают РАЗНЫЕ темы. Поэтому у общего id ветки (data-react-focusable-id
    // с префиксом "t" на шапочной строке) нет гарантии, что do-label затронет все
    // письма, — он бьёт по одному конкретному письму. Если ветка сейчас развёрнута,
    // надёжнее собрать id с КАЖДОЙ видимой строки внутри нее и пометить их все разом.
    // Свёрнутая ветка с несколькими письмами (aria-label начинается со «Свёрнуто»)
    // не рендерит письма-ответы в DOM вообще — findThreadGroupRows тогда ничего не
    // находит, и метка ставится только на одно (представительское) письмо ветки.
    // Перед сбором id такую ветку стоит сначала развернуть (см. handleDrop).
    function isCollapsedThreadHead(row) {
        let wrap;
        try { wrap = row.closest('[role="listitem"]'); } catch (e) { return false; }
        if (!wrap) return false;
        const aria = wrap.getAttribute('aria-label') || '';
        return /^Свернуто\b/i.test(aria) || /^Свёрнуто\b/i.test(aria);
    }

    function findThreadGroupRows(row) {
        let wrap;
        try { wrap = row.closest('[role="listitem"]'); } catch (e) { return null; }
        if (!wrap) return null;
        let container = null;
        if (/isInsideThread/.test(wrap.className || '')) {
            container = wrap.parentElement;
        } else {
            const next = wrap.nextElementSibling;
            if (next && (next.getAttribute('data-testid') === 'messages-list_thread_container' ||
                /ThreadList__root/.test(next.className || ''))) {
                container = next;
            }
        }
        if (!container) return null;
        const rows = [];
        try { container.querySelectorAll(DRAG_ROW_SELECTOR).forEach(function (r) { rows.push(r); }); }
        catch (e) { return null; }
        const headWrap = container.previousElementSibling;
        if (headWrap && headWrap.getAttribute && headWrap.getAttribute('role') === 'listitem') {
            const headRow = headWrap.querySelector(DRAG_ROW_SELECTOR);
            if (headRow) rows.push(headRow);
        }
        return rows.length ? rows : null;
    }

    function collectThreadMessageIds(row) {
        const groupRows = findThreadGroupRows(row);
        if (!groupRows) return collectRowMessageIds(row);
        const plain = [];
        const threads = [];
        const seen = new Set();
        groupRows.forEach(function (r) {
            collectRowMessageIds(r).forEach(function (id) {
                if (seen.has(id)) return;
                seen.add(id);
                (id.charAt(0) === 't' ? threads : plain).push(id);
            });
        });
        // Не смешиваем id отдельных писем и id ветки (с "t") в одном запросе —
        // похоже, именно это почта отклоняет как некорректный запрос (ошибка 400).
        // Если нашлись обычные id писем — их достаточно, id ветки лишний.
        const ids = plain.length ? plain : threads;
        return ids.length ? ids : collectRowMessageIds(row);
    }

    // Если у перетащенного письма в теме нет номера ЗП (часто бывает у ответов —
    // «Энергия ООО», «примите по скану?» и т.п., номер есть только в самом первом
    // письме переписки) — смотрим на остальные письма ветки: тему самого раннего
    // (обычно там номер и есть) и, если она отличается от перетащенной, оставляем
    // её как заметку для человека — иначе несколько строк с одинаковой короткой
    // темой в таблице неотличимы друг от друга.
    function findThreadNumberAndAnchor(row, ownTopic) {
        const groupRows = findThreadGroupRows(row);
        if (!groupRows || groupRows.length < 2) return null;
        const withDates = groupRows.map(function (r) {
            let dateText = '';
            try {
                const el = r.querySelector('[data-testid="messages-list_message-date"]');
                dateText = el ? (el.textContent || '').trim() : '';
            } catch (e) { /* ignore */ }
            const d = tryParseDate(dateText);
            return { r: r, ts: d ? d.getTime() : Infinity };
        }).sort(function (a, b) { return a.ts - b.ts; });

        let numberHint = '';
        let anchorSubject = '';
        withDates.forEach(function (entry) {
            const s = getRowSubject(entry.r);
            if (!s) return;
            if (!anchorSubject) anchorSubject = s;
            if (!numberHint) {
                const n = extractNumberFromTopic(s);
                if (n) numberHint = n;
            }
        });
        if (anchorSubject && normForMatch(anchorSubject) === normForMatch(ownTopic)) anchorSubject = '';
        if (!numberHint && !anchorSubject) return null;
        return { numberHint: numberHint, anchorSubject: anchorSubject };
    }

    // Снимает тему, метки и id со строки (и со всех выделенных, если строка входит
    // в выделение). Возвращает [{ topic, labels, ids, numberHint?, anchorSubject? }].
    function captureItemsFromRow(row) {
        let rows = getSelectedRows();
        if (!rows.length || rows.indexOf(row) === -1) rows = [row];
        const items = [];
        const seen = new Set();
        rows.forEach(function (r) {
            const s = getRowSubject(r);
            const key = normForMatch(s);
            if (s && key && !seen.has(key)) {
                seen.add(key);
                // row — живая ссылка на элемент строки: пригодится в handleDrop, чтобы
                // на СВЁРНУТОЙ ветке принудительно развернуть её и пересобрать id всех
                // писем (см. isCollapsedThreadHead) — иначе метка ставится только на
                // одно (представительское) письмо ветки.
                const item = { topic: s, labels: collectRowLabelTexts(r, s), ids: collectThreadMessageIds(r),
                               preview: getRowFirstline(r), row: r };
                if (!extractNumberFromTopic(s)) {
                    const hint = findThreadNumberAndAnchor(r, s);
                    if (hint) {
                        if (hint.numberHint) item.numberHint = hint.numberHint;
                        if (hint.anchorSubject) item.anchorSubject = hint.anchorSubject;
                    }
                }
                items.push(item);
            }
        });
        return items;
    }

    // Попадание точки экрана в прямоугольник элемента (координатный хит-тест — не зависит
    // от z-index и от того, что за элемент реально под курсором).
    function pointInRect(x, y, el, padX, padY) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const px = padX || 0;
        const py = padY == null ? px : padY;
        return x >= r.left - px && x <= r.right + px && y >= r.top - py && y <= r.bottom + py;
    }
    // Запас вокруг язычка: раз панель во время перетаскивания больше не распахивается,
    // попасть надо в небольшую плашку. По горизонтали запас большой, по вертикали —
    // маленький, когда язычков несколько, иначе их зоны наложились бы друг на друга.
    const TOGGLE_DROP_PAD_X = 32;
    function togglePadY() { return TOGGLES.length > 1 ? 4 : 32; }

    // Язычок под точкой экрана (или null). Координатный хит-тест — не зависит от
    // z-index и от того, что за элемент реально под курсором.
    function toggleAt(x, y) {
        const padY = togglePadY();
        for (let i = 0; i < TOGGLES.length; i++) {
            if (pointInRect(x, y, TOGGLES[i].el, TOGGLE_DROP_PAD_X, padY)) return TOGGLES[i];
        }
        return null;
    }
    // Дедуп на случай, если сработают ОБА пути (нативный drop и mouseup) для одного жеста.
    let lastDropAt = 0;
    function triggerDrop(items, toggle) {
        const now = Date.now();
        if (now - lastDropAt < 800) return;
        lastDropAt = now;
        handleDrop(items, toggle);
    }

    // Общая реакция на «курсор над зоной сброса»: подсветить цель. Панель при этом
    // не открывается — письмо бросают на язычок, а список остаётся как был.
    function updateDropHover(x, y) {
        const t = toggleAt(x, y);
        TOGGLES.forEach(function (tt) { tt.el.classList.toggle('pm-drop-over', tt === t); });
        if (t) setActiveToggle(t);
        if (isPanelOpen) {
            dropzoneEl.classList.add('visible');
            dropzoneEl.classList.toggle('hover', !!t || pointInRect(x, y, panelEl));
        }
    }

    // === ПУТЬ 1: pointer events (основной — Яндекс использует СВОЙ, не нативный, drag) ===
    // Яндекс рисует собственный drag-аватар («Перемещение письма») и не шлёт нативные
    // dragstart/drop на наш виджет. Отслеживаем перетаскивание по pointer-событиям
    // (они приходят для мыши даже если почта слушает только mouse-события или гасит их)
    // и определяем попадание по КООРДИНАТАМ курсора, а не по элементу под ним — это
    // обходит и кастомный drag почты, и любые проблемы с z-index/перекрытием.
    let ptrDrag = null; // { startX, startY, row, active, items }

    function endPtrDrag(e, dropped) {
        const pd = ptrDrag;
        ptrDrag = null;
        if (!pd || !pd.active || !pd.items || !pd.items.length) { return; }
        if (dropped && e) {
            // Бросили на язычок — берём его метку; бросили в открытую панель —
            // метку язычка, с которого её открыли.
            const t = toggleAt(e.clientX, e.clientY);
            if (t) { triggerDrop(pd.items, t); return; }
            if (isPanelOpen && pointInRect(e.clientX, e.clientY, panelEl)) {
                triggerDrop(pd.items, activeToggle);
                return;
            }
        }
        armDropUI(false);
    }

    document.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') { ptrDrag = null; return; } // тач-скролл списка не трогаем
        if (e.button !== 0) { ptrDrag = null; return; }
        const row = e.target && e.target.closest && e.target.closest(DRAG_ROW_SELECTOR);
        if (!row) { ptrDrag = null; return; }
        ptrDrag = { startX: e.clientX, startY: e.clientY, row: row, active: false, items: null };
    }, true);

    document.addEventListener('pointermove', function (e) {
        if (!ptrDrag) return;
        if (!ptrDrag.active) {
            const dx = e.clientX - ptrDrag.startX;
            const dy = e.clientY - ptrDrag.startY;
            if (dx * dx + dy * dy < 36) return; // порог ~6px — отличаем клик от перетаскивания
            ptrDrag.active = true;
            ptrDrag.items = captureItemsFromRow(ptrDrag.row);
            if (!ptrDrag.items.length) { ptrDrag = null; return; }
            armDropUI(true);
        }
        updateDropHover(e.clientX, e.clientY);
    }, true);

    document.addEventListener('pointerup', function (e) { endPtrDrag(e, true); }, true);
    document.addEventListener('pointercancel', function (e) { endPtrDrag(e, false); }, true);

    // === ПУТЬ 2: нативный HTML5 DnD (запасной — если версия почты всё же его использует) ===
    document.addEventListener('dragstart', function (e) {
        try {
            const row = e.target && e.target.closest && e.target.closest(DRAG_ROW_SELECTOR);
            if (!row) { draggedItems = []; return; }
            draggedItems = captureItemsFromRow(row);
            if (draggedItems.length) armDropUI(true);
        } catch (err) { draggedItems = []; }
    }, true);

    document.addEventListener('dragend', function () {
        draggedItems = [];
        if (!isDropBusy) armDropUI(false);
    }, true);

    function allowDrop(e) {
        if (!draggedItems.length) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }

    // Нативный DnD вешаем на каждый язычок отдельно — при перестроении списка меток
    // слушатели уезжают вместе со старыми элементами.
    function attachToggleDnD(t) {
        t.el.addEventListener('dragenter', function (e) {
            if (!draggedItems.length) return;
            e.preventDefault();
            t.el.classList.add('pm-drop-over');
            setActiveToggle(t);
            if (isPanelOpen) dropzoneEl.classList.add('visible');
        });
        t.el.addEventListener('dragleave', function (e) {
            if (!t.el.contains(e.relatedTarget)) t.el.classList.remove('pm-drop-over');
        });
        t.el.addEventListener('dragover', allowDrop);
        t.el.addEventListener('drop', function (e) {
            if (!draggedItems.length) return;
            e.preventDefault();
            const items = draggedItems.slice(); draggedItems = [];
            triggerDrop(items, t);
        });
    }

    // Когда панель открыта — вся её площадь принимает нативный drop.
    panelEl.addEventListener('dragover', function (e) {
        allowDrop(e);
        if (draggedItems.length) dropzoneEl.classList.add('hover');
    });
    panelEl.addEventListener('dragleave', function (e) {
        if (!panelEl.contains(e.relatedTarget)) dropzoneEl.classList.remove('hover');
    });
    panelEl.addEventListener('drop', function (e) {
        if (!draggedItems.length) return;
        e.preventDefault();
        dropzoneEl.classList.remove('hover');
        const items = draggedItems.slice(); draggedItems = [];
        triggerDrop(items, activeToggle);
    });

    // Одна вставка: pm-append (быстрая — тема+номер), обработка дубля через модалку.
    // Возврат { rowNumber } | { skipped } | { error }.
    async function appendOne(payload) {
        let res = await send({ type: 'pm-append', data: payload });
        if (res && res.ok && res.duplicate) {
            const rowsText = res.dupRows.length === 1
                ? ('строка ' + res.dupRows[0])
                : ('строки ' + res.dupRows.join(', '));
            // Говорим ровно то, что совпало. Раньше здесь всегда стоял «Номер «…»»,
            // и при пустом номере человек видел «Номер «» уже есть в таблице» —
            // сообщение ни о чём, притом что на деле совпала ТЕМА, а письмо другое.
            const num = String(payload.number || '').trim();
            const byNumber = !!res.dupByNumber && !!num;
            const what = byNumber
                ? ('Номер «' + num + '» уже есть в таблице (' + rowsText + ') и не выполнен.')
                : ('Письмо с такой же темой уже есть в таблице (' + rowsText + ') и не выполнено.\n' +
                   'Тема: «' + String(payload.topic || '').slice(0, 80) + '»\n' +
                   'Если это другое письмо той же переписки — добавляйте.');
            const proceed = await pmConfirm('⚠️ ' + what + '\n\nВсё равно добавить?');
            if (!proceed) return { skipped: true };
            res = await send({ type: 'pm-append', data: payload, skipDupCheck: true });
        }
        if (!res || !res.ok || !res.inserted) {
            return { error: (res && res.error) || 'не удалось добавить' };
        }
        return { rowNumber: res.rowNumber };
    }

    // Фоновое дозаполнение уже добавленной строки: дата (самое раннее письмо ветки),
    // склад/вид (по метке письма; склад запасным вариантом — по тексту темы) — и ТУТ ЖЕ
    // ставим метку и помечаем письмо прочитанным (переиспользуя найденный info, без
    // повторного поиска). Идёт после того, как пользователь уже увидел «Добавлено».
    async function enrichDroppedRow(topic, number, rowNumber, domLabels, labelName, domIds, preview) {
        let info = null;
        const fields = {};
        // Метки берём из двух источников и объединяем:
        //   1) тексты меток, снятые со строки письма в момент перетаскивания (DOM) —
        //      ровно то же, что видит форма захвата у открытого письма, поэтому сюда
        //      попадают и системные метки вроде «Архив»;
        //   2) метки из ответа API-поиска (по lid) — только пользовательские, зато
        //      работают, если в списке чипсы меток не отрисованы.
        const labelNames = [];
        const labelSeen = new Set();
        function addLabelName(n) {
            const t = String(n || '').trim();
            const key = normForMatch(t);
            if (!t || !key || labelSeen.has(key)) return;
            labelSeen.add(key);
            labelNames.push(t);
        }
        (Array.isArray(domLabels) ? domLabels : []).forEach(addLabelName);
        // id, снятые со строки письма, — ориентир для поиска: по ним из результатов
        // выбирается ИМЕННО эта переписка, а из неё берутся id всех её писем.
        const domPrefer = parseStoredIds((Array.isArray(domIds) ? domIds : []).join(','));

        // Настоящие id письма (сняты из DOM в момент перетаскивания) надёжнее поиска
        // по теме — короткая тема без номера ЗП («Энергия ООО» и т.п.) может совпадать
        // у разных переписок, и дата/метки подтянулись бы от чужого письма.
        let lastTs = 0;
        let labelIdsFound = null;
        const allDomIds = (Array.isArray(domIds) ? domIds : []).map(String).filter(Boolean);
        const plainDomIds = allDomIds.filter(function (id) { return !/^t/.test(id); });
        // Со свёрнутой ветки страница отдаёт только id ВЕТКИ (t193936…), id письма
        // там нет. Раньше такой id просто отбрасывался: дата письма не вычислялась и
        // подставлялась сегодняшняя, а в таблицу ложился id ветки вместо писем.
        // Теперь спрашиваем у почты письма этой ветки — из них берём и дату, и метки,
        // и настоящие id.
        const threadDomId = allDomIds.find(function (id) { return /^t/.test(id); });
        let threadMids = [];

        let threadTid = '';
        async function absorb(msgs) {
            if (!msgs || !msgs.length) return false;
            if (!threadTid && msgs[0] && msgs[0].tid) threadTid = String(msgs[0].tid);
            msgs.forEach(function (m) {
                const t = msgDateMs(m);
                if (t && t > lastTs) lastTs = t;
            });
            const set = new Set();
            msgs.forEach(function (m) { collectMsgLabelIds(m).forEach(function (id) { set.add(id); }); });
            labelIdsFound = Array.from(set);
            threadMids = msgs.map(function (m) { return m.mid; })
                .filter(function (x) { return x && !/^t/.test(String(x)); })
                .map(String);
            return true;
        }

        if (plainDomIds.length) {
            try { await absorb(await findMessagesByMids(plainDomIds)); }
            catch (e) { /* используем поиск по теме ниже */ }
        }
        if (!lastTs && threadDomId) {
            try { await absorb(await findMessagesByTid(threadDomId)); }
            catch (e) { /* используем поиск по теме ниже */ }
        }
        // Ищем письмо всегда, когда id со страницы не дали полной картины: ответ поиска
        // нужен и для даты, и для меток, и — главное — для id ВСЕХ писем ветки.
        if (!lastTs || !labelIdsFound || !domPrefer.any) {
            try { info = await apiGetInfo(topic, number, null, domPrefer.any ? domPrefer : null, preview); }
            catch (e) { /* письма нет — оставим что есть */ }
        }
        // Ответ поиска по теме принимаем ТОЛЬКО как про ту же переписку, что и
        // перетащенное письмо. Иначе от чужой переписки в строку попадут и дата, и
        // метки, и склад — то есть ровно та беда, от которой мы лечим id.
        const knownIds = new Set((threadMids.length ? threadMids : allDomIds)
            .map(function (x) { return stripThreadPrefix(x); }));
        const infoMids = (info && Array.isArray(info.mids)) ? info.mids.map(String) : [];
        const infoIsSameThread = !knownIds.size || !infoMids.length ||
            infoMids.some(function (x) { return knownIds.has(stripThreadPrefix(x)); });
        if (!infoIsSameThread) {
            try {
                console.warn('[Проблемные письма] Дозаполнение: поиск по теме «' + topic +
                    '» нашёл другую переписку — беру только то, что снято со страницы.');
            } catch (e) { /* ignore */ }
            info = null;
        }

        // В таблицу пишем дату ПОСЛЕДНЕГО письма ветки: именно она показывает, когда
        // по вопросу были последние движения (раньше бралось самое первое письмо).
        if (lastTs) {
            const iso = tsToISODate(lastTs);
            if (iso) fields.date = iso;
        } else if (info && (info.lastTs || info.firstTs)) {
            const iso = tsToISODate(info.lastTs || info.firstTs);
            if (iso) fields.date = iso;
        }
        const labelIdsToUse = labelIdsFound || (info && info.labelIds) || [];
        if (labelIdsToUse.length) {
            try { (await lidsToNames(labelIdsToUse)).forEach(addLabelName); }
            catch (e) { /* без имён меток */ }
        }
        if (labelNames.length) {
            dlog('🏷️ drop', topic, '→ метки', labelNames);
            // Все совпавшие метки, через ", " — 2+ складские метки на письме дают оба
            // склада сразу, а не только первый по порядку.
            const wh = matchDictByLabels(labelNames, dropDicts.warehouse, 'warehouse');
            const tp = matchDictByLabels(labelNames, dropDicts.type, 'type');
            if (wh.length) fields.warehouse = wh.join(', ');
            if (tp.length) fields.type = tp.join(', ');
        }
        if (!fields.warehouse) {
            const whText = matchWarehouseInText(topic, dropDicts.warehouse);
            if (whText) fields.warehouse = whText;
        }
        if (!fields.date) fields.date = tsToISODate(Date.now());

        // Перезаписываем колонку «ID письма»: id из ответа почты точнее снятых со
        // страницы, а рядом кладём время письма — по нему строку опознает и сменщица
        // в своей почте, где id другие.
        // id из поиска берём, только если он про ту же переписку, что и перетащенное
        // письмо. Иначе в таблицу лёг бы id ЧУЖОГО письма — и дальше по нему ломается
        // всё: карточка, «Выполнено», снятие метки, проверка дублей.
        // Настоящие id писем ветки (если удалось их спросить) лучше id ветки: по ним
        // работают и сверка «метка уже стоит», и «Выполнено», и поиск карточки.
        const domIdsClean = threadMids.length ? threadMids : allDomIds;
        const infoIds = (info && Array.isArray(info.mids)) ? info.mids.map(String) : [];
        // info здесь уже проверен на «та же переписка» (см. infoIsSameThread выше).
        const resolvedIds = infoIds.length ? infoIds : domIdsClean;
        // Время письма берём в первую очередь от самой ветки, а не от результата
        // поиска: со страницы мы точно знаем, какое письмо перетащили.
        const resolvedTs = lastTs || (info && (info.lastTs || info.firstTs)) || 0;
        const resolvedTid = threadTid || (info && info.tid) || '';
        if (resolvedIds.length || resolvedTs || resolvedTid) {
            // Тоже дописываем: в строку уже легли id, снятые со страницы при
            // перетаскивании, и терять их, если поиск вернул меньше, незачем.
            const merged = mergeMailIdValue(allDomIds.join(','), resolvedIds, resolvedTs, resolvedTid);
            if (merged) fields.mailId = merged;
        }

        if (Object.keys(fields).length) {
            try { await send({ type: 'pm-backfill-write', items: [{ rowNumber: rowNumber, fields: fields }] }); }
            catch (e) { /* не критично */ }
        }
        // Метка + пометка прочитанным (переиспользуем info — без второго поиска письма).
        await labelAndReadFromInfo(info, topic, number, fields.date, labelName, domIds, preview);
    }

    // Элемент перетаскивания всегда приводим к { topic, labels } — на случай, если
    // где-то остался старый вызов со списком одних тем.
    function normalizeDropItem(it) {
        if (typeof it === 'string') return { topic: it, labels: [], ids: [], preview: '' };
        return {
            topic: (it && it.topic) || '',
            labels: (it && Array.isArray(it.labels)) ? it.labels : [],
            ids: (it && Array.isArray(it.ids)) ? it.ids : [],
            numberHint: (it && it.numberHint) || '',
            anchorSubject: (it && it.anchorSubject) || '',
            preview: (it && it.preview) || '',
            row: (it && it.row) || null
        };
    }

    async function handleDrop(itemsArg, toggle) {
        if (isDropBusy) return;
        const items = (Array.isArray(itemsArg) ? itemsArg : draggedItems)
            .map(normalizeDropItem)
            .filter(function (it) { return !!it.topic; });
        draggedItems = [];
        if (!items.length) { armDropUI(false); return; }

        // Метку берём у язычка, на который бросили письмо.
        const target = toggle || activeToggle || TOGGLES[0] || null;
        const labelName = (target && target.name) || '';

        isDropBusy = true;
        const busyText = 'Добавляю' + (items.length > 1 ? ' (' + items.length + ')' : '') + '…';
        // Панель могла остаться закрытой — тогда единственная видимая точка прогресса
        // это сам язычок. Дропзону трогаем, только если панель открыта.
        if (target) {
            target.busy = true;
            target.busyText = busyText;
            target.el.classList.add('pm-drop-busy');
            target.el.classList.remove('pm-drop-over');
            renderToggleFace(target);
        }
        if (isPanelOpen) {
            dropzoneEl.classList.add('visible');
            dropzoneMainEl.style.display = 'none';
            dropzoneBusyEl.style.display = '';
            dropzoneBusyEl.textContent = '⏳ ' + busyText;
        }

        // Словари нужны фоновому дозаполнению (склад/вид по метке).
        try {
            const st = await chrome.storage.sync.get(['warehouseDictionary', 'typeDictionary']);
            dropDicts.warehouse = Array.isArray(st.warehouseDictionary) ? st.warehouseDictionary : [];
            dropDicts.type = Array.isArray(st.typeDictionary) ? st.typeDictionary : [];
        } catch (e) { dropDicts.warehouse = []; dropDicts.type = []; }

        let added = 0, skipped = 0, failed = 0;
        const addedRows = [];
        const enrichJobs = [];
        // Быстрая вставка тема+номер (без ожидания поиска письма) — так «Добавлено»
        // появляется почти мгновенно, как в форме. Остальное дозаполняем фоном.
        for (const item of items) {
            const topic = item.topic;

            // Свёрнутая ветка не рендерит письма-ответы в DOM — id, снятые в момент
            // перетаскивания, тогда покрывают только одно (представительское) письмо
            // ветки, и метка «через раз» ставится не на всю переписку. Пока строка
            // ещё точно на экране (мы только что её тащили) — разворачиваем и
            // пересобираем id заново, теперь уже по всем видимым письмам ветки.
            if (item.row && isCollapsedThreadHead(item.row)) {
                try {
                    expandThreadInList(item.row);
                    await new Promise(function (res) { setTimeout(res, 550); });
                    const freshIds = collectThreadMessageIds(item.row);
                    if (freshIds && freshIds.length > item.ids.length) item.ids = freshIds;
                } catch (e) { /* используем то, что уже было собрано при перетаскивании */ }
            }

            // Номера в теме перетащенного письма может не быть (короткий ответ вроде
            // «Энергия ООО») — тогда берём номер из самого раннего письма ветки, а
            // его тему кладём в комментарий, чтобы отличать одинаковые короткие темы.
            const number = extractNumberFromTopic(topic) || item.numberHint || '';
            const payload = { topic: topic, number: number, label: labelName };
            if (item.anchorSubject) payload.comment = 'Ветка: ' + item.anchorSubject;
            // Настоящий id письма/ветки, снятый из DOM в момент перетаскивания —
            // сохраняем его в таблицу (если для этого поля включена колонка в
            // Настройках), чтобы «Выполнено»/синхронизация потом не гадали по теме.
            if (item.ids && item.ids.length) payload.mailId = item.ids.join(',');
            // Начало текста письма — вторая примета переписки помимо темы: у писем
            // без темы и у одинаковых тем от одного поставщика различается именно оно.
            if (item.preview) payload.preview = item.preview;
            let r;
            try { r = await appendOne(payload); }
            catch (e) { failed++; continue; }
            if (r.skipped) skipped++;
            else if (r.error) failed++;
            else {
                added++;
                addedRows.push({ rowNumber: r.rowNumber, topic: topic });
                enrichJobs.push(enrichDroppedRow(topic, number, r.rowNumber, item.labels, labelName, item.ids, item.preview));
            }
        }

        dropzoneBusyEl.style.display = 'none';
        dropzoneMainEl.style.display = '';
        if (target) {
            target.busy = false;
            target.busyText = '';
            target.el.classList.remove('pm-drop-busy');
        }
        isDropBusy = false;
        armDropUI(false);

        if (added === 1 && addedRows.length === 1) {
            const row = addedRows[0];
            showActionToast('✅ Добавлено в таблицу', 'Отменить', function () {
                send({ type: 'pm-delete-row', rowNumber: row.rowNumber, topic: row.topic })
                    .then(function (dr) {
                        if (dr && dr.ok) { showToast('Отменено — строка удалена', 'info'); autoRefresh(true); }
                        else showToast('Не удалось отменить' + (dr && dr.error ? ' (' + dr.error + ')' : ''), 'error');
                    })
                    .catch(function (e) { showToast('Не удалось отменить: ' + e.message, 'error'); });
            }, 'success', 7000);
        } else if (added > 1) {
            showToast('✅ Добавлено писем: ' + added +
                (skipped ? ', пропущено: ' + skipped : '') +
                (failed ? ', ошибок: ' + failed : ''), 'success');
        } else if (skipped && !failed) {
            showToast('Ничего не добавлено — дубли пропущены', 'info');
        } else if (failed) {
            showToast('Не удалось добавить' + (skipped ? ' (пропущено: ' + skipped + ')' : ''), 'error');
        }

        // Письмо добавили МЫ — метку расширение тут же и поставило. Краснеть незачем:
        // при следующей загрузке строк слепок этой плашки просто перезапишется.
        if (added) noteSelfLabelChange(labelName);
        if (added) autoRefresh(true);
        // Когда фоновое дозаполнение (дата/склад/вид/метка/прочтение) закончится —
        // ещё раз обновим список, чтобы поля появились в карточках.
        if (enrichJobs.length) {
            Promise.all(enrichJobs).then(function () { autoRefresh(true); }).catch(function () {});
        }
    }

    // === ЗАПУСК ===
    async function init() {
        await loadTheme();
        printPreviousTrace();     // что происходило перед прошлой выгрузкой вкладки
        trace('панель загрузилась');
        startOpenMessageWatch();  // отмечаем момент, когда открытое письмо закрылось
        await reloadLabelCfg();   // язычки строятся по списку меток из настроек
        await loadView();       // сортировка и фильтр — как их оставили в прошлый раз
        // Списки собраны раньше init, поэтому проставляем в них загруженный выбор.
        try { if (sortEl) sortEl.value = VIEW.sort; } catch (e) { /* ignore */ }
        await loadCacheFromStorage();
        updateCacheInfo();
        loadMailboxUid().catch(function () { /* без пометки владельца работаем как раньше */ });
        
        // Ответа может не быть вовсе: служебный процесс расширения выгружается, и порт
        // закрывается молча. Раньше панель и попап оставались в «загрузка…» навсегда,
        // а на плашках висели нули — не отличить от «в таблице пусто».
        let answered = false;
        setTimeout(function () {
            if (!answered) showLoadError('таблица не ответила — нажмите ⟳');
        }, 20000);

        send({ type: 'pm-get' }).then(function(res) {
            answered = true;
            if (res && res.ok) {
                latestRows = res.rows || [];
                // Ответ пришёл, а строк ноль — называем причину, а не показываем нули.
                if (!latestRows.length && res.diag) {
                    try {
                        console.warn('[Проблемные письма] Таблица прочитана, но строк нет:\n' +
                            JSON.stringify(res.diag, null, 2));
                    } catch (e) { /* ignore */ }
                }
                // Список показан из сохранённого, но последнее чтение таблицы сорвалось —
                // говорим об этом, иначе данные молча стареют.
                if (res.warning) {
                    setTimeout(function () {
                        showToast('Список показан из сохранённого: таблица не читается (' +
                                  res.warning + '). Нажмите ⟳, чтобы повторить.', 'error');
                    }, 1200);
                }
                render(latestRows, null);
                setTimeout(() => refreshAllTopics(), 500);
                ensureObserver();
            } else {
                showLoadError((res && res.error) || 'Не удалось загрузить данные');
            }
        }).catch(function(err) {
            answered = true;
            showLoadError(err && err.message);
        });
    }

    init();
    dlog('✅ Проблемные письма — панель загружена');
})();