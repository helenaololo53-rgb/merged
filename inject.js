// Работает в MAIN-мире страницы Яндекс Почты (document_start).
// 1) Перехватывает «конверт» настоящих запросов клиента почты (_ckey, _uid и пр.).
// 2) По запросу от content.js выполняет поиск письма через тот же web-api,
//    подменяя только params, и возвращает JSON обратно.
//
// Так расширение не зависит от того, как именно почта кодирует тело запроса,
// и всегда использует свежий _ckey — это устойчиво к обновлениям Яндекса.

(function () {
    'use strict';

    // Совпадает с эндпоинтом вида /web-api/models/liza1?_m=...
    const ENDPOINT_RE = /\/web-api\/models\/liza\d*\?/;

    // Шаблон реального запроса: { url, body, headers }. Обновляем на каждом запросе
    // почты, чтобы _ckey/таймстемпы/заголовки авторизации оставались свежими.
    let template = null;
    let announced = false;

    const origFetch = window.fetch;

    // Заголовки, которые нельзя/не нужно переносить в переигранный запрос: cookie идёт
    // через credentials:'include', длину/хост проставляет сам браузер, Content-Type мы
    // задаём под формат тела. Остальные (в т.ч. x-ya-*/csrf) переносим как есть — без
    // них модели вроде labels/do-label отвечают AUTH_NO_AUTH.
    const HEADER_BLOCKLIST = { 'cookie': 1, 'content-length': 1, 'host': 1, 'content-type': 1, 'accept-encoding': 1, 'connection': 1 };

    function normalizeHeaders(h) {
        const out = {};
        if (!h) return out;
        try {
            if (typeof Headers !== 'undefined' && h instanceof Headers) {
                h.forEach(function (v, k) { out[String(k)] = v; });
            } else if (Array.isArray(h)) {
                h.forEach(function (pair) { if (pair && pair.length >= 2) out[String(pair[0])] = pair[1]; });
            } else if (typeof h === 'object') {
                Object.keys(h).forEach(function (k) { out[k] = h[k]; });
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    // Оставляем только безопасные для переигрывания заголовки.
    function filterHeaders(h) {
        const out = {};
        Object.keys(h || {}).forEach(function (k) {
            if (!HEADER_BLOCKLIST[String(k).toLowerCase()]) out[k] = h[k];
        });
        return out;
    }

    function looksLikeEnvelope(body) {
        return typeof body === 'string' && body.indexOf('models') !== -1 && body.indexOf('_ckey') !== -1;
    }

    // Конверт берём ЦЕЛИКОМ от одного запроса — url, тело и заголовки одной пары.
    // Смешивать заголовки одного запроса с телом другого нельзя: ключ сессии _ckey
    // лежит в теле, и рассинхрон даёт AUTH_NO_AUTH. И всегда берём САМЫЙ СВЕЖИЙ
    // запрос: ключ со временем протухает, поэтому «придержать» старый конверт —
    // ровно тот случай, когда метки начинают ставиться через раз.
    // Params модели `messages` из ПОСЛЕДНЕГО настоящего запроса почты. Как именно эта
    // сборка просит «письма с меткой», заранее неизвестно (имя параметра гуляет), но
    // когда открыт вид метки — почта спрашивает ровно это сама. Подсматриваем её запрос
    // и берём написание фильтра оттуда, вместо перебора вариантов вслепую.
    let lastMessagesParams = null;
    let lastThreadParams = null;
    // Params настоящего ПОИСКА почты и настоящего открытия ПАПКИ. Из них берём
    // написание поля с поисковым запросом и поля с идентификатором папки: в разных
    // сборках они называются по-разному, и наугад собранный запрос почта молча
    // выполняет как глобальный — «ищет не в той папке».
    let lastSearchParams = null;
    let lastFolderListParams = null;

    // Поле с текстом поискового запроса и поле с идентификатором папки.
    const SEARCH_TEXT_KEYS = /^(request|query|text|search_request|searchRequest)$/;
    const FOLDER_KEYS = /^(fid|fids|folder_id|folderId|folder)$/;

    function paramsLookLikeSearch(p) {
        if (!p || typeof p !== 'object') return false;
        if (p.search === 'search' || p.search === true) return true;
        return Object.keys(p).some(function (k) {
            return SEARCH_TEXT_KEYS.test(k) && typeof p[k] === 'string' && p[k].trim() !== '';
        });
    }

    function paramsFolderKey(p) {
        if (!p || typeof p !== 'object') return null;
        const keys = Object.keys(p).filter(function (k) {
            const v = p[k];
            const filled = Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
            return FOLDER_KEYS.test(k) && filled;
        });
        return keys.length ? keys[0] : null;
    }

    // Идентификатор почтового ящика из настоящего запроса почты. Нужен, чтобы
    // помечать в таблице, ЧЕЙ ящик выдал сохранённые id письма: у каждого сотрудника
    // они свои, и чужие проверять смысла нет.
    let mailboxUid = null;

    function rememberMailboxUid(body) {
        const keys = ['_uid', 'uid', 'mailboxUid'];
        try {
            const obj = JSON.parse(body);
            if (obj && typeof obj === 'object') {
                for (const k of keys) {
                    const v = obj[k];
                    if (v != null && /^\d{3,}$/.test(String(v))) { mailboxUid = String(v); return; }
                }
            }
        } catch (e) { /* не JSON — пробуем форму */ }
        try {
            const params = new URLSearchParams(body);
            for (const k of keys) {
                const v = params.get(k);
                if (v && /^\d{3,}$/.test(v)) { mailboxUid = v; return; }
            }
        } catch (e) { /* ignore */ }
    }

    // Как САМА почта ставит и снимает метку. Расширение перечисляет id писем поимённо,
    // и если список неполный — часть переписки метку не получает. Почта же наверняка
    // умеет пометить ветку целиком; подсмотрим её запрос, когда метку поставят руками.
    let lastLabelOp = null;

    function rememberLabelOp(models) {
        for (const mdl of models) {
            if (!mdl || !mdl.params || typeof mdl.params !== 'object') continue;
            if (mdl.name === 'do-label' || mdl.name === 'do-unlabel') {
                lastLabelOp = { name: mdl.name, params: mdl.params };
                try {
                    reveal({ source: 'pm-label-op-seen', op: mdl.name, params: mdl.params });
                } catch (e) { /* ignore */ }
                return;
            }
        }
    }

    function rememberMessagesParams(body) {
        let models = null;
        try {
            const obj = JSON.parse(body);
            if (obj && obj.models) models = obj.models;
        } catch (e) { /* не JSON — пробуем форму */ }
        if (!models) {
            try {
                const params = new URLSearchParams(body);
                const raw = params.get('models');
                if (raw) models = JSON.parse(raw);
            } catch (e) { /* ignore */ }
        }
        if (!Array.isArray(models)) return;
        try { rememberLabelOp(models); } catch (e) { /* ignore */ }
        for (const mdl of models) {
            if (!mdl || mdl.name !== 'messages' || !mdl.params || typeof mdl.params !== 'object') continue;
            lastMessagesParams = mdl.params;
            // Поиск и открытие папки запоминаем отдельно: по первому узнаём, как эта
            // сборка называет поле запроса, по второму — поле папки.
            if (paramsLookLikeSearch(mdl.params)) lastSearchParams = mdl.params;
            else if (paramsFolderKey(mdl.params)) lastFolderListParams = mdl.params;
            // Запрос ПЕРЕПИСКИ (в нём есть tid) запоминаем отдельно: по нему строится
            // выборка всех писем ветки, а её форма в разных сборках своя. Когда человек
            // открывает письмо, почта делает ровно такой запрос — берём его у неё.
            const keys = Object.keys(mdl.params);
            if (keys.some(function (k) { return /^(tid|thread_id|threadId)$/.test(k); })) {
                lastThreadParams = mdl.params;
            }
            return;
        }
    }

    function captureTemplate(url, body, headers) {
        if (!url || !ENDPOINT_RE.test(url) || !looksLikeEnvelope(body)) return;
        try { rememberMessagesParams(body); } catch (e) { /* ignore */ }
        try { rememberMailboxUid(body); } catch (e) { /* ignore */ }
        template = { url: url, body: body, headers: normalizeHeaders(headers) };
        if (!announced) {
            announced = true;
            reveal({ source: 'pm-envelope-ready' });
        }
    }

    // Отвечаем строго в СВОЙ origin, а не в '*'. С '*' ответ почты — письма, их темы
    // и авторы — слышал любой фрейм на странице, в том числе чужой.
    function reveal(payload) {
        try { window.postMessage(payload, location.origin); } catch (e) { /* ignore */ }
    }

    // Модели, которые мосту разрешено выполнять.
    //
    // Мост переигрывает запрос почты её же «конвертом», то есть с живым _ckey
    // пользователя. Единственная проверка отправителя, которая здесь возможна, —
    // «это моё окно и мой origin»: content-скрипт живёт в ИЗОЛИРОВАННОМ мире и
    // разделить с этим кодом секрет через postMessage не может, канал открыт для
    // любого скрипта страницы. Настоящей границей безопасности это не сделать, но
    // можно резко сузить ущерб: мост выполняет только те модели, которыми пользуется
    // само расширение, и не годится как универсальный прокси к API почты (перенос
    // писем, удаление, отправка).
    const ALLOWED_MODELS = {
        'messages': 1,        // поиск и выборки писем
        'labels': 1,          // список меток ящика
        'do-label': 1,        // поставить метку
        'do-unlabel': 1,      // снять метку
        'do-labels-add': 1,   // завести метку, которой нет в этом ящике
        'do-messages': 1,     // пометить прочитанным
        'folders': 1          // список папок для приоритета поиска
    };

    function modelsAllowed(models) {
        if (!Array.isArray(models) || !models.length) return false;
        return models.every(function (m) {
            return m && typeof m.name === 'string' && ALLOWED_MODELS[m.name] === 1;
        });
    }

    // --- перехват fetch ---
    window.fetch = function (input, init) {
        try {
            const url = (typeof input === 'string') ? input : (input && input.url);
            const body = init && init.body;
            // Заголовки могут лежать в init.headers или в самом Request (input).
            let headers = init && init.headers;
            if (!headers && input && typeof input !== 'string' && input.headers) headers = input.headers;
            if (typeof body === 'string') captureTemplate(url, body, headers);
        } catch (e) { /* ignore */ }
        return origFetch.apply(this, arguments);
    };

    // --- перехват XHR (на случай, если часть запросов идёт через него) ---
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__pmUrl = url;
        this.__pmHeaders = {};
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try { if (!this.__pmHeaders) this.__pmHeaders = {}; this.__pmHeaders[name] = value; } catch (e) { /* ignore */ }
        return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        try {
            if (typeof body === 'string') captureTemplate(this.__pmUrl, body, this.__pmHeaders);
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
    };

    // Приводим _m в URL к messages (шаблон мог быть снят с другого метода).
    function toMessagesUrl(url) {
        return url.replace(/([?&]_m=)[^&]*/, '$1messages');
    }

    // Заменяет значение _m в URL на произвольное (do-label, do-unlabel, labels…).
    function setModelParam(url, m) {
        return url.replace(/([?&]_m=)[^&]*/, '$1' + encodeURIComponent(m));
    }

    // Собирает запрос с ПРОИЗВОЛЬНЫМ набором моделей, повторно используя «конверт»
    // (тот же _ckey/_uid и т.д.). Формат тела — как у оригинала (JSON или форма).
    function buildModelsRequest(models, m) {
        if (!template) return null;
        const url = setModelParam(template.url, m || 'messages');
        const body = template.body;
        try {
            const obj = JSON.parse(body);
            if (obj && obj.models) {
                obj.models = models;
                return { url: url, body: JSON.stringify(obj), contentType: 'application/json; charset=UTF-8' };
            }
        } catch (e) { /* не JSON — пробуем форму */ }
        try {
            const params = new URLSearchParams(body);
            if (params.has('models')) {
                params.set('models', JSON.stringify(models));
                return { url: url, body: params.toString(), contentType: 'application/x-www-form-urlencoded; charset=UTF-8' };
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // params для поиска — как в реальном поисковом запросе почты.
    // folderId (fid) ограничивает поиск одной папкой — панель шлёт его для приоритета
    // папок («Отправленные» проверяются в последнюю очередь). Если folderId не задан —
    // поиск глобальный по всем папкам, как раньше.
    function searchModels(topic, folderId) {
        const params = {
            mailboxUid: null,
            sort_type: 'date',
            request: topic,
            search: 'search',
            usePublicName: ''
        };
        if (folderId != null && folderId !== '') {
            params.fid = String(folderId);
        }
        return [{
            name: 'messages',
            params: params,
            meta: { requestAttempt: 1 }
        }];
    }

    // Собираем тело нашего запроса в том же формате, что у оригинала
    // (JSON или form-urlencoded с полем models).
    function buildRequest(topic, folderId, explicitParams) {
        if (!template) return null;
        const models = explicitParams
            ? [{ name: 'messages', params: explicitParams, meta: { requestAttempt: 1 } }]
            : searchModels(topic, folderId);
        const body = template.body;

        // Вариант 1: тело — JSON.
        try {
            const obj = JSON.parse(body);
            if (obj && obj.models) {
                obj.models = models;
                return {
                    url: toMessagesUrl(template.url),
                    body: JSON.stringify(obj),
                    contentType: 'application/json; charset=UTF-8'
                };
            }
        } catch (e) { /* не JSON — пробуем форму */ }

        // Вариант 2: тело — form-urlencoded с полем models.
        try {
            const params = new URLSearchParams(body);
            if (params.has('models')) {
                params.set('models', JSON.stringify(models));
                return {
                    url: toMessagesUrl(template.url),
                    body: params.toString(),
                    contentType: 'application/x-www-form-urlencoded; charset=UTF-8'
                };
            }
        } catch (e) { /* ignore */ }

        return null;
    }

    // Отправляет собранный запрос и отвечает обратно в content.js. Переносим
    // захваченные заголовки исходного запроса (кроме служебных) — иначе часть моделей
    // (labels/do-label/do-messages) отвечает AUTH_NO_AUTH.
    function sendReq(req, reply) {
        const headers = Object.assign(
            {},
            template && template.headers ? filterHeaders(template.headers) : {},
            { 'Content-Type': req.contentType }
        );
        origFetch.call(window, req.url, {
            method: 'POST',
            headers: headers,
            body: req.body,
            credentials: 'include'
        })
            .then(function (res) { return res.json(); })
            .then(function (data) { reply({ ok: true, data: data }); })
            .catch(function (err) { reply({ ok: false, error: String((err && err.message) || err) }); });
    }

    // --- обработка запросов от content.js ---
    window.addEventListener('message', function (e) {
        if (e.source !== window || e.origin !== location.origin || !e.data) return;

        // Опрос готовности моста. Сообщение pm-envelope-ready отправляется один раз и
        // может уйти ДО того, как content-скрипт начнёт слушать (он грузится позже,
        // на document_idle). Тогда панель считала мост неготовым и ждала его впустую.
        if (e.data.source === 'pm-envelope-ping') {
            if (template) reveal({ source: 'pm-envelope-ready' });
            return;
        }

        // Почта ответила AUTH_NO_AUTH — пойманный конверт протух. Забываем его и
        // ждём следующий настоящий запрос почты, чтобы переснять свежий.
        if (e.data.source === 'pm-envelope-invalidate') {
            template = null;
            announced = false;
            return;
        }

        // Поиск письма по теме.
        if (e.data.source === 'pm-search-request') {
            const id = e.data.id;
            const topic = e.data.topic;
            const folderId = e.data.folderId;
            function reply(payload) {
                payload.source = 'pm-search-response';
                payload.id = id;
                reveal(payload);
            }
            if (!template) { reply({ ok: false, error: 'no-template' }); return; }
            // Панель может прислать ГОТОВЫЕ params (форма, подсмотренная у самой почты
            // и проверенная по факту). Тогда ничего не додумываем и шлём как есть.
            const req = buildRequest(topic, folderId, e.data.params || null);
            if (!req) { reply({ ok: false, error: 'bad-template' }); return; }
            sendReq(req, reply);
            return;
        }

        // Какими параметрами сама почта просит список писем (в т.ч. в виде метки).
        if (e.data.source === 'pm-messages-params-request') {
            reveal({
                source: 'pm-messages-params-response',
                id: e.data.id,
                ok: true,
                params: lastMessagesParams || null,
                threadParams: lastThreadParams || null,
                labelOp: lastLabelOp || null,
                searchParams: lastSearchParams || null,
                folderListParams: lastFolderListParams || null,
                folderKey: paramsFolderKey(lastSearchParams) || paramsFolderKey(lastFolderListParams) || null,
                uid: mailboxUid || null
            });
            return;
        }

        // Произвольный вызов моделей (do-label / do-unlabel / labels).
        if (e.data.source === 'pm-api-request') {
            const id = e.data.id;
            function reply(payload) {
                payload.source = 'pm-api-response';
                payload.id = id;
                reveal(payload);
            }
            if (!template) { reply({ ok: false, error: 'no-template' }); return; }
            if (!modelsAllowed(e.data.models)) { reply({ ok: false, error: 'model-not-allowed' }); return; }
            const req = buildModelsRequest(e.data.models, e.data.m);
            if (!req) { reply({ ok: false, error: 'bad-template' }); return; }
            sendReq(req, reply);
            return;
        }
    });
})();