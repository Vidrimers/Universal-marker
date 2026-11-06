// ==UserScript==
// @name         Universal Marker
// @namespace    https://github.com/Vidrimers/Universal-marker
// @version      6.8.0
// @description  Universal nickname highlighting + profile messages. Works on any site.
// @author       Vidrimers
// @license      CC BY-NC-ND 4.0
// @homepageURL  https://github.com/Vidrimers/Universal-marker
// @supportURL   https://github.com/Vidrimers/Universal-marker/issues
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // ========== КОНСТАНТЫ ==========
  const DOMAIN = location.hostname.replace(/^www\./, "");
  const STORAGE_KEY = `vm_${DOMAIN}`;
  const MARKER_ATTR = "data-vm-marked";
  const STEAM_PROXY = "http://89.124.70.156:3000/api/steam/names";
  const STEAM_NICK_CACHE_KEY = "vm_steam_nick_cache";
  const STEAM_NICK_CACHE_TTL = 24 * 60 * 60 * 1000; // сутки
  const LANG_PREF_KEY = "lang_pref"; // глобальный язык интерфейса (без vm_ — в экспорт не попадает)

  // ========== ХРАНИЛИЩЕ ==========
  function loadData() {
    const raw = GM_getValue(STORAGE_KEY, null);
    const def = {
      nicknames: {},
      profileMessages: {},
      settings: {
        nickColor: "#ff4444",
        nickBold: true,
        centerColor: "#ff4444",
        centerBg: "rgba(10,10,10,0.92)",
        centerSize: "42px",
        centerBorder: "#ff4444",
        showForever: true,
        autoHideSeconds: 5,
        userIdPatterns: ["[?&]u=(\\d+)", "/profile/(\\d+)", "/member/(\\d+)"],
        winPos: null,
        fabPos: null,
        uiOpen: false,
        lang: GM_getValue(LANG_PREF_KEY, "en"),
      }
    };
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    // Миграция: если значение ника — строка, конвертируем в объект
    for (const [k, v] of Object.entries(parsed.nicknames || {})) {
      if (typeof v === "string") {
        parsed.nicknames[k] = { label: v, color: null, note: "" };
      }
    }
    return parsed;
  }

  // Получить объект ника (с fallback для старых данных)
  function getNickData(nick) {
    const v = Object.entries(DATA.nicknames).find(([k]) => k === nick)?.[1];
    if (v === undefined) return null;
    return typeof v === "string" ? { label: v, color: null, note: "" } : v;
  }

  function saveData(data) {
    GM_setValue(STORAGE_KEY, JSON.stringify(data));
  }

  let DATA = loadData();

  // ========== ОПРЕДЕЛЕНИЕ ID ПРОФИЛЯ ==========
  // Берём ПОСЛЕДНЮЮ capture-группу — это позволяет паттернам типа
  // /seller/([^/]+)/(\d+) правильно извлекать числовой ID из конца URL

  function getUserIdFromUrl() {
    const url = location.href;
    const patterns = DATA.settings.userIdPatterns || ["[?&]u=(\\d+)"];
    for (const pat of patterns) {
      try {
        const re = new RegExp(pat);
        const m = url.match(re);
        if (m && m.length >= 2) {
          // Берём последнюю непустую группу
          for (let i = m.length - 1; i >= 1; i--) {
            if (m[i]) return m[i];
          }
        }
      } catch (e) {}
    }
    return null;
  }

  // ========== ЦЕНТРИРОВАННАЯ НАДПИСЬ ==========

  function showCenterMessage(text) {
    const s = DATA.settings;
    const overlay = document.createElement("div");
    overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483647;
            pointer-events: none; display: flex;
            align-items: center; justify-content: center;
        `;
    const msg = document.createElement("div");
    msg.textContent = text;
    msg.style.cssText = `
            font-weight: 800;
            text-align: center;
            text-transform: uppercase;
            padding: 24px 48px;
            border-radius: 16px;
            box-shadow: 0 0 60px rgba(0,0,0,0.5);
            animation: vm-pulse 2s ease-in-out infinite;
            color: ${s.centerColor};
            font-size: ${s.centerSize};
            background: ${s.centerBg};
            border: 3px solid ${s.centerBorder};
        `;
    overlay.appendChild(msg);
    document.body.appendChild(overlay);
    if (!s.showForever) {
      setTimeout(() => overlay.remove(), s.autoHideSeconds * 1000);
    }
  }

  // ========== ПОДСВЕТКА НИКОВ ==========

  const SKIP_TAGS = new Set([
    "TEXTAREA",
    "INPUT",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
  ]);

  function buildPattern() {
    const keys = Object.keys(DATA.nicknames);
    if (!keys.length) return null;
    const escaped = keys.map(
      (k) =>
        `(?<![\\p{L}\\p{N}_])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
    );
    return new RegExp(escaped.join("|"), "gu");
  }

  let pattern = buildPattern();

  // ── Мониторинг переименований Steam ──
  // Берём все ники у которых есть steamId64, запрашиваем актуальные имена через прокси,
  // обновляем базу если кто-то переименовался, перестраиваем паттерн.
  function syncSteamNicks(onDone) {
    if (!location.hostname.includes("steamcommunity.com")) {
      if (onDone) onDone();
      return;
    }

    // Собираем ники у которых есть steamId64
    const toSync = []; // [{nick, steamId64, data}]
    for (const [nick, v] of Object.entries(DATA.nicknames)) {
      const d = typeof v === "string" ? { label: v, color: null, note: "", steamId64: null } : v;
      if (d.steamId64) toSync.push({ nick, steamId64: d.steamId64, data: d });
    }

    if (!toSync.length) { if (onDone) onDone(); return; }

    // Проверяем кеш
    const now = Date.now();
    let cache = {};
    try { cache = JSON.parse(GM_getValue(STEAM_NICK_CACHE_KEY, "{}")); } catch (e) {}

    const ids = toSync.map(e => e.steamId64);
    const needFetch = ids.filter(id => !cache[id] || (now - cache[id].ts) > STEAM_NICK_CACHE_TTL);

    function applyUpdates(freshNames) {
      let changed = false;
      for (const entry of toSync) {
        const actualName = freshNames[entry.steamId64] || (cache[entry.steamId64] && cache[entry.steamId64].name);
        if (!actualName) continue;
        if (actualName !== entry.nick) {
          // Ник изменился — переносим запись
          const d = { ...entry.data, steamId64: entry.steamId64 };
          delete DATA.nicknames[entry.nick];
          DATA.nicknames[actualName] = d;
          changed = true;
          console.log(`[Marker] Ник обновлён: ${entry.nick} → ${actualName}`);
        }
      }
      if (changed) {
        saveData(DATA);
        pattern = buildPattern();
      }
      if (onDone) onDone();
    }

    if (!needFetch.length) {
      // Всё в кеше
      const names = {};
      for (const id of ids) if (cache[id]) names[id] = cache[id].name;
      applyUpdates(names);
      return;
    }

    // Запрашиваем свежие данные
    GM_xmlhttpRequest({
      method: "GET",
      url: STEAM_PROXY + "?ids=" + needFetch.join(","),
      timeout: 8000,
      onload(resp) {
        const names = {};
        try {
          const arr = JSON.parse(resp.responseText);
          for (const item of arr) {
            if (item.name) {
              names[item.steamid] = item.name;
              cache[item.steamid] = { name: item.name, ts: now };
            }
          }
          GM_setValue(STEAM_NICK_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {}
        // Добавляем из кеша то что не запрашивали
        for (const id of ids) if (cache[id] && !names[id]) names[id] = cache[id].name;
        applyUpdates(names);
      },
      onerror() { if (onDone) onDone(); },
      ontimeout() { if (onDone) onDone(); },
    });
  }

  function getLabelFor(nick) {
    const d = getNickData(nick);
    return d ? d.label : "";
  }

  function getColorFor(nick) {
    const d = getNickData(nick);
    return d && d.color ? d.color : DATA.settings.nickColor;
  }

  function processNode(node) {
    if (!pattern) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.hasAttribute(MARKER_ATTR) || SKIP_TAGS.has(node.tagName)) return;
      node.childNodes.forEach((ch) => processNode(ch));
      return;
    }
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    if (!text.trim()) return;

    const hasMatch = Object.keys(DATA.nicknames).some((k) =>
      text.includes(k),
    );
    if (!hasMatch) return;

    const parent = node.parentElement;
    if (
      !parent ||
      parent.hasAttribute(MARKER_ATTR) ||
      SKIP_TAGS.has(parent.tagName)
    )
      return;

    const parts = [];
    let lastIdx = 0;
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > lastIdx)
        parts.push({ t: "text", c: text.slice(lastIdx, m.index) });
      parts.push({ t: "nick", c: m[0], label: getLabelFor(m[0]) });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length)
      parts.push({ t: "text", c: text.slice(lastIdx) });
    if (parts.length <= 1 && parts[0]?.t === "text") return;

    const span = document.createElement("span");
    span.setAttribute(MARKER_ATTR, "1");
    for (const p of parts) {
      if (p.t === "text") {
        span.appendChild(document.createTextNode(p.c));
      } else {
        span.appendChild(document.createTextNode(p.c));
        const tag = document.createElement("span");
        tag.textContent = ` (${p.label})`;
        tag.style.color = getColorFor(p.c);
        if (DATA.settings.nickBold) tag.style.fontWeight = "bold";
        span.appendChild(tag);
      }
    }
    parent.replaceChild(span, node);
  }

  // ========== УТИЛИТЫ ==========

  function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(
      /[&<>"]/g,
      (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m],
    );
  }

  // ========== I18N ==========
  const I18N = {
    en: {
      "head.refresh": "Refresh",
      "head.report": "Bug report",
      "upd.update": "Update",
      "upd.install": "⬆️ Install",
      "upd.available": "🆕 Update available: v{a} → v{b}",
      "upd.check": "🔍 Check for updates",
      "upd.checking": "⏳ Checking...",
      "tab.nicks": "👤 Nicks",
      "tab.profiles": "💀 Profiles",
      "tab.settings": "⚙️ Settings",
      "tab.help": "? Help",
      "search.nicks": "Search by nick or label...",
      "search.profiles": "Search by ID or text...",
      "list.found": "Found: {a} of {b}",
      "list.total": "Total: {n}",
      "list.notFound": "Nothing found",
      "list.empty": "Empty",
      "ph.nick": "Nick",
      "ph.label": "Label",
      "ph.userId": "User ID",
      "ph.msgText": "Message text",
      "ph.id": "ID",
      "ph.text": "Text",
      "nick.colorTitle": "Label color (keep the default or pick your own)",
      "presets.btn": "▾ Quick labels",
      "presets.empty": "No saved labels",
      "bulk.toggle": "Bulk add",
      "bulk.labelPh": "Label for all nicks (required)",
      "bulk.nicksPh": "Nicks — one per line:&#10;Minor748&#10;ElSwanko&#10;suarog3&#10;...",
      "bulk.addBtn": "➕ Add all",
      "bulk.addedPart": "added {n}",
      "bulk.updatedPart": "⚠️ updated {n}",
      "title.color": "Label color",
      "title.colorShort": "Color",
      "steam.auto": "⚡ Steam page — data detected automatically",
      "steam.profilePh": "Profile label",
      "steam.addProfile": "➕ Profile",
      "steam.nickPh": "Label for the nick",
      "steam.addNick": "➕ Nick",
      "steam.currentNick": "Current nick: {nick}",
      "set.lang": "Language",
      "set.nickColor": "Nick label color",
      "set.centerColor": "Message color (center)",
      "set.border": "Border color",
      "set.fontSize": "Font size (center)",
      "set.showForever": "Show always",
      "set.patterns": "URL patterns for ID (one per line)",
      "set.version": "Script version:",
      "set.publicNote": "GitHub updates are not available in this build — the script updates automatically via your userscript manager",
      "set.exportImport": "Export / Import",
      "set.export": "📥 Export",
      "set.import": "📤 Import",
      "note.title": "Note",
      "note.add": "Add a note",
      "note.ph": "Note about the nick...",
      "help.title": "How to use",
      "help.nicksP": '<p><strong style="color:#a3b1ff;">👤 Nicks</strong> — nickname highlighting on the page. Add a nick and a label, and your text will appear next to every mention.</p>',
      "help.nicksExP": '<p class="vm-code">Example: <strong>beex</strong> → <strong>scammer</strong><br>Result: beex <span style="color:#ff4444;font-weight:bold;">(scammer)</span></p>',
      "help.profilesP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">💀 Profiles</strong> — big center message when opening a profile. Set an ID and the text.</p>',
      "help.profilesExP": '<p class="vm-code">Example: ID <strong>1179730</strong> → <strong>SCAMMER</strong><br>Opening /seller/beex/1179730 shows the message</p>',
      "help.patternsP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">⚙️ URL patterns</strong> — regex to extract the ID.<br>If the pattern has several groups — the last one is used.<br>For plati.market: <code style="background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;">/seller/[^/]+/(\\d+)</code></p>',
      "help.exportP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">📥📤 Export/Import</strong> — backup of all sites in one file.</p>',
      "help.storageP": '<p style="margin-top:8px;color:#666;font-size:11px;">Data is stored in Tampermonkey (GM_storage), it survives cookie clears.</p>',
      "donate": "Support the project",
      "ui.license": "License",
      "ui.ok": "OK",
      "lic.title": "License",
      "lic.free": "✅ Use for free",
      "lic.share": "✅ Share with attribution",
      "lic.commercial": "❌ Commercial use",
      "lic.derivatives": "❌ Modifications and derivatives",
      "lic.commercialNote": "For commercial use, contact the author to obtain a license.",
      "lic.full": "Full text",
      "toast.needProfileLabel": "Enter a profile label",
      "toast.profileUpdated": "Profile updated",
      "toast.profileAdded": "Profile added",
      "toast.profileAddedOk": "✓ Profile added",
      "toast.nickUnavailable": "Nick unavailable",
      "toast.needNickLabel": "Enter a label for the nick",
      "toast.labelUpdated": '⚠️ Label "{nick}" updated',
      "toast.nickAddedNamed": '✓ Nick "{nick}" added',
      "toast.nickAdded": "✓ Nick added",
      "toast.fillBoth": "Fill in both fields",
      "toast.saved": "✓ Changed",
      "toast.noteSaved": "✓ Note saved",
      "toast.noteDeleted": "✓ Note deleted",
      "toast.deleted": "Deleted",
      "toast.needBulkLabel": "Enter a label for the nicks",
      "toast.bulkEmpty": "Nick list is empty",
      "toast.bulkMax": "Max {n} nicks at once",
      "toast.settingsSaved": "✓ Settings saved",
      "toast.exportFile": "💾 Save the file ({n} sites)...",
      "toast.exportFile.one": "💾 Save the file ({n} site)...",
      "toast.imported": "✓ Imported {n} sites! Reload the page.",
      "toast.imported.one": "✓ Imported {n} site! Reload the page.",
      "toast.errorPrefix": "Error: ",
      "toast.upToDate": "✓ No updates, version is current",
      "bug.title": "[Bug] <short problem description>",
      "bug.version": "**Script version:** ",
      "bug.browser": "**Browser:** ",
      "bug.steps": "**Steps to reproduce:**",
      "bug.expected": "**Expected behavior:**",
      "bug.actual": "**Actual behavior:**",
      "bug.extra": "**Additional:**"
    },
    ru: {
      "head.refresh": "Обновить",
      "head.report": "Багрепорт",
      "upd.update": "Обновить",
      "upd.install": "⬆️ Установить",
      "upd.available": "🆕 Доступно обновление: v{a} → v{b}",
      "upd.check": "🔍 Проверить обновления",
      "upd.checking": "⏳ Проверяем...",
      "tab.nicks": "👤 Ники",
      "tab.profiles": "💀 Профили",
      "tab.settings": "⚙️ Настройки",
      "tab.help": "? Помощь",
      "search.nicks": "Поиск по нику или метке...",
      "search.profiles": "Поиск по ID или тексту...",
      "list.found": "Найдено: {a} из {b}",
      "list.total": "Всего: {n}",
      "list.notFound": "Ничего не найдено",
      "list.empty": "Пусто",
      "ph.nick": "Ник",
      "ph.label": "Метка",
      "ph.userId": "ID пользователя",
      "ph.msgText": "Текст надписи",
      "ph.id": "ID",
      "ph.text": "Текст",
      "nick.colorTitle": "Цвет метки (оставь дефолтный или выбери свой)",
      "presets.btn": "▾ Быстрые метки",
      "presets.empty": "Нет сохранённых меток",
      "bulk.toggle": "Массовое добавление",
      "bulk.labelPh": "Метка для всех ников (обязательно)",
      "bulk.nicksPh": "Ники — по одному на строку:&#10;Minor748&#10;ElSwanko&#10;suarog3&#10;...",
      "bulk.addBtn": "➕ Добавить всех",
      "bulk.addedPart": "добавлено {n}",
      "bulk.updatedPart": "⚠️ обновлено {n}",
      "title.color": "Цвет метки",
      "title.colorShort": "Цвет",
      "steam.auto": "⚡ Страница Steam — данные определены автоматически",
      "steam.profilePh": "Метка для профиля",
      "steam.addProfile": "➕ Профиль",
      "steam.nickPh": "Метка для ника",
      "steam.addNick": "➕ Ник",
      "steam.currentNick": "Текущий ник: {nick}",
      "set.lang": "Язык",
      "set.nickColor": "Цвет метки ника",
      "set.centerColor": "Цвет надписи (центр)",
      "set.border": "Цвет рамки",
      "set.fontSize": "Размер шрифта (центр)",
      "set.showForever": "Показывать всегда",
      "set.patterns": "Паттерны URL для ID (по одному на строку)",
      "set.version": "Версия скрипта:",
      "set.publicNote": "Обновления с GitHub в этой сборке недоступны — скрипт обновляется автоматически через менеджер пользовательских скриптов",
      "set.exportImport": "Экспорт / Импорт",
      "set.export": "📥 Экспорт",
      "set.import": "📤 Импорт",
      "note.title": "Заметка",
      "note.add": "Добавить заметку",
      "note.ph": "Заметка о нике...",
      "help.title": "Как пользоваться",
      "help.nicksP": '<p><strong style="color:#a3b1ff;">👤 Ники</strong> — подсветка ников на странице. Добавь ник и метку, и рядом с каждым упоминанием появится твой текст.</p>',
      "help.nicksExP": '<p class="vm-code">Пример: <strong>beex</strong> → <strong>scammer</strong><br>Результат: beex <span style="color:#ff4444;font-weight:bold;">(scammer)</span></p>',
      "help.profilesP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">💀 Профили</strong> — большая надпись по центру при заходе на профиль. Укажи ID и текст.</p>',
      "help.profilesExP": '<p class="vm-code">Пример: ID <strong>1179730</strong> → <strong>ЕБЛАН</strong><br>При открытии /seller/beex/1179730 появится надпись</p>',
      "help.patternsP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">⚙️ Паттерны URL</strong> — regex для извлечения ID.<br>Если в паттерне несколько групп — берётся последняя.<br>Для plati.market: <code style="background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;">/seller/[^/]+/(\\d+)</code></p>',
      "help.exportP": '<p style="margin-top:12px;"><strong style="color:#a3b1ff;">📥📤 Экспорт/Импорт</strong> — бэкап всех сайтов одним файлом.</p>',
      "help.storageP": '<p style="margin-top:8px;color:#666;font-size:11px;">Данные в Tampermonkey (GM_storage), не пропадут при очистке кук.</p>',
      "donate": "Поддержать проект",
      "ui.license": "Лицензия",
      "ui.ok": "ОК",
      "lic.title": "Лицензия",
      "lic.free": "✅ Использовать бесплатно",
      "lic.share": "✅ Делиться с указанием автора",
      "lic.commercial": "❌ Коммерческое использование",
      "lic.derivatives": "❌ Переделки и производные",
      "lic.commercialNote": "Для коммерческого использования свяжитесь с автором для получения лицензии.",
      "lic.full": "Полный текст",
      "toast.needProfileLabel": "Укажи метку для профиля",
      "toast.profileUpdated": "Профиль обновлён",
      "toast.profileAdded": "Профиль добавлен",
      "toast.profileAddedOk": "✓ Профиль добавлен",
      "toast.nickUnavailable": "Ник недоступен",
      "toast.needNickLabel": "Укажи метку для ника",
      "toast.labelUpdated": '⚠️ Метка "{nick}" обновлена',
      "toast.nickAddedNamed": '✓ Ник "{nick}" добавлен',
      "toast.nickAdded": "✓ Ник добавлен",
      "toast.fillBoth": "Заполните оба поля",
      "toast.saved": "✓ Изменено",
      "toast.noteSaved": "✓ Заметка сохранена",
      "toast.noteDeleted": "✓ Заметка удалена",
      "toast.deleted": "Удалено",
      "toast.needBulkLabel": "Укажите метку для ников",
      "toast.bulkEmpty": "Список ников пуст",
      "toast.bulkMax": "Максимум {n} ников за раз",
      "toast.settingsSaved": "✓ Настройки сохранены",
      "toast.exportFile": "💾 Сохраните файл ({n} сайтов)...",
      "toast.exportFile.one": "💾 Сохраните файл ({n} сайт)...",
      "toast.exportFile.few": "💾 Сохраните файл ({n} сайта)...",
      "toast.imported": "✓ Импортировано {n} сайтов! Обновите страницу.",
      "toast.imported.one": "✓ Импортировано {n} сайт! Обновите страницу.",
      "toast.imported.few": "✓ Импортировано {n} сайта! Обновите страницу.",
      "toast.errorPrefix": "Ошибка: ",
      "toast.upToDate": "✓ Обновлений нет, версия актуальна",
      "bug.title": "[BUG] <краткое описание проблемы>",
      "bug.version": "**Версия скрипта:** ",
      "bug.browser": "**Браузер:** ",
      "bug.steps": "**Шаги воспроизведения:**",
      "bug.expected": "**Ожидаемое поведение:**",
      "bug.actual": "**Фактическое поведение:**",
      "bug.extra": "**Дополнительно:**"
    }
  };

  function uiLang() {
    const l = (DATA.settings && DATA.settings.lang) || GM_getValue(LANG_PREF_KEY, "en");
    return l === "ru" ? "ru" : "en";
  }

  // Смена языка действует на все сайты сразу (данные хранятся раздельно по vm_<домен>)
  function applyLangToAllSites(lang) {
    for (const key of GM_listValues()) {
      if (!key.startsWith("vm_") || key === STORAGE_KEY) continue;
      let parsed;
      try {
        parsed = JSON.parse(GM_getValue(key, "null"));
      } catch (e) {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || !parsed.settings) continue;
      parsed.settings.lang = lang;
      GM_setValue(key, JSON.stringify(parsed));
    }
  }

  function pluralCat(lang, n) {
    if (lang === "ru") {
      if (n % 10 === 1 && n % 100 !== 11) return "one";
      if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return "few";
      return "many";
    }
    return n === 1 ? "one" : "other";
  }

  function t(key, params) {
    const lang = uiLang();
    let s = I18N[lang] && I18N[lang][key] != null ? I18N[lang][key] : I18N.en[key] != null ? I18N.en[key] : key;
    const n = params && (params.count != null ? params.count : params.n);
    if (n != null) {
      const alt = I18N[lang] && I18N[lang][key + "." + pluralCat(lang, n)];
      if (alt != null) s = alt;
      s = s.split("{n}").join(String(n));
    }
    if (params) {
      for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
    }
    return s;
  }

  // ========== UI REBUILD (смена языка пересобирает панель) ==========
  let uiHost = null;
  let uiFabObserver = null;
  let uiResizeHandler = null;

  function rebuildUI() {
    if (uiFabObserver) { uiFabObserver.disconnect(); uiFabObserver = null; }
    if (uiResizeHandler) { window.removeEventListener("resize", uiResizeHandler); uiResizeHandler = null; }
    if (uiHost) { uiHost.remove(); uiHost = null; }
    const staleAnchor = document.querySelector(".vm-fab-anchor");
    if (staleAnchor) staleAnchor.remove();
    createUI();
  }

  // ========== SHADOW DOM UI ==========
  // Вся модалка живёт внутри Shadow DOM — CSS сайта не может туда пролезть

  function createUI() {
    // Контейнер для Shadow DOM — вешаем на <html>, чтобы SPA-страницы
    // не удаляли наш хост при замене body.
    const host = document.createElement("div");
    host.setAttribute(MARKER_ATTR, "1");
    host.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    document.documentElement.appendChild(host);
    uiHost = host;

    const shadow = host.attachShadow({ mode: "open" });

    // Все стили внутри Shadow DOM — изолированы полностью
    const style = document.createElement("style");
    style.textContent = `
            *, *::before, *::after { box-sizing: border-box; }

            /* ===== Toast ===== */
            .vm-toast {
                position: fixed;
                bottom: 80px;
                left: 50%;
                transform: translateX(-50%) translateY(20px);
                background: linear-gradient(135deg, #1e1e2e, #2a2a3e);
                color: #fff;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                padding: 12px 24px;
                font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                z-index: 2147483647;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                opacity: 0;
                transition: opacity 0.3s, transform 0.3s;
                backdrop-filter: blur(10px);
                max-width: 340px;
                text-align: center;
                pointer-events: none;
            }
            .vm-toast.show {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
            .vm-toast.error { border-color: #ff4444; }

            /* ===== FAB Button ===== */
            .vm-fab {
                position: fixed;
                bottom: 24px;
                left: 24px;
                width: 30px;
                height: 20px;
                border-radius: 12px;
                background: linear-gradient(135deg, rgba(255,65,108,0.2), rgba(255,75,43,0.5));
                border: none;
                color: white;
                font-size: 14px;
                cursor: pointer;
                z-index: 2147483646;
                box-shadow: 0 4px 24px rgba(255,65,108,0.4);
                transition: transform 0.25s cubic-bezier(.4,2,.6,1), box-shadow 0.3s;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                animation: vm-fab-pulse 3s ease-in-out infinite;
                pointer-events: auto;
            }
            .vm-fab:hover {
                transform: scale(1.12) rotate(-5deg);
                box-shadow: 0 8px 32px rgba(255,65,108,0.6), 0 0 0 6px rgba(255,65,108,0.15);
            }
            .vm-fab:active { transform: scale(0.95); }

            @keyframes vm-fab-pulse {
                0%, 100% { box-shadow: 0 4px 24px rgba(255,65,108,0.4), 0 0 0 0 rgba(255,65,108,0); }
                50% { box-shadow: 0 4px 24px rgba(255,65,108,0.4), 0 0 0 8px rgba(255,65,108,0.08); }
            }

            /* ===== Overlay ===== (визуальный, не блокирующий) */
            .vm-overlay {
                display: none; /* оверлей полностью отключён — модалка не блокирует сайт */
            }

            /* ===== Modal ===== */
            .vm-modal {
                position: fixed;
                left: 0;
                top: 0;
                transform: scale(0.95);
                pointer-events: auto;
                width: 460px;
                max-height: 75vh;
                overflow-y: auto;
                background: linear-gradient(160deg, #1a1a2e, #16213e);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 20px;
                padding: 0 10px 15px;
                z-index: 2147483645;
                color: #e0e0e0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 14px;
                line-height: 1.4;
                box-shadow: 0 24px 80px rgba(0,0,0,0.6);
                opacity: 0;
                transition: opacity 0.3s, transform 0.3s;
                display: none;
            }
            .vm-modal.open {
                display: block;
                opacity: 1;
                transform: scale(1);
            }

            /* ===== Header (шапка-тайтлбар: drag + липкая) ===== */
            .vm-header {
                position: sticky;
                top: 0;
                z-index: 2;
                padding: 5px 28px 0px;
                cursor: move;
                user-select: none;
            }
            .vm-modal h2 {
                margin: 0 0 20px;
                font-size: 15px;
                font-weight: 700;
                color: #fff;
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 10px;
                cursor: move;
                user-select: none;
            }
            .vm-domain {
                font-size: 12px;
                background: rgba(102,126,234,0.2);
                color: #a3b1ff;
                padding: 3px 10px;
                border-radius: 20px;
                font-weight: 500;
            }

            /* ===== Tabs ===== */
            .vm-tabs {
                display: flex;
                flex-direction: row;
                gap: 4px;
                margin-bottom: 20px;
                background: rgba(0,0,0,0.3);
                border-radius: 10px;
                padding: 4px;
            }
            .vm-tab {
                flex: 1;
                padding: 5px;
                border: none;
                background: transparent;
                color: #888;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                border-radius: 8px;
                transition: all 0.2s;
            }
            .vm-tab.active {
                background: rgba(102,126,234,0.2);
                color: #a3b1ff;
            }
            .vm-tab:hover:not(.active) { color: #ccc; }

            /* ===== Tab Content ===== */
            .vm-tab-content { display: none; }
            .vm-tab-content.active {
                display: flex;
                flex-direction: column;
            }

            /* ===== Inputs & Buttons ===== */
            .vm-input {
                width: 100%;
                padding: 10px 14px;
                background: rgba(0,0,0,0.4);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 8px;
                color: #fff;
                font-size: 13px;
                outline: none;
                transition: border-color 0.2s;
                font-family: inherit;
            }
            .vm-input:focus { border-color: rgba(102,126,234,0.5); }
            .vm-input::placeholder { color: #555; }
            select.vm-input { padding: 6px 10px; width: auto; cursor: pointer; }
            select.vm-input option { background: #16213e; color: #fff; }

            .vm-btn {
                padding: 10px 18px;
                border: none;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: inherit;
                white-space: nowrap;
            }
            .vm-btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
            .vm-btn-primary:hover { opacity: 0.85; transform: translateY(-1px); }
            .vm-btn-success { background: #2ecc71; color: white; }
            .vm-btn-warning { background: #f39c12; color: white; }
            .vm-btn-danger { background: #e74c3c; color: white; }
            .vm-btn-report { background: #f312da;; color: white; }
            .vm-btn-ghost {
                background: rgba(255,255,255,0.05);
                color: #aaa;
                border: 1px solid rgba(255,255,255,0.1);
            }
            .vm-btn-ghost:hover { background: rgba(255,255,255,0.1); color: #fff; }
            .vm-bulk-section>.vm-btn { padding: 5px; }

            /* ===== List Items ===== */
            .vm-list {
                max-height: 200px;
                overflow-y: auto;
                margin-bottom: 12px;
                padding: 4px;
                background: rgba(0,0,0,0.2);
                border-radius: 10px;
            }
            .vm-list::-webkit-scrollbar { width: 6px; }
            .vm-list::-webkit-scrollbar-track { background: transparent; }
            .vm-list::-webkit-scrollbar-thumb {
                background: rgba(102,126,234,0.3);
                border-radius: 3px;
            }
            .vm-list-item {
                display: flex;
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                border-radius: 8px;
                margin-bottom: 4px;
                background: rgba(255,255,255,0.03);
                transition: background 0.2s;
            }
            .vm-list-item:hover { background: rgba(255,255,255,0.06); }
            .vm-list-item-text {
                font-size: 13px;
                word-break: break-all;
                flex: 1;
            }
            .vm-list-item-text strong { color: #a3b1ff; }
            .vm-arrow { color: #555; margin: 0 6px; }

            .vm-delete-btn, .vm-edit-btn {
                border: none;
                width: 28px;
                height: 28px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
            }
            .vm-delete-btn { background: rgba(231,76,60,0.15); color: #e74c3c; }
            .vm-delete-btn:hover { background: rgba(231,76,60,0.3); }
            .vm-edit-btn { background: rgba(102,126,234,0.15); color: #667eea; }
            .vm-edit-btn:hover { background: rgba(102,126,234,0.3); }
            .vm-item-actions { display: flex; flex-direction: row; gap: 4px; flex-shrink: 0; }

            .vm-edit-row {
                display: flex;
                flex-direction: row;
                gap: 6px;
                padding: 8px 12px;
                border-radius: 8px;
                margin-bottom: 4px;
                background: rgba(102,126,234,0.08);
                border: 1px solid rgba(102,126,234,0.2);
            }
            .vm-edit-row .vm-input { flex: 1; padding: 6px 10px; font-size: 12px; }
            .vm-edit-row .vm-btn { padding: 6px 10px; font-size: 12px; }

            /* ===== Add Row ===== */
            .vm-add-row {
                display: flex;
                flex-direction: row;
                gap: 8px;
                margin-top: 8px;
            }
            .vm-add-row .vm-input { flex: 1; }

            /* ===== Settings ===== */
            .vm-setting-row {
                display: flex;
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                padding: 10px 0;
                border-bottom: 1px solid rgba(255,255,255,0.05);
            }
            .vm-setting-label { font-size: 13px; color: #aaa; flex: 1; }
            .vm-color-input {
                width: 40px; height: 30px;
                border: none; border-radius: 6px;
                cursor: pointer; background: none;
                flex-shrink: 0;
            }

            /* ===== Close btn ===== */
            .vm-head-actions {
                position: absolute;
                top: 5px;
                right: 10px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .vm-head-btn {
                background: none;
                border: none;
                color: #666;
                font-size: 16px;
                cursor: pointer;
                transition: color 0.2s;
                line-height: 1;
                padding: 0;
            }
            .vm-head-btn:hover { color: #fff; }
            .vm-close {
                background: none;
                border: none;
                color: #666;
                font-size: 24px;
                cursor: pointer;
                transition: color 0.2s;
                line-height: 1;
                padding: 0;
            }
            .vm-close:hover { color: #fff; }

            /* ===== Footer buttons ===== */
            .vm-footer {
                display: flex;
                flex-direction: row;
                gap: 8px;
                margin-top: 20px;
                flex-wrap: wrap;
            }
            .vm-footer .vm-btn { flex: 1; min-width: 120px; text-align: center; padding: 3px 5px;}

            .vm-donate-link {
                color: #888;
                font-size: 12px;
                text-decoration: none;
                transition: color 0.2s;
            }
            .vm-donate-link:hover {
                color: #ccc;
                text-decoration: underline;
            }

            /* ===== Help ===== */
            .vm-help { font-size: 13px; line-height: 1.7; color: #ccc; }
            .vm-help h3 { color: #fff; margin: 0 0 12px; font-size: 15px; }
            .vm-help p { margin: 0 0 8px; }
            .vm-help ul { padding-left: 18px; margin: 6px 0; }
            .vm-help li { margin-bottom: 4px; }
            .vm-help .vm-code {
                background: rgba(0,0,0,0.3);
                padding: 8px 12px;
                border-radius: 8px;
                font-family: monospace;
                font-size: 12px;
            }
            /* ===== Bulk Add ===== */
            .vm-bulk-toggle {
                margin-top: 10px;
                font-size: 12px;
                color: #667eea;
                background: none;
                border: none;
                cursor: pointer;
                padding: 4px 0;
                text-decoration: underline;
                text-decoration-style: dotted;
                font-family: inherit;
                text-align: center;
            }
            .vm-bulk-toggle:hover { color: #a3b1ff; }
            .vm-bulk-section {
                display: none;
                flex-direction: column;
                gap: 8px;
                margin-top: 10px;
                padding: 14px;
                background: rgba(102,126,234,0.06);
                border: 1px solid rgba(102,126,234,0.2);
                border-radius: 10px;
            }
            .vm-bulk-section.open { display: flex; }
            .vm-bulk-section textarea.vm-input {
                resize: vertical;
                min-height: 100px;
                font-family: monospace;
                font-size: 12px;
                line-height: 1.6;
            }
            
            .vm-bulk-counter {
                font-size: 11px;
                color: #666;
                text-align: right;
                margin-top: -4px;
            }
            .vm-bulk-counter.warn { color: #f39c12; }
            .vm-bulk-counter.limit { color: #e74c3c; }
            .vm-bulk-row {
                display: flex;
                flex-direction: row;
                gap: 8px;
                align-items: center;
            }
            .vm-bulk-row .vm-input { flex: 1; }

            /* ===== Nick color swatch in list ===== */
            .vm-nick-color-dot {
                display: inline-block;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                margin-right: 6px;
                flex-shrink: 0;
                border: 1px solid rgba(255,255,255,0.15);
                vertical-align: middle;
            }
            /* ===== Note dot ===== */
            .vm-note-dot {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: rgba(102,126,234,0.25);
                color: #a3b1ff;
                font-size: 10px;
                cursor: pointer;
                margin-left: 6px;
                flex-shrink: 0;
                border: 1px solid rgba(102,126,234,0.3);
                transition: background 0.2s;
                line-height: 1;
            }
            .vm-note-dot:hover { background: rgba(102,126,234,0.45); }
            /* ===== Note panel (inline under list item) ===== */
            .vm-note-panel {
                display: none;
                padding: 8px 12px;
                background: rgba(102,126,234,0.06);
                border-left: 2px solid rgba(102,126,234,0.3);
                border-radius: 0 0 8px 8px;
                margin-top: -4px;
                margin-bottom: 4px;
            }
            .vm-note-panel.open { display: flex; gap: 6px; align-items: flex-start; }
            .vm-note-panel textarea {
                flex: 1;
                min-height: 56px;
                resize: vertical;
                font-family: inherit;
                font-size: 12px;
                line-height: 1.5;
                padding: 6px 8px;
                background: rgba(0,0,0,0.35);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
                color: #ddd;
                outline: none;
            }
            .vm-note-panel textarea:focus { border-color: rgba(102,126,234,0.5); }
            .vm-note-save {
                padding: 5px 10px;
                font-size: 12px;
                flex-shrink: 0;
            }
            /* ===== Add row with color picker ===== */
            .vm-add-row-color {
                display: flex;
                flex-direction: row;
                gap: 8px;
                margin-top: 8px;
                align-items: center;
            }
            .vm-add-row-color .vm-input { flex: 1; }
            .vm-color-pick {
                width: 36px;
                height: 38px;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                cursor: pointer;
                background: none;
                flex-shrink: 0;
                padding: 2px;
            }
            /* ===== Preset labels dropdown ===== */
            .vm-presets-wrap {
                position: relative;
                margin-top: 6px;
            }
            .vm-presets-btn {
                font-size: 11px;
                color: #667eea;
                background: none;
                border: none;
                cursor: pointer;
                padding: 2px 0;
                font-family: inherit;
                text-decoration: underline;
                text-decoration-style: dotted;
            }
            .vm-presets-btn:hover { color: #a3b1ff; }
            .vm-presets-list {
                display: none;
                position: absolute;
                left: 0;
                bottom: 22px;
                z-index: 10;
                background: #1e1e2e;
                border: 1px solid rgba(102,126,234,0.3);
                border-radius: 8px;
                padding: 4px;
                min-width: 180px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            }
            .vm-presets-list.open { display: block; }
            .vm-preset-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 10px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                color: #ddd;
                transition: background 0.15s;
            }
            .vm-preset-item:hover { background: rgba(102,126,234,0.15); }

            /* ===== Update banner ===== */
            .vm-update-banner {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 10px 14px;
                margin-bottom: 16px;
                background: rgba(46,204,113,0.1);
                border: 1px solid rgba(46,204,113,0.35);
                border-radius: 10px;
                font-size: 12px;
                color: #2ecc71;
                animation: vm-update-glow 2s ease-in-out infinite;
            }
            @keyframes vm-update-glow {
                0%, 100% { border-color: rgba(46,204,113,0.35); }
                50% { border-color: rgba(46,204,113,0.7); }
            }
            .vm-update-banner span { flex: 1; }
            .vm-update-btn {
                padding: 4px 12px;
                border: 1px solid rgba(46,204,113,0.5);
                border-radius: 6px;
                background: rgba(46,204,113,0.15);
                color: #2ecc71;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;
                white-space: nowrap;
                transition: background 0.2s;
            }
            .vm-update-btn:hover { background: rgba(46,204,113,0.3); }

            /* ===== Search ===== */
            .vm-search-wrap {
                position: relative;
                margin-bottom: 8px;
            }
            .vm-search-wrap::before {
                content: "🔍";
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 12px;
                pointer-events: none;
            }
            .vm-search {
                width: 100%;
                padding: 8px 32px 8px 32px;
                background: rgba(0,0,0,0.4);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 8px;
                color: #fff;
                font-size: 12px;
                outline: none;
                transition: border-color 0.2s;
                font-family: inherit;
            }
            .vm-search:focus { border-color: rgba(102,126,234,0.5); }
            .vm-search::placeholder { color: #555; }
            .vm-search-clear {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                background: none;
                border: none;
                color: #555;
                font-size: 14px;
                cursor: pointer;
                padding: 0;
                line-height: 1;
                display: none;
            }
            .vm-search-clear.visible { display: block; }
            .vm-search-clear:hover { color: #fff; }
            .vm-search-count {
                font-size: 11px;
                color: #555;
                text-align: right;
                margin-top: -4px;
                margin-bottom: 4px;
                min-height: 14px;
            }

        `;
    shadow.appendChild(style);

    // ===== FAB =====
    const fab = document.createElement("button");
    fab.className = "vm-fab";
    fab.textContent = "💀";
    fab.title = "Universal Marker";
    shadow.appendChild(fab);

    // Якорь FAB в DOM страницы: для магнитной стыковки с FAB другого скрипта.
    // Свой FAB в Shadow DOM другому скрипту не виден — зеркалим позицию сюда.
    const oldAnchor = document.querySelector(".vm-fab-anchor");
    if (oldAnchor) oldAnchor.remove();
    const fabAnchor = document.createElement("div");
    fabAnchor.className = "vm-fab-anchor";
    fabAnchor.setAttribute("aria-hidden", "true");
    fabAnchor.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;opacity:0;z-index:-1;";
    document.documentElement.appendChild(fabAnchor);
    function syncFabAnchor() {
      const r = fab.getBoundingClientRect();
      fabAnchor.style.left = r.left + "px";
      fabAnchor.style.top = r.top + "px";
      fabAnchor.style.width = r.width + "px";
      fabAnchor.style.height = r.height + "px";
    }
    // Магнитная стыковка: вертикаль и горизонталь. Чужой FAB виден через его
    // якорь в DOM страницы; притягиваем только к нему. Отстыковка — увести в сторону.
    function snapFabToOther(p) {
      const other = document.querySelector(".dh-fab-anchor");
      if (!other) return p;
      const o = other.getBoundingClientRect();
      if (o.width < 4 || o.height < 4) return p;
      const w = fab.offsetWidth || 30;
      const h = fab.offsetHeight || 24;
      const gap = 8;
      const radius = 36;
      const cands = [
        { x: o.right + gap, y: o.top + (o.height - h) / 2 },           // справа
        { x: o.left - gap - w, y: o.top + (o.height - h) / 2 },        // слева
        { x: o.left + (o.width - w) / 2, y: o.bottom + gap },          // снизу
        { x: o.left + (o.width - w) / 2, y: o.top - gap - h },         // сверху
      ];
      let best = null;
      let bestD = Infinity;
      for (const c of cands) {
        const cc = clampFabPos(c.x, c.y);
        const d = (cc.x - p.x) * (cc.x - p.x) + (cc.y - p.y) * (cc.y - p.y);
        if (d < bestD) { bestD = d; best = cc; }
      }
      if (best && bestD <= radius * radius) return best;
      return p;
    }

    // ===== Overlay =====
    const overlay = document.createElement("div");
    overlay.className = "vm-overlay";
    shadow.appendChild(overlay);

    // ===== Modal =====
    const modal = document.createElement("div");
    modal.className = "vm-modal";
    modal.innerHTML = `
            <div class="vm-header">
                <div class="vm-head-actions">
                    <button class="vm-head-btn" id="vmRefresh" title="${t("head.refresh")}">🔄</button>
                    <button class="vm-head-btn" id="vmReport" title="${t("head.report")}">🐛</button>
                    <button class="vm-close">&times;</button>
                </div>
                <h2>💀 Universal Marker <span class="vm-domain">${escapeHtml(DOMAIN)}</span></h2>
            </div>

            <div class="vm-tabs">
                <button class="vm-tab active" data-tab="nicks">${t("tab.nicks")}</button>
                <button class="vm-tab" data-tab="profiles">${t("tab.profiles")}</button>
                <button class="vm-tab" data-tab="settings">${t("tab.settings")}</button>
                <button class="vm-tab" data-tab="help">${t("tab.help")}</button>
            </div>

            <div class="vm-tab-content active" data-tab="nicks">
                <div class="vm-search-wrap">
                    <input class="vm-search" id="vmNickSearch" placeholder="${t("search.nicks")}">
                    <button class="vm-search-clear" id="vmNickSearchClear">✕</button>
                </div>
                <div class="vm-search-count" id="vmNickSearchCount"></div>
                <div class="vm-list" id="vmNickList"></div>
                <div class="vm-add-row-color">
                    <input class="vm-input" id="vmNewNick" placeholder="${t("ph.nick")}">
                    <input class="vm-input" id="vmNewLabel" placeholder="${t("ph.label")}">
                    <input type="color" class="vm-color-pick" id="vmNewNickColor" title="${t("nick.colorTitle")}">
                    <button class="vm-btn vm-btn-primary" id="vmAddNick">+</button>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
                    <div class="vm-presets-wrap">
                        <button class="vm-presets-btn" id="vmPresetsBtn">${t("presets.btn")}</button>
                        <div class="vm-presets-list" id="vmPresetsList"></div>
                    </div>
                    <button class="vm-bulk-toggle" id="vmBulkToggle">▼ ${t("bulk.toggle")}</button>
                </div>
                <div class="vm-bulk-section" id="vmBulkSection">
                    <div class="vm-bulk-row">
                        <input class="vm-input" id="vmBulkLabel" placeholder="${t("bulk.labelPh")}">
                        <input type="color" class="vm-color-pick" id="vmBulkColor" title="${t("title.color")}">
                    </div>
                    <textarea class="vm-input" id="vmBulkNicks" placeholder="${t("bulk.nicksPh")}" rows="6"></textarea>
                    <div class="vm-bulk-counter" id="vmBulkCounter">0 / 100</div>
                    <button class="vm-btn vm-btn-primary" id="vmBulkAdd">${t("bulk.addBtn")}</button>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="profiles">
                <div class="vm-search-wrap">
                    <input class="vm-search" id="vmProfSearch" placeholder="${t("search.profiles")}">
                    <button class="vm-search-clear" id="vmProfSearchClear">✕</button>
                </div>
                <div class="vm-search-count" id="vmProfSearchCount"></div>
                <div class="vm-list" id="vmProfileList"></div>
                <div class="vm-add-row">
                    <input class="vm-input" id="vmNewProfId" placeholder="${t("ph.userId")}">
                    <input class="vm-input" id="vmNewProfText" placeholder="${t("ph.msgText")}">
                    <button class="vm-btn vm-btn-primary" id="vmAddProf">+</button>
                </div>
                <div class="vm-presets-wrap" style="margin-top:6px;">
                    <button class="vm-presets-btn" id="vmProfPresetsBtn">${t("presets.btn")}</button>
                    <div class="vm-presets-list" id="vmProfPresetsList"></div>
                </div>
                <div id="vmSteamQuickAdd" style="display:none;margin-top:8px;">
                    <div style="padding:10px 12px;background:rgba(23,111,158,0.12);border:1px solid rgba(23,111,158,0.3);border-radius:10px;">
                        <div style="font-size:12px;color:#5dade2;margin-bottom:8px;">${t("steam.auto")}</div>
                        <div style="font-size:11px;color:#666;margin-bottom:8px;" id="vmSteamDetectedId"></div>
                        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                            <input class="vm-input" id="vmSteamQuickText" placeholder="${t("steam.profilePh")}" style="flex:1;">
                            <button class="vm-btn vm-btn-primary" id="vmSteamQuickBtn">${t("steam.addProfile")}</button>
                        </div>
                        <div style="border-top:1px solid rgba(23,111,158,0.2);padding-top:8px;">
                            <div style="font-size:11px;color:#666;margin-bottom:6px;" id="vmSteamNickInfo"></div>
                            <div id="vmSteamNickRow" style="display:none;flex-direction:row;gap:8px;align-items:center;">
                                <input class="vm-input" id="vmSteamNickLabel" placeholder="${t("steam.nickPh")}" style="flex:1;">
                                <input type="color" class="vm-color-pick" id="vmSteamNickColor" title="${t("title.color")}" style="width:36px;height:32px;flex-shrink:0;">
                                <button class="vm-btn vm-btn-primary" id="vmSteamNickBtn">${t("steam.addNick")}</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="settings">
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.lang")}</span>
                    <select class="vm-input" id="vmLang" style="width:120px;flex:unset;">
                        <option value="en">English</option>
                        <option value="ru">Русский</option>
                    </select>
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.nickColor")}</span>
                    <input type="color" class="vm-color-input" id="vmNickColor" value="${DATA.settings.nickColor}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.centerColor")}</span>
                    <input type="color" class="vm-color-input" id="vmCenterColor" value="${DATA.settings.centerColor}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.border")}</span>
                    <input type="color" class="vm-color-input" id="vmCenterBorder" value="${DATA.settings.centerBorder}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.fontSize")}</span>
                    <input class="vm-input" id="vmCenterSize" value="${DATA.settings.centerSize}" style="width:80px;flex:unset;">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">${t("set.showForever")}</span>
                    <input type="checkbox" id="vmShowForever" ${DATA.settings.showForever ? "checked" : ""}>
                </div>
                <div class="vm-setting-row" style="border-bottom:none;">
                    <span class="vm-setting-label">${t("set.patterns")}</span>
                </div>
                <textarea class="vm-input" id="vmPatterns" rows="3" style="resize:vertical;margin-top:6px;">${(DATA.settings.userIdPatterns || []).join("\n")}</textarea>
                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">
                    <span class="vm-setting-label">${t("set.version")} <strong style="color:#a3b1ff;" id="vmCurrentVersion"></strong></span>
                    <span style="font-size:10px;color:#666;flex:1;min-width:0;text-align:right;">${t("set.publicNote")}</span>
                </div>
                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">
                    <span class="vm-setting-label">${t("set.exportImport")}</span>
                    <div style="display:flex;gap:6px;">
                        <button class="vm-btn vm-btn-success" id="vmExportAll">${t("set.export")}</button>
                        <button class="vm-btn vm-btn-warning" id="vmImportAll">${t("set.import")}</button>
                    </div>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="help">
                <div class="vm-help">
                    <h3>${t("help.title")}</h3>
                    ${t("help.nicksP")}
                    ${t("help.nicksExP")}
                    ${t("help.profilesP")}
                    ${t("help.profilesExP")}
                    ${t("help.patternsP")}
                    ${t("help.exportP")}
                    ${t("help.storageP")}
                </div>
            </div>

            <div style="margin-top:10px;text-align:center;">
                <a class="vm-donate-link" href="https://vidrimers.online/donate" target="_blank" rel="noopener">${t("donate")}</a>
                <span style="opacity:0.4;margin:0 6px">·</span>
                <a class="vm-donate-link" id="vmLicenseLink" href="#" style="cursor:pointer">${t("ui.license")}</a>
            </div>
        `;
    shadow.appendChild(modal);

    // ========== DRAG: перетаскивание окна за заголовок ==========
    function clampWinPos(x, y) {
      const w = modal.offsetWidth || 520;
      const h = modal.offsetHeight || 300;
      const maxX = Math.max(8, window.innerWidth - w - 8);
      const maxY = Math.max(8, window.innerHeight - h - 8);
      return {
        x: Math.min(Math.max(8, x), maxX),
        y: Math.min(Math.max(8, y), maxY),
      };
    }

    function applyWinPos() {
      const saved = DATA.settings.winPos;
      let pos;
      if (saved && saved.xPct != null) {
        // проценты от размера окна браузера — переживает другой монитор
        pos = clampWinPos(
          Math.round((saved.xPct / 100) * window.innerWidth),
          Math.round((saved.yPct / 100) * window.innerHeight)
        );
      } else {
        pos = clampWinPos(window.innerWidth - 520 - 120, Math.round(window.innerHeight * 0.12));
      }
      modal.style.left = pos.x + "px";
      modal.style.top = pos.y + "px";
    }

    function saveWinPos() {
      const x = parseInt(modal.style.left, 10) || 0;
      const y = parseInt(modal.style.top, 10) || 0;
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      DATA.settings.winPos = { xPct: (x / w) * 100, yPct: (y / h) * 100 };
      saveData(DATA);
    }

    function initDrag() {
      // тянем за шапку-тайтлбар; крестик — только клик
      const bar = modal.querySelector(".vm-header");
      if (!bar) return;
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let origX = 0;
      let origY = 0;

      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const p = clampWinPos(origX + (e.clientX - startX), origY + (e.clientY - startY));
        modal.style.left = p.x + "px";
        modal.style.top = p.y + "px";
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        saveWinPos();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      bar.addEventListener("pointerdown", (e) => {
        // не тащить по кнопкам внутри заголовка
        if (e.target.closest(".vm-head-btn, .vm-close")) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        origX = parseInt(modal.style.left, 10) || modal.offsetLeft || 0;
        origY = parseInt(modal.style.top, 10) || modal.offsetTop || 0;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }

    applyWinPos();
    initDrag();
    // при resize окна браузера — поджимаем позиции, чтобы элементы не остались за краем
    uiResizeHandler = () => {
      if (modal.classList.contains("open")) applyWinPos();
      applyFabPos();
    };
    window.addEventListener("resize", uiResizeHandler);

    // ========== DRAG: перетаскивание FAB ==========
    let fabDragged = false; // клик после перетаскивания не открывает панель

    function clampFabPos(x, y) {
      const w = fab.offsetWidth || 30;
      const h = fab.offsetHeight || 24;
      const maxX = Math.max(8, window.innerWidth - w - 8);
      const maxY = Math.max(8, window.innerHeight - h - 8);
      return {
        x: Math.min(Math.max(8, x), maxX),
        y: Math.min(Math.max(8, y), maxY),
      };
    }

    function applyFabPos() {
      const saved = DATA.settings.fabPos;
      if (!saved || saved.xPct == null) {
        // дефолт — левый нижний угол (как в CSS)
        fab.style.left = "24px";
        fab.style.top = "auto";
        fab.style.bottom = "24px";
        syncFabAnchor();
        return;
      }
      const x = Math.round((saved.xPct / 100) * window.innerWidth);
      const y = Math.round((saved.yPct / 100) * window.innerHeight);
      const p = clampFabPos(x, y);
      fab.style.left = p.x + "px";
      fab.style.top = p.y + "px";
      fab.style.bottom = "auto";
      syncFabAnchor();
    }

    function saveFabPos() {
      const x = parseInt(fab.style.left, 10) || 0;
      const y = parseInt(fab.style.top, 10) || 0;
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      DATA.settings.fabPos = { xPct: (x / w) * 100, yPct: (y / h) * 100 };
      saveData(DATA);
    }

    function initFabDrag() {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let origX = 0;
      let origY = 0;

      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        let p = clampFabPos(origX + dx, origY + dy);
        p = snapFabToOther(p);
        fab.style.left = p.x + "px";
        fab.style.top = p.y + "px";
        fab.style.bottom = "auto";
        syncFabAnchor();
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
          saveFabPos();
          syncFabAnchor();
          fabDragged = true;
          // страховка: если click после перетаскивания не пришёл — сбрасываем флаг
          setTimeout(() => { fabDragged = false; }, 500);
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      fab.addEventListener("pointerdown", (e) => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        origX = parseInt(fab.style.left, 10) || fab.offsetLeft || 24;
        origY =
          fab.style.top !== "auto" && fab.style.top
            ? parseInt(fab.style.top, 10) || 24
            : window.innerHeight - (fab.offsetHeight || 24) - 24;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }

    applyFabPos();
    initFabDrag();

    // ========== FAB: восстановление на YouTube и других SPA ==========
    // YouTube пересоздаёт DOM при навигации и может удалять наш host-элемент
    uiFabObserver = new MutationObserver(() => {
      if (!document.documentElement.contains(host)) {
        document.documentElement.appendChild(host);
      }
      if (!document.documentElement.contains(fabAnchor)) {
        document.documentElement.appendChild(fabAnchor);
      }
    });
    uiFabObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // ========== TOAST (внутри Shadow DOM) ==========
    function showToast(msg, isError = false) {
      const old = shadow.querySelector(".vm-toast");
      if (old) old.remove();
      const el = document.createElement("div");
      el.className = "vm-toast" + (isError ? " error" : "");
      el.textContent = msg;
      shadow.appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
      setTimeout(() => {
        el.classList.remove("show");
        setTimeout(() => el.remove(), 300);
      }, 3000);
    }

    // ========== EVENTS ==========
    fab.onclick = () => {
      // после перетаскивания клик не трогает панель
      if (fabDragged) { fabDragged = false; return; }
      // тумблер: открыть / закрыть
      if (modal.classList.contains("open")) closeModal();
      else openModal();
    };
    modal.querySelector(".vm-close").onclick = () => closeModal();
    // overlay.onclick убран — модалка закрывается только крестиком

    // Search — nicks
    const nickSearch = modal.querySelector("#vmNickSearch");
    const nickSearchClear = modal.querySelector("#vmNickSearchClear");
    nickSearch.oninput = () => {
      nickSearchClear.classList.toggle("visible", nickSearch.value.length > 0);
      renderLists();
    };
    nickSearchClear.onclick = () => {
      nickSearch.value = "";
      nickSearchClear.classList.remove("visible");
      renderLists();
      nickSearch.focus();
    };

    // Search — profiles
    const profSearch = modal.querySelector("#vmProfSearch");
    const profSearchClear = modal.querySelector("#vmProfSearchClear");
    profSearch.oninput = () => {
      profSearchClear.classList.toggle("visible", profSearch.value.length > 0);
      renderLists();
    };
    profSearchClear.onclick = () => {
      profSearch.value = "";
      profSearchClear.classList.remove("visible");
      renderLists();
      profSearch.focus();
    };

    function openModal() {
      overlay.classList.add("open");
      modal.classList.add("open");
      DATA.settings.uiOpen = true;
      saveData(DATA);
      renderLists();
    }
    function closeModal() {
      overlay.classList.remove("open");
      modal.classList.remove("open");
      DATA.settings.uiOpen = false;
      saveData(DATA);
    }

    // ========== STEAM QUICK ADD ==========
    (function initSteamQuickAdd() {
      // Работаем только на steamcommunity.com
      if (!location.hostname.includes("steamcommunity.com")) return;

      // g_rgProfileData — данные профиля который открыт (не твои)
      let profileData = null;
      try { profileData = unsafeWindow.g_rgProfileData || null; } catch (e) {}
      if (!profileData || !profileData.steamid) return;

      const steamId64 = profileData.steamid;
      const currentNick = profileData.personaname || null;
      const profileUrl = `https://steamcommunity.com/profiles/${steamId64}/`;

      const quickBlock = modal.querySelector("#vmSteamQuickAdd");
      const idLabel = modal.querySelector("#vmSteamDetectedId");
      const quickText = modal.querySelector("#vmSteamQuickText");
      const quickBtn = modal.querySelector("#vmSteamQuickBtn");
      const nickInfo = modal.querySelector("#vmSteamNickInfo");
      const nickRow = modal.querySelector("#vmSteamNickRow");
      const nickLabel = modal.querySelector("#vmSteamNickLabel");
      const nickColor = modal.querySelector("#vmSteamNickColor");
      const nickBtn = modal.querySelector("#vmSteamNickBtn");

      if (!quickBlock) return;

      idLabel.textContent = `SteamID64: ${steamId64}`;
      quickBlock.style.display = "block";

      if (currentNick && nickInfo && nickRow && nickColor) {
        nickInfo.textContent = t("steam.currentNick", { nick: currentNick });
        nickInfo.style.color = "#a3b1ff";
        nickColor.value = DATA.settings.nickColor;
        nickRow.style.display = "flex";
      }

      function switchTab(tabName) {
        modal.querySelectorAll(".vm-tab").forEach((el) => el.classList.remove("active"));
        modal.querySelectorAll(".vm-tab-content").forEach((el) => el.classList.remove("active"));
        modal.querySelector(`.vm-tab[data-tab='${tabName}']`).classList.add("active");
        modal.querySelector(`.vm-tab-content[data-tab='${tabName}']`).classList.add("active");
      }

      // ── Добавить профиль ──
      quickBtn.onclick = () => {
        const text = quickText.value.trim();
        if (!text) return showToast(t("toast.needProfileLabel"), true);
        const exists = !!DATA.profileMessages[steamId64];
        DATA.profileMessages[steamId64] = text;
        saveData(DATA);
        quickText.value = "";
        renderLists();
        switchTab("profiles");
        showToast(exists ? t("toast.profileUpdated") : t("toast.profileAdded"));
      };

      // ── Добавить ник (с steamId64 для мониторинга + заметка со ссылкой) ──
      if (nickBtn) {
        nickBtn.onclick = () => {
          if (!currentNick) return showToast(t("toast.nickUnavailable"), true);
          const label = nickLabel.value.trim();
          if (!label) return showToast(t("toast.needNickLabel"), true);
          const color = nickColor.value;
          const exists = Object.keys(DATA.nicknames).some(
            (k) => k === currentNick
          );
          const oldNote = exists ? ((getNickData(currentNick) || {}).note || "") : "";
          // Если в заметке ещё нет ссылки — добавляем
          const note = oldNote.includes(profileUrl)
            ? oldNote
            : (oldNote ? oldNote + "\n" + profileUrl : profileUrl);
          DATA.nicknames[currentNick] = { label, color, note, steamId64 };
          saveData(DATA);
          pattern = buildPattern();
          nickLabel.value = "";
          renderLists();
          switchTab("nicks");
          showToast(exists ? t("toast.labelUpdated", { nick: currentNick }) : t("toast.nickAddedNamed", { nick: currentNick }));
        };
      }
    })();

    // ========== ПРОВЕРКА ОБНОВЛЕНИЙ ==========
    // (для Greasy Fork вырезано: апдейтер и адреса GitHub не публикуются)
    const CURRENT_VERSION =
      (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) ||
      "6.8.0";

    // Вставляем текущую версию в настройки
    const verEl = modal.querySelector("#vmCurrentVersion");
    if (verEl) verEl.textContent = CURRENT_VERSION;

    // Tabs
    modal.querySelectorAll(".vm-tab").forEach((tab) => {
      tab.onclick = () => {
        modal
          .querySelectorAll(".vm-tab")
          .forEach((el) => el.classList.remove("active"));
        modal
          .querySelectorAll(".vm-tab-content")
          .forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        modal
          .querySelector(`.vm-tab-content[data-tab="${tab.dataset.tab}"]`)
          .classList.add("active");
      };
    });

    // Render lists
    function renderLists() {
      const nickList = modal.querySelector("#vmNickList");
      const profList = modal.querySelector("#vmProfileList");
      const nickQ = (modal.querySelector("#vmNickSearch").value || "")
        .trim()
        .toLowerCase();
      const profQ = (modal.querySelector("#vmProfSearch").value || "")
        .trim()
        .toLowerCase();

      const allNicks = Object.entries(DATA.nicknames);
      const filteredNicks = nickQ
        ? allNicks.filter(([nick, nd]) => {
            const lbl = typeof nd === "string" ? nd : nd.label || "";
            const note = typeof nd === "object" ? nd.note || "" : "";
            return (
              nick.toLowerCase().includes(nickQ) ||
              lbl.toLowerCase().includes(nickQ) ||
              note.toLowerCase().includes(nickQ)
            );
          })
        : allNicks;

      const allProfs = Object.entries(DATA.profileMessages);
      const filteredProfs = profQ
        ? allProfs.filter(
            ([id, text]) =>
              id.toLowerCase().includes(profQ) ||
              text.toLowerCase().includes(profQ),
          )
        : allProfs;

      // Счётчик для ников
      const nickCountEl = modal.querySelector("#vmNickSearchCount");
      if (nickQ) {
        nickCountEl.textContent = t("list.found", { a: filteredNicks.length, b: allNicks.length });
      } else {
        nickCountEl.textContent = allNicks.length
          ? t("list.total", { n: allNicks.length })
          : "";
      }

      // Счётчик для профилей
      const profCountEl = modal.querySelector("#vmProfSearchCount");
      if (profQ) {
        profCountEl.textContent = t("list.found", { a: filteredProfs.length, b: allProfs.length });
      } else {
        profCountEl.textContent = allProfs.length
          ? t("list.total", { n: allProfs.length })
          : "";
      }

      nickList.innerHTML =
        filteredNicks
          .map(([nick, nd]) => {
            const d =
              typeof nd === "string"
                ? { label: nd, color: null, note: "" }
                : nd;
            const color = d.color || DATA.settings.nickColor;
            const hasNote = d.note && d.note.trim();
            return `
                <div class="vm-list-item-wrap">
                    <div class="vm-list-item" data-nick-row="${escapeHtml(nick)}">
                        <span class="vm-list-item-text">
                            <span class="vm-nick-color-dot" style="background:${escapeHtml(color)}"></span><strong>${escapeHtml(nick)}</strong><span class="vm-arrow">→</span>${escapeHtml(d.label)}${hasNote ? `<button class="vm-note-dot" data-note-nick="${escapeHtml(nick)}" title="${t("note.title")}">✎</button>` : `<button class="vm-note-dot vm-note-add" data-note-nick="${escapeHtml(nick)}" title="${t("note.add")}" style="opacity:0.35;">+</button>`}
                        </span>
                        <span class="vm-item-actions">
                            <button class="vm-edit-btn" data-nick="${escapeHtml(nick)}" data-label="${escapeHtml(d.label)}" data-color="${escapeHtml(color)}">✎</button>
                            <button class="vm-delete-btn" data-nick="${escapeHtml(nick)}">✕</button>
                        </span>
                    </div>
                    <div class="vm-note-panel" data-note-panel="${escapeHtml(nick)}">
                        <textarea placeholder="${t("note.ph")}">${escapeHtml(d.note || "")}</textarea>
                        <button class="vm-btn vm-btn-primary vm-note-save" data-save-nick="${escapeHtml(nick)}">✓</button>
                    </div>
                </div>
            `;
          })
          .join("") ||
        `<div style="padding:12px;text-align:center;color:#555;">${nickQ ? t("list.notFound") : t("list.empty")}</div>`;

      profList.innerHTML =
        filteredProfs
          .map(
            ([id, text]) => `
                <div class="vm-list-item">
                    <span class="vm-list-item-text"><strong>${escapeHtml(id)}</strong><span class="vm-arrow">→</span>${escapeHtml(text)}</span>
                    <span class="vm-item-actions">
                        <button class="vm-edit-btn" data-prof="${escapeHtml(id)}" data-label="${escapeHtml(text)}">✎</button>
                        <button class="vm-delete-btn" data-prof="${escapeHtml(id)}">✕</button>
                    </span>
                </div>
            `,
          )
          .join("") ||
        `<div style="padding:12px;text-align:center;color:#555;">${profQ ? t("list.notFound") : t("list.empty")}</div>`;

      // Nick edit handlers
      nickList.querySelectorAll(".vm-edit-btn").forEach((btn) => {
        btn.onclick = () => {
          const oldNick = btn.dataset.nick;
          const oldLabel = btn.dataset.label;
          const oldColor = btn.dataset.color || DATA.settings.nickColor;
          const oldNote = (getNickData(oldNick) || {}).note || "";
          // Заменяем всю обёртку (wrap = list-item + note-panel)
          const wrap = btn.closest(".vm-list-item-wrap");
          const editRow = document.createElement("div");
          editRow.className = "vm-edit-row";
          editRow.dataset.editingNick = oldNick;
          editRow.style.cssText = "flex-wrap:wrap;gap:6px;";
          editRow.innerHTML = `
            <input class="vm-input vm-edit-nick" value="${escapeHtml(oldNick)}" placeholder="${t("ph.nick")}" style="flex:1;min-width:80px;">
            <input class="vm-input vm-edit-label" value="${escapeHtml(oldLabel)}" placeholder="${t("ph.label")}" style="flex:1;min-width:80px;">
            <input type="color" class="vm-color-pick vm-edit-color" value="${escapeHtml(oldColor)}" title="${t("title.colorShort")}" style="width:36px;height:32px;flex-shrink:0;">
            <button class="vm-btn vm-btn-primary vm-save-nick">✓</button>
            <button class="vm-btn vm-btn-ghost vm-cancel-nick">✕</button>
          `;
          wrap.replaceWith(editRow);
          editRow.querySelector(".vm-save-nick").onclick = () => {
            const newNick = editRow.querySelector(".vm-edit-nick").value.trim();
            const newLabel = editRow
              .querySelector(".vm-edit-label")
              .value.trim();
            const newColor = editRow.querySelector(".vm-edit-color").value;
            if (!newNick || !newLabel)
              return showToast(t("toast.fillBoth"), true);
            delete DATA.nicknames[oldNick];
            DATA.nicknames[newNick] = {
              label: newLabel,
              color: newColor,
              note: oldNote,
            };
            saveData(DATA);
            pattern = buildPattern();
            renderLists();
            showToast(t("toast.saved"));
          };
          editRow.querySelector(".vm-cancel-nick").onclick = () =>
            renderLists();
        };
      });

      // Note dot handlers
      nickList.querySelectorAll(".vm-note-dot, .vm-note-add").forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const nick = btn.dataset.noteNick;
          const panel = nickList.querySelector(`[data-note-panel="${nick}"]`);
          if (!panel) return;
          const isOpen = panel.classList.toggle("open");
          if (isOpen) panel.querySelector("textarea").focus();
        };
      });

      // Note save handlers
      nickList.querySelectorAll(".vm-note-save").forEach((btn) => {
        btn.onclick = () => {
          const nick = btn.dataset.saveNick;
          const panel = nickList.querySelector(`[data-note-panel="${nick}"]`);
          const note = panel.querySelector("textarea").value.trim();
          const d = getNickData(nick) || { label: "", color: null, note: "" };
          DATA.nicknames[nick] = { label: d.label, color: d.color, note };
          saveData(DATA);
          renderLists();
          showToast(note ? t("toast.noteSaved") : t("toast.noteDeleted"));
        };
      });

      // Profile edit handlers
      profList.querySelectorAll(".vm-edit-btn").forEach((btn) => {
        btn.onclick = () => {
          const oldId = btn.dataset.prof;
          const oldLabel = btn.dataset.label;
          btn.closest(".vm-list-item").outerHTML = `
                        <div class="vm-edit-row" data-editing-prof="${escapeHtml(oldId)}">
                            <input class="vm-input vm-edit-id" value="${escapeHtml(oldId)}" placeholder="${t("ph.id")}"
                            <input class="vm-input vm-edit-text" value="${escapeHtml(oldLabel)}" placeholder="${t("ph.text")}"
                            <button class="vm-btn vm-btn-primary vm-save-prof">✓</button>
                            <button class="vm-btn vm-btn-ghost vm-cancel-prof">✕</button>
                        </div>
                    `;
          const row = profList.querySelector(
            `[data-editing-prof="${escapeHtml(oldId)}"]`,
          );
          row.querySelector(".vm-save-prof").onclick = () => {
            const newId = row.querySelector(".vm-edit-id").value.trim();
            const newText = row.querySelector(".vm-edit-text").value.trim();
            if (!newId || !newText)
              return showToast(t("toast.fillBoth"), true);
            delete DATA.profileMessages[oldId];
            DATA.profileMessages[newId] = newText;
            saveData(DATA);
            renderLists();
            showToast(t("toast.saved"));
          };
          row.querySelector(".vm-cancel-prof").onclick = () => renderLists();
        };
      });

      // Delete handlers
      nickList.querySelectorAll(".vm-delete-btn").forEach((btn) => {
        btn.onclick = () => {
          delete DATA.nicknames[btn.dataset.nick];
          saveData(DATA);
          pattern = buildPattern();
          renderLists();
          showToast(t("toast.deleted"));
        };
      });
      profList.querySelectorAll(".vm-delete-btn").forEach((btn) => {
        btn.onclick = () => {
          delete DATA.profileMessages[btn.dataset.prof];
          saveData(DATA);
          renderLists();
          showToast(t("toast.deleted"));
        };
      });
    }

    // Инициализировать color picker дефолтным цветом из настроек
    const newNickColorInput = modal.querySelector("#vmNewNickColor");
    newNickColorInput.value = DATA.settings.nickColor;

    // Add nick
    modal.querySelector("#vmAddNick").onclick = () => {
      const nick = modal.querySelector("#vmNewNick").value.trim();
      const label = modal.querySelector("#vmNewLabel").value.trim();
      const color = modal.querySelector("#vmNewNickColor").value;
      if (!nick || !label) return showToast(t("toast.fillBoth"), true);
      const exists = Object.keys(DATA.nicknames).some(
        (k) => k === nick,
      );
      const oldNote = exists ? (getNickData(nick) || {}).note || "" : "";
      DATA.nicknames[nick] = { label, color, note: oldNote };
      saveData(DATA);
      pattern = buildPattern();
      modal.querySelector("#vmNewNick").value = "";
      modal.querySelector("#vmNewLabel").value = "";
      // color picker остаётся — удобно добавлять несколько ников с одним цветом
      renderLists();
      showToast(exists ? t("toast.labelUpdated", { nick }) : t("toast.nickAdded"));
    };

    // Init bulk color picker
    modal.querySelector("#vmBulkColor").value = DATA.settings.nickColor;

    // Presets dropdown — уникальные метки из существующих ников
    function renderPresets() {
      const list = modal.querySelector("#vmPresetsList");
      const unique = [
        ...new Set(
          Object.values(DATA.nicknames).map((v) =>
            typeof v === "string" ? v : v.label,
          ),
        ),
      ]
        .filter(Boolean)
        .sort();
      if (!unique.length) {
        list.innerHTML =
          `<div style="padding:8px 10px;font-size:12px;color:#555;">${t("presets.empty")}</div>`;
        return;
      }
      list.innerHTML = unique
        .map((lbl) => {
          // найдём цвет первого ника с этой меткой
          let col = DATA.settings.nickColor;
          for (const [, v] of Object.entries(DATA.nicknames)) {
            const d = typeof v === "string" ? { label: v, color: null } : v;
            if (d.label === lbl && d.color) {
              col = d.color;
              break;
            }
          }
          return `<div class="vm-preset-item" data-preset-label="${escapeHtml(lbl)}" data-preset-color="${escapeHtml(col)}">
          <span class="vm-nick-color-dot" style="background:${escapeHtml(col)}"></span>${escapeHtml(lbl)}
        </div>`;
        })
        .join("");
      list.querySelectorAll(".vm-preset-item").forEach((item) => {
        item.onclick = () => {
          modal.querySelector("#vmNewLabel").value = item.dataset.presetLabel;
          modal.querySelector("#vmNewNickColor").value =
            item.dataset.presetColor;
          list.classList.remove("open");
          modal.querySelector("#vmNewNick").focus();
        };
      });
    }
    modal.querySelector("#vmPresetsBtn").onclick = (e) => {
      e.stopPropagation();
      renderPresets();
      modal.querySelector("#vmPresetsList").classList.toggle("open");
    };

    // Presets dropdown для вкладки Профили — те же метки, подставляются в поле текста профиля
    function renderProfPresets() {
      const list = modal.querySelector("#vmProfPresetsList");
      const unique = [
        ...new Set(
          Object.values(DATA.nicknames).map((v) =>
            typeof v === "string" ? v : v.label,
          ),
        ),
      ]
        .filter(Boolean)
        .sort();
      if (!unique.length) {
        list.innerHTML =
          `<div style="padding:8px 10px;font-size:12px;color:#555;">${t("presets.empty")}</div>`;
        return;
      }
      list.innerHTML = unique
        .map((lbl) => {
          let col = DATA.settings.nickColor;
          for (const [, v] of Object.entries(DATA.nicknames)) {
            const d = typeof v === "string" ? { label: v, color: null } : v;
            if (d.label === lbl && d.color) {
              col = d.color;
              break;
            }
          }
          return `<div class="vm-preset-item" data-preset-label="${escapeHtml(lbl)}" data-preset-color="${escapeHtml(col)}">
          <span class="vm-nick-color-dot" style="background:${escapeHtml(col)}"></span>${escapeHtml(lbl)}
        </div>`;
        })
        .join("");
      list.querySelectorAll(".vm-preset-item").forEach((item) => {
        item.onclick = () => {
          modal.querySelector("#vmNewProfText").value = item.dataset.presetLabel;
          list.classList.remove("open");
          modal.querySelector("#vmNewProfId").focus();
        };
      });
    }
    modal.querySelector("#vmProfPresetsBtn").onclick = (e) => {
      e.stopPropagation();
      renderProfPresets();
      modal.querySelector("#vmProfPresetsList").classList.toggle("open");
    };

    // Закрыть список при клике в другое место внутри модалки
    modal.addEventListener("click", (e) => {
      if (!e.target.closest(".vm-presets-wrap")) {
        modal.querySelector("#vmPresetsList").classList.remove("open");
        modal.querySelector("#vmProfPresetsList").classList.remove("open");
      }
    });

    // Bulk add toggle
    modal.querySelector("#vmBulkToggle").onclick = () => {
      const sec = modal.querySelector("#vmBulkSection");
      const btn = modal.querySelector("#vmBulkToggle");
      const isOpen = sec.classList.toggle("open");
      btn.textContent = (isOpen ? "▲ " : "▼ ") + t("bulk.toggle");
    };

    // Bulk add counter
    const bulkNicksTA = modal.querySelector("#vmBulkNicks");
    const bulkCounter = modal.querySelector("#vmBulkCounter");
    const MAX_BULK = 100;
    bulkNicksTA.oninput = () => {
      const lines = bulkNicksTA.value
        .split("\n")
        .filter((l) => l.trim()).length;
      bulkCounter.textContent = `${lines} / ${MAX_BULK}`;
      bulkCounter.className =
        "vm-bulk-counter" +
        (lines > MAX_BULK ? " limit" : lines > 80 ? " warn" : "");
    };

    // Bulk add submit
    modal.querySelector("#vmBulkAdd").onclick = () => {
      const label = modal.querySelector("#vmBulkLabel").value.trim();
      if (!label) return showToast(t("toast.needBulkLabel"), true);
      const lines = bulkNicksTA.value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return showToast(t("toast.bulkEmpty"), true);
      if (lines.length > MAX_BULK)
        return showToast(t("toast.bulkMax", { n: MAX_BULK }), true);
      const bulkColor = modal.querySelector("#vmBulkColor").value;
      let added = 0,
        updated = 0;
      for (const nick of lines) {
        const exists = Object.keys(DATA.nicknames).some(
          (k) => k === nick,
        );
        if (exists) {
          updated++;
        } else {
          added++;
        }
        const oldNote = exists ? (getNickData(nick) || {}).note || "" : "";
        DATA.nicknames[nick] = { label, color: bulkColor, note: oldNote };
      }
      saveData(DATA);
      pattern = buildPattern();
      bulkNicksTA.value = "";
      bulkCounter.textContent = `0 / ${MAX_BULK}`;
      bulkCounter.className = "vm-bulk-counter";
      renderLists();
      const parts = [];
      if (added) parts.push(t("bulk.addedPart", { n: added }));
      if (updated) parts.push(t("bulk.updatedPart", { n: updated }));
      showToast(`✓ ${parts.join(", ")}`);
    };

    // Add profile
    modal.querySelector("#vmAddProf").onclick = () => {
      const id = modal.querySelector("#vmNewProfId").value.trim();
      const text = modal.querySelector("#vmNewProfText").value.trim();
      if (!id || !text) return showToast(t("toast.fillBoth"), true);
      DATA.profileMessages[id] = text;
      saveData(DATA);
      modal.querySelector("#vmNewProfId").value = "";
      modal.querySelector("#vmNewProfText").value = "";
      renderLists();
      showToast(t("toast.profileAddedOk"));
    };

    // Settings
    const saveSettings = () => {
      DATA.settings.nickColor = modal.querySelector("#vmNickColor").value;
      DATA.settings.centerColor = modal.querySelector("#vmCenterColor").value;
      DATA.settings.centerBorder = modal.querySelector("#vmCenterBorder").value;
      DATA.settings.centerSize = modal.querySelector("#vmCenterSize").value;
      DATA.settings.showForever = modal.querySelector("#vmShowForever").checked;
      DATA.settings.userIdPatterns = modal
        .querySelector("#vmPatterns")
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      saveData(DATA);
      showToast(t("toast.settingsSaved"));
    };

    modal.querySelector("#vmNickColor").onchange = () => {
      saveSettings();
      // Обновляем color picker в форме добавления ника, если пользователь не менял его вручную
      modal.querySelector("#vmNewNickColor").value =
        modal.querySelector("#vmNickColor").value;
      modal.querySelector("#vmBulkColor").value =
        modal.querySelector("#vmNickColor").value;
    };
    modal.querySelector("#vmCenterColor").onchange = saveSettings;
    modal.querySelector("#vmCenterBorder").onchange = saveSettings;
    modal.querySelector("#vmCenterSize").onchange = saveSettings;
    modal.querySelector("#vmShowForever").onchange = saveSettings;
    modal.querySelector("#vmPatterns").onblur = saveSettings;
    const langSelect = modal.querySelector("#vmLang");
    langSelect.value = uiLang();
    langSelect.onchange = () => {
      const lang = langSelect.value === "ru" ? "ru" : "en";
      DATA.settings.lang = lang;
      saveData(DATA);
      GM_setValue(LANG_PREF_KEY, lang); // преференс для новых сайтов
      applyLangToAllSites(lang);
      rebuildUI();
    };

    // Export All Sites
    modal.querySelector("#vmExportAll").onclick = () => {
      const allKeys = GM_listValues().filter((k) => k.startsWith("vm_"));
      const allData = {};
      for (const key of allKeys) {
        const raw = GM_getValue(key, null);
        if (raw) allData[key] = JSON.parse(raw);
      }
      const json = JSON.stringify(allData, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `universal_marker_ALL_${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast(t("toast.exportFile", { n: allKeys.length }));
    };

    // Import All Sites
    modal.querySelector("#vmImportAll").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const allData = JSON.parse(ev.target.result);
            let count = 0;
            for (const [key, val] of Object.entries(allData)) {
              if (key.startsWith("vm_") && val) {
                GM_setValue(key, JSON.stringify(val));
                count++;
              }
            }
            const currentRaw = GM_getValue(STORAGE_KEY, null);
            if (currentRaw) {
              const parsed = JSON.parse(currentRaw);
              Object.assign(DATA, parsed);
              pattern = buildPattern();
              renderLists();
            }
            showToast(t("toast.imported", { n: count }));
          } catch (err) {
            showToast(t("toast.errorPrefix") + err.message, true);
          }
        };
        reader.readAsText(e.target.files[0]);
      };
      input.click();
    };

    // Refresh
    modal.querySelector("#vmRefresh").onclick = () => location.reload();

    // ========== LICENSE (модалка) ==========
    function showLicense() {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;pointer-events:auto;";
      overlay.innerHTML = `
        <div style="width:380px;max-width:90vw;background:linear-gradient(160deg,#1a1a2e,#16213e);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:20px;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.55;box-shadow:0 24px 80px rgba(0,0,0,0.6);">
          <div style="font-size:15px;font-weight:700;color:#fff;margin:0 0 10px;">${t("lic.title")}</div>
          <p style="margin:0 0 10px">
            <strong>CC BY-NC-ND 4.0</strong><br/>
            Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International
          </p>
          <div style="margin:0 0 10px;font-size:12px">
            <div style="margin:3px 0">${t("lic.free")}</div>
            <div style="margin:3px 0">${t("lic.share")}</div>
            <div style="margin:3px 0">${t("lic.commercial")}</div>
            <div style="margin:3px 0">${t("lic.derivatives")}</div>
          </div>
          <p style="margin:0 0 14px;font-size:11px;color:#888">
            ${t("lic.commercialNote")}
          </p>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="vm-btn vm-btn-ghost" data-license="full">${t("lic.full")}</button>
            <button class="vm-btn vm-btn-primary" data-license="close">${t("ui.ok")}</button>
          </div>
        </div>`;
      shadow.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('[data-license="close"]').addEventListener("click", close);
      overlay.querySelector('[data-license="full"]').addEventListener("click", () => {
        window.open("https://github.com/Vidrimers/Universal-marker/blob/master/LICENSE", "_blank");
      });
    }

    // Bug report — тело issue подставляется на языке интерфейса
    function openBugReport() {
      const ver =
        (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) ||
        CURRENT_VERSION;
      const body = encodeURIComponent(
        [
          t("bug.version") + ver,
          t("bug.browser"),
          "",
          t("bug.steps"),
          "1. ",
          "2. ",
          "",
          t("bug.expected"),
          "",
          t("bug.actual"),
          "",
          t("bug.extra"),
          "- ",
        ].join("\n"),
      );
      window.open(
        "https://github.com/Vidrimers/Universal-marker/issues/new?title=" +
          encodeURIComponent(t("bug.title")) +
          "&body=" +
          body,
        "_blank",
      );
    }
    modal.querySelector("#vmReport").onclick = () => openBugReport();

    // License
    modal.querySelector("#vmLicenseLink").onclick = (e) => {
      e.preventDefault();
      showLicense();
    };

    // восстановление состояния панели после перезагрузки (для каждого сайта своё)
    if (DATA.settings.uiOpen) openModal();
  }

  // ========== ЗАПУСК ==========

  // На Steam используем g_rgProfileData для определения ID (работает для vanity URL)
  function getEffectiveUserId() {
    if (location.hostname.includes("steamcommunity.com")) {
      try {
        const pd = unsafeWindow.g_rgProfileData;
        if (pd && pd.steamid) return pd.steamid;
      } catch (e) {}
    }
    return getUserIdFromUrl();
  }

  const userId = getEffectiveUserId();
  if (userId && DATA.profileMessages[userId]) {
    setTimeout(() => showCenterMessage(DATA.profileMessages[userId]), 300);
  }

  // Синхронизируем ники Steam (проверяем переименования) — потом запускаем подсветку
  syncSteamNicks(() => {
    processNode(document.body);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (el && el.closest(`[${MARKER_ATTR}]`)) continue;
        processNode(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  createUI();
})();