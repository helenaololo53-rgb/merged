// Единая логика темы для страниц расширения (попап и настройки).
// Значение темы хранится в chrome.storage.local под ключом 'pm_theme':
//   'auto'  — следуем системной теме (data-theme не выставляется, работает @media);
//   'light' / 'dark' — ручной выбор пользователя (ставим data-theme на <html>).
// Тот же ключ читает панель внутри почты (content-panel.js), поэтому тема общая.
(function () {
    const THEME_KEY = 'pm_theme';
    const root = document.documentElement;
    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    let pref = 'auto';

    // Кнопка-переключатель на разных страницах имеет разный id — ищем любой.
    function themeBtn() {
        return document.getElementById('themeToggle') || document.getElementById('theme');
    }

    function systemDark() { return !!(mql && mql.matches); }
    function effectiveDark() {
        if (pref === 'dark') return true;
        if (pref === 'light') return false;
        return systemDark();
    }

    function apply() {
        if (pref === 'light' || pref === 'dark') {
            root.setAttribute('data-theme', pref);
        } else {
            root.removeAttribute('data-theme');
        }
        const btn = themeBtn();
        if (btn) {
            const dark = effectiveDark();
            btn.textContent = dark ? '☀️' : '🌙';
            btn.title = dark ? 'Светлая тема' : 'Тёмная тема';
        }
    }

    function save() {
        try { chrome.storage.local.set({ [THEME_KEY]: pref }); } catch (e) { /* не критично */ }
    }

    // Первичная загрузка сохранённого выбора.
    try {
        chrome.storage.local.get(THEME_KEY, function (r) {
            const v = r && r[THEME_KEY];
            if (v === 'light' || v === 'dark' || v === 'auto') pref = v;
            apply();
        });
    } catch (e) {
        apply();
    }

    // Системная тема сменилась и мы в авто-режиме — обновляем иконку.
    if (mql) {
        const onChange = function () { if (pref === 'auto') apply(); };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
    }

    // Синхронизация между окнами (панель/попап/настройки).
    try {
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area === 'local' && changes[THEME_KEY]) {
                const v = changes[THEME_KEY].newValue;
                if (v === 'light' || v === 'dark' || v === 'auto') { pref = v; apply(); }
            }
        });
    } catch (e) { /* ignore */ }

    // Кнопка-переключатель: задаёт явную тему, противоположную текущей.
    document.addEventListener('DOMContentLoaded', function () {
        const btn = themeBtn();
        if (!btn) return;
        apply();
        btn.addEventListener('click', function () {
            pref = effectiveDark() ? 'light' : 'dark';
            apply();
            save();
        });
    });
})();
