// content-capture.js — читает данные открытого письма (тема, дата, метки, номер)
// для формы «Взять на контроль». Работает вместе с content-panel.js в одном
// изолированном мире, поэтому весь код обёрнут в IIFE, чтобы не пересекаться
// с глобальными именами панели.
(function () {
  // Отладочные логи. Включить: localStorage.setItem('pm-debug', '1') в консоли почты.
  const DEBUG = (function () {
    try { return localStorage.getItem('pm-debug') === '1'; } catch (e) { return false; }
  })();
  function dlog() { if (DEBUG) console['log'].apply(console, arguments); }

  dlog("🔄 Скрипт захвата загружен");

  // ============================================
  // ПАРСИНГ ДАТЫ
  // ============================================
  function parseRussianDateImproved(text) {
    // Полный словарь месяцев (и краткие, и полные названия)
    const months = {
      'янв': '01', 'января': '01',
      'фев': '02', 'февраля': '02',
      'мар': '03', 'марта': '03',
      'апр': '04', 'апреля': '04',
      'май': '05', 'мая': '05',
      'июн': '06', 'июня': '06',
      'июл': '07', 'июля': '07',
      'авг': '08', 'августа': '08',
      'сен': '09', 'сентября': '09',
      'окт': '10', 'октября': '10',
      'ноя': '11', 'ноября': '11',
      'дек': '12', 'декабря': '12'
    };

    dlog(`🔍 Парсинг текста: "${text}"`);

    // === СПОСОБ 1: "7 августа 2024" (год указан явно) ===
    // Проверяем этот вариант ПЕРВЫМ: если в тексте есть год, доверяем ему, а не
    // текущему году — иначе письма за прошлые годы получают сегодняшний год.
    const match2 = String(text).match(/(\d{1,2})\s+([а-я]{3,})\s+(\d{4})/i);
    if (match2) {
      const day = match2[1].padStart(2, '0');
      const month = months[match2[2].toLowerCase()];
      const year = match2[3];
      if (month) {
        const result = `${year}-${month}-${day}`;
        dlog(`  → Результат: ${result}`);
        return result;
      }
    }

    // === СПОСОБ 2: "7 августа" или "7 августа в 15:31" (года в тексте нет) ===
    // Яндекс не показывает год для писем текущего календарного года — раз год не
    // найден способом выше, это единственный безопасный случай для такого допущения.
    const match1 = String(text).match(/(\d{1,2})\s+([а-я]{3,})/i);
    if (match1) {
      const day = match1[1].padStart(2, '0');
      const monthName = match1[2].toLowerCase();
      const month = months[monthName];

      dlog(`  День: ${day}, Месяц: ${monthName} → ${month}`);

      if (month) {
        const currentYear = new Date().getFullYear();
        const result = `${currentYear}-${month}-${day}`;
        dlog(`  → Результат: ${result}`);
        return result;
      } else {
        dlog(`  ❌ Месяц "${monthName}" не найден в словаре`);
      }
    }

    // === СПОСОБ 3: "07.08.2024" ===
    const match3 = String(text).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (match3) {
      const result = `${match3[3]}-${match3[2].padStart(2, '0')}-${match3[1].padStart(2, '0')}`;
      dlog(`  → Результат: ${result}`);
      return result;
    }

    // === СПОСОБ 4: "2024-08-07" ===
    const match4 = String(text).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match4) {
      const result = `${match4[1]}-${match4[2]}-${match4[3]}`;
      dlog(`  → Результат: ${result}`);
      return result;
    }

    dlog(`  ❌ Не удалось распарсить`);
    return null;
  }

  // ============================================
  // ОТЛАДКА СЕЛЕКТОРОВ
  // ============================================
  function debugSelectors() {
    dlog('=== ОТЛАДКА СЕЛЕКТОРОВ ===');

    dlog('🔍 Проверка селекторов темы:');
    const testSelectors = [
      '[data-testid="message-subject"]',
      '[class*="Title__subject"]',
      '.Title__subject--naoFv',
      '.mail-Message-Toolbar-Subject',
      '.mail-Message-Header h1'
    ];

    for (let sel of testSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          let text = extractSubjectText(el);
          text = text.replace(/^Re\s*[:：]\s*/, '').trim();
          text = text.replace(/\s+\d{1,2}$/, '').trim();
          text = text.replace(/([^\d\s-])\d{1,2}$/, '$1').trim();
          dlog(`  ✅ Селектор "${sel}" → "${text}"`);
        } else {
          dlog(`  ❌ Селектор "${sel}" → не найден`);
        }
      } catch (e) {
        dlog(`  ⚠️ Ошибка "${sel}":`, e.message);
      }
    }

    dlog('🔍 Проверка селекторов даты:');
    const dateTestSelectors = [
      '[data-testid="message-viewer_header-date-link"]',
      '[data-testid="message-date"]',
      '.Header__dateLink--TcuKu',
      '.qa-MessageViewer-Header-dateLink',
      '.mail-Message-Toolbar-Date'
    ];

    for (let sel of dateTestSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          dlog(`  ✅ Селектор "${sel}" → "${text}"`);
          const parsed = parseRussianDateImproved(text);
          dlog(`     → Распарсено: ${parsed || '❌ не удалось'}`);
        } else {
          dlog(`  ❌ Селектор "${sel}" → не найден`);
        }
      } catch (e) {
        dlog(`  ⚠️ Ошибка "${sel}":`, e.message);
      }
    }

    dlog('🔍 Проверка селекторов меток:');
    const labelTestSelectors = [
      '[data-testid*="label" i]',
      '[data-testid*="mark" i]',
      '[class*="Label" i]',
      '[class*="Marks" i]'
    ];
    for (let sel of labelTestSelectors) {
      try {
        const found = document.querySelectorAll(sel);
        dlog(`  Селектор "${sel}" → найдено элементов: ${found.length}`);
        found.forEach(el => {
          const text = el.innerText && el.innerText.trim();
          if (text) dlog(`     → "${text}"`);
        });
      } catch (e) {
        dlog(`  ⚠️ Ошибка "${sel}":`, e.message);
      }
    }

    dlog('=== КОНЕЦ ОТЛАДКИ ===');
  }

  // Счётчик количества писем в ветке Яндекс рисует отдельным вложенным элементом
  // рядом с темой, а не добавляет пробел в сам текст — поэтому если номер заявки в
  // теме заканчивается цифрами, счётчик прилипает к нему впритык ("027325215") и
  // регуляркой по итоговой строке его уже не отличить от настоящих цифр номера.
  // Надёжнее вырезать сам DOM-узел счётчика до того, как мы склеим текст.
  function extractSubjectText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('*').forEach(node => {
      if (node.children.length === 0) {
        const nodeText = (node.textContent || '').trim();
        if (/^\d{1,2}$/.test(nodeText)) {
          node.remove();
        }
      }
    });
    return clone.innerText.trim();
  }

  // ============================================
  // МЕТКИ ПИСЬМА
  // ============================================
  // Частичное совпадение класса/data-testid — переживает смену хэш-суффиксов верстки.
  const LABEL_SELECTORS = [
    '[data-testid*="label" i]',
    '[data-testid*="mark" i]',
    '[class*="Label" i]',
    '[class*="Marks" i]'
  ];

  // Ключ для сравнения меток: без крайних пробелов, схлопнутые внутренние пробелы,
  // ё→е, срезанный хвост-счётчик непрочитанных, нижний регистр. Иначе «Проблемные»,
  // «Проблемные » и «Проблемные 3» считались РАЗНЫМИ метками и попадали в список
  // дублями (баг: «подтягиваются двойные метки»).
  function normLabelKey(s) {
    return String(s || '')
      .replace(/ /g, ' ')
      .replace(/\s*\d+\s*$/, '')   // счётчик непрочитанных в конце
      .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function collectLabelTexts(scope) {
    const labelTexts = [];
    const seen = new Set();

    for (const selector of LABEL_SELECTORS) {
      try {
        scope.querySelectorAll(selector).forEach(el => {
          // Берём только «листовые» плашки: если внутри есть ещё элемент-метка, это
          // контейнер — его innerText склеит несколько меток в одну строку. Тогда
          // пропускаем контейнер, а вложенную метку подхватим отдельно.
          try { if (el.querySelector(LABEL_SELECTORS.join(','))) return; } catch (e) { /* selector ok below */ }
          const raw = el.innerText && el.innerText.trim();
          if (!raw || raw.length === 0 || raw.length >= 40) return;
          // Отображаем метку без хвоста-счётчика, но сравниваем по нормализованному ключу.
          const text = raw.replace(/ /g, ' ').replace(/\s*\d+\s*$/, '').replace(/\s+/g, ' ').trim();
          if (!text) return;
          const key = normLabelKey(text);
          if (key && !seen.has(key)) {
            seen.add(key);
            labelTexts.push(text);
          }
        });
      } catch (e) {
        console.warn(`⚠️ Ошибка селектора метки ${selector}:`, e.message);
      }
    }

    return labelTexts;
  }

  // Поднимаемся от темы письма вверх по DOM, пока не найдём предка, который
  // действительно содержит внутри себя элементы-метки — так надёжнее, чем угадывать
  // имя класса контейнера (у Яндекса метки и тема физически лежат в разных ветках DOM).
  function findLabelScope(subjectEl) {
    if (!subjectEl) return document;
    let node = subjectEl.parentElement;
    let steps = 0;
    while (node && node !== document.body && steps < 15) {
      if (collectLabelTexts(node).length > 0) {
        return node;
      }
      node = node.parentElement;
      steps++;
    }
    return document;
  }

  function getEmailLabels(subjectEl) {
    // Ограничиваем поиск ближайшим предком, который реально содержит метки, чтобы не
    // подхватить метки других писем из списка слева. Не нашли — ищем по всей странице.
    const scope = findLabelScope(subjectEl);

    const labelTexts = collectLabelTexts(scope);
    dlog('🏷️ Найденные метки письма:', labelTexts);
    return labelTexts;
  }

  // Ищет метки по всей странице (список писем целиком), а не только у одного письма —
  // используется настройками для подбора реальных названий меток в словарь складов.
  function getAllLabelsOnPage() {
    const labelTexts = collectLabelTexts(document);
    dlog('🏷️ Все метки на странице:', labelTexts);
    return labelTexts;
  }

  // Пытается вытащить номер ЗП/Перемещения из текста: сначала структурный номер
  // вида 0000-0342359, затем число после слов "ЗП"/"перемещение".
  function extractOrderNumber(text) {
    if (!text) return '';
    const s = String(text);
    const ord = s.match(/\d{3,}[-–]\d{3,}/);
    if (ord) return ord[0].replace(/–/g, '-');
    const kw = s.match(/(?:зп|перемещени\w*)\s*№?\s*([0-9][0-9-]{3,}[0-9])/i);
    if (kw) return kw[1];
    return '';
  }

  // Текст открытого письма (только область просмотра, не список слева).
  function getMessageBodyText() {
    const bodyEl =
      document.querySelector('[class*="MessageBody"]') ||
      document.querySelector('[class*="MessageViewer"]') ||
      document.querySelector('.mail-Message-Body') ||
      document.querySelector('.mail-Message');
    return bodyEl ? (bodyEl.innerText || '') : '';
  }

  // id открытого письма (и по возможности всей его ветки). Записывается в колонку
  // «ID письма» — по нему потом однозначно находится ИМЕННО эта переписка, даже если
  // тем-двойников в таблице несколько. При перетаскивании id снимаются со строк
  // списка, здесь — с адреса и с разметки открытого письма.
  function getOpenMailIds() {
    const out = [];
    const seen = new Set();
    function add(v) {
      const raw = String(v == null ? '' : v).trim();
      if (!raw || seen.has(raw)) return;
      if (!/^t?\d{8,}$/.test(raw)) return;   // id письма — длинное число
      seen.add(raw);
      out.push(raw);
    }
    // 1) из адреса: #/message/<id> или #/thread/<id>
    try {
      const m = String(location.hash || '').match(/#\/(?:message|thread)\/(t?\d+)/);
      if (m) add(m[1]);
    } catch (e) { /* ignore */ }
    // 2) из разметки области чтения — там письма раскрытой ветки
    const ATTRS = ['data-mid', 'data-id', 'data-message-id', 'data-thread-id'];
    const SCOPES = ['[class*="MessageViewer"]', '[class*="Message__root"]', '.mail-Message'];
    for (const sel of SCOPES) {
      let scope = null;
      try { scope = document.querySelector(sel); } catch (e) { continue; }
      if (!scope) continue;
      try {
        scope.querySelectorAll('[' + ATTRS.join('],[') + ']').forEach(function (el) {
          ATTRS.forEach(function (a) {
            const v = String(el.getAttribute(a) || '');
            add(v);
            const inner = v.match(/(?:^|[^0-9a-z])(t?\d{8,})(?:[^0-9]|$)/i);
            if (inner) add(inner[1]);
          });
        });
      } catch (e) { /* ignore */ }
      if (out.length) break;
    }
    return out;
  }

  function getEmailData() {
    dlog("🔍 Начинаем поиск данных письма...");

    let subject = '';
    let subjectEl = null;
    let date = new Date().toISOString().split('T')[0];

    // === ПОИСК ТЕМЫ ===
    // Порядок важен: сначала data-testid (стабильнее — используется QA-автотестами
    // Яндекса и переживает редизайны), затем частичное совпадение класса (переживает
    // смену хэш-суффикса), и только потом точные хэш-классы и селекторы старой верстки.
    const knownSelectors = [
      '[data-testid="message-subject"]',
      '[class*="Title__subject"]',
      '.Title__subject--naoFv',
      '.Text_typography_subheader-m.Title__subject--naoFv',
      '.mail-Message-Toolbar-Subject',
      '.mail-Message-Header h1',
      '.mail-Message-Header-Title',
      '.message__subject'
    ];

    for (let selector of knownSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          let text = extractSubjectText(el);
          text = text.replace(/^Re\s*[:：]\s*/, '').trim();
          text = text.replace(/\s+\d{1,2}$/, '').trim();
          text = text.replace(/([^\d\s-])\d{1,2}$/, '$1').trim();

          if (text.length > 2) {
            subject = text;
            subjectEl = el;
            dlog(`✅ Тема найдена через селектор: ${selector} → "${subject}"`);
            break;
          }
        }
      } catch (e) {
        console.warn(`⚠️ Ошибка селектора ${selector}:`, e.message);
      }
    }

    // === ПОИСК ДАТЫ ===
    const dateSelectors = [
      '[data-testid="message-viewer_header-date-link"]',
      '[data-testid="message-date"]',
      '.Header__dateLink--TcuKu',
      '.qa-MessageViewer-Header-dateLink',
      '.mail-Message-Toolbar-Date',
      '.mail-Message-Header-Date',
      '.message__date'
    ];

    let dateText = '';
    for (let selector of dateSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el && el.innerText.trim()) {
          dateText = el.innerText.trim();
          dlog(`✅ Дата найдена через селектор: ${selector} → "${dateText}"`);
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Ошибка селектора даты ${selector}:`, e.message);
      }
    }

    // Если не нашли дату через селекторы, ищем по тексту страницы
    if (!dateText) {
      dlog("🔍 Ищем дату по тексту страницы...");
      const bodyText = document.body.innerText;
      const datePattern = /(\d{1,2})\s+(янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i;
      const match = bodyText.match(datePattern);
      if (match) {
        dateText = match[0];
        dlog(`✅ Дата найдена в тексте: "${dateText}"`);
      }
    }

    // === ПАРСИНГ ДАТЫ ===
    if (dateText) {
      dlog(`🔍 Парсим дату: "${dateText}"`);
      const parsed = parseRussianDateImproved(dateText);
      if (parsed) {
        date = parsed;
        dlog(`📅 Успешно распарсено: ${date}`);
      } else {
        console.warn(`⚠️ Не удалось распарсить дату: "${dateText}"`);
      }
    }

    // Если тема не найдена
    // «Re:»/«Fwd:» — пометка почты, а не часть темы. Одна и та же переписка иначе
    // попадала бы в таблицу под разными темами (из ветки — без пометки, из письма —
    // с ней), а поиск по такой теме терял часть писем.
    subject = (function (raw) {
      const head = /^\s*(re|fw|fwd|ре|отв|ответ|пересылка)\s*(\[\d+\])?\s*:\s*/i;
      const tail = /\s*(re|fw|fwd|ре|отв|ответ)\s*(\[\d+\])?\s*:\s*$/i;
      let out = String(raw || '').trim();
      let changed = true;
      while (changed) {
        changed = false;
        const a = out.replace(head, '');
        if (a !== out) { out = a.trim(); changed = true; }
        const b = out.replace(tail, '');
        if (b !== out) { out = b.trim(); changed = true; }
      }
      return out || String(raw || '').trim();   // тема была целиком из пометок
    })(subject);

    if (!subject) {
      subject = '⚠️ Тема не найдена, введите вручную';
      console.warn('⚠️ Не удалось найти тему письма');
    }

    // === ПОИСК МЕТОК ===
    const labels = getEmailLabels(subjectEl);

    // === НОМЕР ЗП/ПЕРЕМЕЩЕНИЯ ===
    // Сначала из темы (надёжнее), затем из тела письма. Подставляется в поле как
    // подсказка — пользователь всегда может поправить.
    let number = extractOrderNumber(subject);
    if (!number) {
      number = extractOrderNumber(getMessageBodyText());
    }

    dlog(`📨 Итог: Тема="${subject}", Дата="${date}", Номер="${number}", Метки=${JSON.stringify(labels)}`);
    const mailIds = getOpenMailIds();
    // Время письма — единственный опознавательный знак, одинаковый во ВСЕХ почтовых
    // ящиках: id письма у каждого сотрудника свои. Кладём его в ту же колонку меткой
    // ts:<миллисекунды>, чтобы сменщица в своей почте нашла ту же переписку.
    let mailTs = 0;
    try {
        const hm = String(dateText || '').match(/(\d{1,2}):(\d{2})/);
        const parts = String(date || '').split('-');
        if (parts.length === 3) {
            const d = new Date(
                Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]),
                hm ? Number(hm[1]) : 0, hm ? Number(hm[2]) : 0, 0, 0
            );
            if (!isNaN(d)) mailTs = d.getTime();
        }
    } catch (e) { /* без времени — останутся только id */ }
    const mailIdParts = mailIds.slice();
    if (mailTs) mailIdParts.push('ts:' + mailTs);
    dlog('🆔 id открытого письма:', mailIdParts);
    // Начало текста письма — вторая примета переписки помимо темы. Нужна там, где
    // темы не хватает: письмо «(Без темы)» или несколько разных переписок с
    // одинаковой темой от одного поставщика.
    const preview = String(getMessageBodyText() || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return { subject, date, labels, number, mailId: mailIdParts.join(','), preview: preview };
  }

  // ============================================
  // СЛУШАЕМ СООБЩЕНИЯ ИЗ POPUP
  // ============================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) return; // pm-* сообщения — не наши

    dlog("📨 Получен запрос из popup:", request);

    if (request.action === "getEmailData") {
      const data = getEmailData();
      sendResponse(data);
    }

    if (request.action === "debugPage") {
      debugSelectors();
      sendResponse({ status: "debug done" });
    }

    if (request.action === "getAllLabels") {
      const labels = getAllLabelsOnPage();
      sendResponse({ labels });
    }

    return true;
  });

  dlog('✅ content-capture.js готов к работе');
})();
