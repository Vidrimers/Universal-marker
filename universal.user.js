// ==UserScript==
// @name         Universal Marker
// @namespace    https://github.com/Vidrimers/Universal-marker
// @version      6.6.7
// @description  Универсальная подсветка ников + надписи на профилях. Работает на любом сайте.
// @author       Vidrimers
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/Vidrimers/Universal-marker/refs/heads/master/universal.user.js
// @downloadURL  https://raw.githubusercontent.com/Vidrimers/Universal-marker/refs/heads/master/universal.user.js
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
      },
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
    const low = nick.toLowerCase();
    for (const [k, v] of Object.entries(DATA.nicknames)) {
      if (k.toLowerCase() === low) {
        if (typeof v === "string") return { label: v, color: null, note: "" };
        return v;
      }
    }
    return null;
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
    return new RegExp(escaped.join("|"), "giu");
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

    const lower = text.toLowerCase();
    const hasMatch = Object.keys(DATA.nicknames).some((k) =>
      lower.includes(k.toLowerCase()),
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

    // ===== Overlay =====
    const overlay = document.createElement("div");
    overlay.className = "vm-overlay";
    shadow.appendChild(overlay);

    // ===== Modal =====
    const modal = document.createElement("div");
    modal.className = "vm-modal";
    modal.innerHTML = `
    <div id="vmUpdateBanner" class="vm-update-banner" style="display:none;">
    <span id="vmUpdateText"></span>
    <button id="vmUpdateBtn" class="vm-update-btn">Обновить</button>
  </div>
            <div class="vm-header">
                <div class="vm-head-actions">
                    <button class="vm-head-btn" id="vmRefresh" title="Обновить">🔄</button>
                    <button class="vm-head-btn" id="vmReport" title="Багрепорт">🐛</button>
                    <button class="vm-close">&times;</button>
                </div>
                <h2>💀 Universal Marker <span class="vm-domain">${escapeHtml(DOMAIN)}</span></h2>
            </div>

            <div id="vmUpdateBanner" style="display:none;" class="vm-update-banner">
                <span id="vmUpdateText"></span>
                <button class="vm-update-btn" id="vmUpdateBtn">⬆️ Установить</button>
            </div>

            <div class="vm-tabs">
                <button class="vm-tab active" data-tab="nicks">👤 Ники</button>
                <button class="vm-tab" data-tab="profiles">💀 Профили</button>
                <button class="vm-tab" data-tab="settings">⚙️ Настройки</button>
                <button class="vm-tab" data-tab="help">? Помощь</button>
            </div>

            <div class="vm-tab-content active" data-tab="nicks">
                <div class="vm-search-wrap">
                    <input class="vm-search" id="vmNickSearch" placeholder="Поиск по нику или метке...">
                    <button class="vm-search-clear" id="vmNickSearchClear">✕</button>
                </div>
                <div class="vm-search-count" id="vmNickSearchCount"></div>
                <div class="vm-list" id="vmNickList"></div>
                <div class="vm-add-row-color">
                    <input class="vm-input" id="vmNewNick" placeholder="Ник">
                    <input class="vm-input" id="vmNewLabel" placeholder="Метка">
                    <input type="color" class="vm-color-pick" id="vmNewNickColor" title="Цвет метки (оставь дефолтный или выбери свой)">
                    <button class="vm-btn vm-btn-primary" id="vmAddNick">+</button>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
                    <div class="vm-presets-wrap">
                        <button class="vm-presets-btn" id="vmPresetsBtn">▾ Быстрые метки</button>
                        <div class="vm-presets-list" id="vmPresetsList"></div>
                    </div>
                    <button class="vm-bulk-toggle" id="vmBulkToggle">▼ Массовое добавление</button>
                </div>
                <div class="vm-bulk-section" id="vmBulkSection">
                    <div class="vm-bulk-row">
                        <input class="vm-input" id="vmBulkLabel" placeholder="Метка для всех ников (обязательно)">
                        <input type="color" class="vm-color-pick" id="vmBulkColor" title="Цвет метки">
                    </div>
                    <textarea class="vm-input" id="vmBulkNicks" placeholder="Ники — по одному на строку:&#10;Minor748&#10;ElSwanko&#10;suarog3&#10;..." rows="6"></textarea>
                    <div class="vm-bulk-counter" id="vmBulkCounter">0 / 100</div>
                    <button class="vm-btn vm-btn-primary" id="vmBulkAdd">➕ Добавить всех</button>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="profiles">
                <div class="vm-search-wrap">
                    <input class="vm-search" id="vmProfSearch" placeholder="Поиск по ID или тексту...">
                    <button class="vm-search-clear" id="vmProfSearchClear">✕</button>
                </div>
                <div class="vm-search-count" id="vmProfSearchCount"></div>
                <div class="vm-list" id="vmProfileList"></div>
                <div class="vm-add-row">
                    <input class="vm-input" id="vmNewProfId" placeholder="ID пользователя">
                    <input class="vm-input" id="vmNewProfText" placeholder="Текст надписи">
                    <button class="vm-btn vm-btn-primary" id="vmAddProf">+</button>
                </div>
                <div class="vm-presets-wrap" style="margin-top:6px;">
                    <button class="vm-presets-btn" id="vmProfPresetsBtn">▾ Быстрые метки</button>
                    <div class="vm-presets-list" id="vmProfPresetsList"></div>
                </div>
                <div id="vmSteamQuickAdd" style="display:none;margin-top:8px;">
                    <div style="padding:10px 12px;background:rgba(23,111,158,0.12);border:1px solid rgba(23,111,158,0.3);border-radius:10px;">
                        <div style="font-size:12px;color:#5dade2;margin-bottom:8px;">⚡ Страница Steam — данные определены автоматически</div>
                        <div style="font-size:11px;color:#666;margin-bottom:8px;" id="vmSteamDetectedId"></div>
                        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                            <input class="vm-input" id="vmSteamQuickText" placeholder="Метка для профиля" style="flex:1;">
                            <button class="vm-btn vm-btn-primary" id="vmSteamQuickBtn">➕ Профиль</button>
                        </div>
                        <div style="border-top:1px solid rgba(23,111,158,0.2);padding-top:8px;">
                            <div style="font-size:11px;color:#666;margin-bottom:6px;" id="vmSteamNickInfo"></div>
                            <div id="vmSteamNickRow" style="display:none;flex-direction:row;gap:8px;align-items:center;">
                                <input class="vm-input" id="vmSteamNickLabel" placeholder="Метка для ника" style="flex:1;">
                                <input type="color" class="vm-color-pick" id="vmSteamNickColor" title="Цвет метки" style="width:36px;height:32px;flex-shrink:0;">
                                <button class="vm-btn vm-btn-primary" id="vmSteamNickBtn">➕ Ник</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="settings">
                <div class="vm-setting-row">
                    <span class="vm-setting-label">Цвет метки ника</span>
                    <input type="color" class="vm-color-input" id="vmNickColor" value="${DATA.settings.nickColor}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">Цвет надписи (центр)</span>
                    <input type="color" class="vm-color-input" id="vmCenterColor" value="${DATA.settings.centerColor}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">Цвет рамки</span>
                    <input type="color" class="vm-color-input" id="vmCenterBorder" value="${DATA.settings.centerBorder}">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">Размер шрифта (центр)</span>
                    <input class="vm-input" id="vmCenterSize" value="${DATA.settings.centerSize}" style="width:80px;flex:unset;">
                </div>
                <div class="vm-setting-row">
                    <span class="vm-setting-label">Показывать всегда</span>
                    <input type="checkbox" id="vmShowForever" ${DATA.settings.showForever ? "checked" : ""}>
                </div>
                <div class="vm-setting-row" style="border-bottom:none;">
                    <span class="vm-setting-label">Паттерны URL для ID (по одному на строку)</span>
                </div>
                <textarea class="vm-input" id="vmPatterns" rows="3" style="resize:vertical;margin-top:6px;">${(DATA.settings.userIdPatterns || []).join("\n")}</textarea>
                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">
                    <span class="vm-setting-label">Версия скрипта: <strong style="color:#a3b1ff;" id="vmCurrentVersion"></strong></span>
                    <button class="vm-btn vm-btn-ghost" id="vmCheckUpdate" style="font-size:11px;padding:4px 10px;">🔍 Проверить обновления</button>
                </div>
                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">
                    <span class="vm-setting-label">Экспорт / Импорт</span>
                    <div style="display:flex;gap:6px;">
                        <button class="vm-btn vm-btn-success" id="vmExportAll">📥 Экспорт</button>
                        <button class="vm-btn vm-btn-warning" id="vmImportAll">📤 Импорт</button>
                    </div>
                </div>
            </div>

            <div class="vm-tab-content" data-tab="help">
                <div class="vm-help">
                    <h3>Как пользоваться</h3>
                    <p><strong style="color:#a3b1ff;">👤 Ники</strong> — подсветка ников на странице. Добавь ник и метку, и рядом с каждым упоминанием появится твой текст.</p>
                    <p class="vm-code">Пример: <strong>beex</strong> → <strong>scammer</strong><br>Результат: beex <span style="color:#ff4444;font-weight:bold;">(scammer)</span></p>
                    <p style="margin-top:12px;"><strong style="color:#a3b1ff;">💀 Профили</strong> — большая надпись по центру при заходе на профиль. Укажи ID и текст.</p>
                    <p class="vm-code">Пример: ID <strong>1179730</strong> → <strong>ЕБЛАН</strong><br>При открытии /seller/beex/1179730 появится надпись</p>
                    <p style="margin-top:12px;"><strong style="color:#a3b1ff;">⚙️ Паттерны URL</strong> — regex для извлечения ID.<br>
                    Если в паттерне несколько групп — берётся последняя.<br>
                    Для plati.market: <code style="background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;">/seller/[^/]+/(\d+)</code></p>
                    <p style="margin-top:12px;"><strong style="color:#a3b1ff;">📥📤 Экспорт/Импорт</strong> — бэкап всех сайтов одним файлом.</p>
                    <p style="margin-top:8px;color:#666;font-size:11px;">Данные в Tampermonkey (GM_storage), не пропадут при очистке кук.</p>
                </div>
            </div>

            <div style="margin-top:10px;text-align:center;">
                <a class="vm-donate-link" href="https://vidrimers.online/donate" target="_blank" rel="noopener">Поддержать проект</a>
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
    window.addEventListener("resize", () => {
      if (modal.classList.contains("open")) applyWinPos();
      applyFabPos();
    });

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
        return;
      }
      const x = Math.round((saved.xPct / 100) * window.innerWidth);
      const y = Math.round((saved.yPct / 100) * window.innerHeight);
      const p = clampFabPos(x, y);
      fab.style.left = p.x + "px";
      fab.style.top = p.y + "px";
      fab.style.bottom = "auto";
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
        const p = clampFabPos(origX + dx, origY + dy);
        fab.style.left = p.x + "px";
        fab.style.top = p.y + "px";
        fab.style.bottom = "auto";
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
          saveFabPos();
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
    const fabObserver = new MutationObserver(() => {
      if (!document.documentElement.contains(host)) {
        document.documentElement.appendChild(host);
      }
    });
    fabObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // ========== TOAST (внутри Shadow DOM) ==========
    function showToast(msg, isError = false) {
      const old = shadow.querySelector(".vm-toast");
      if (old) old.remove();
      const t = document.createElement("div");
      t.className = "vm-toast" + (isError ? " error" : "");
      t.textContent = msg;
      shadow.appendChild(t);
      requestAnimationFrame(() => t.classList.add("show"));
      setTimeout(() => {
        t.classList.remove("show");
        setTimeout(() => t.remove(), 300);
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
      checkForUpdates();
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
        nickInfo.textContent = `Текущий ник: ${currentNick}`;
        nickInfo.style.color = "#a3b1ff";
        nickColor.value = DATA.settings.nickColor;
        nickRow.style.display = "flex";
      }

      function switchTab(tabName) {
        modal.querySelectorAll(".vm-tab").forEach((t) => t.classList.remove("active"));
        modal.querySelectorAll(".vm-tab-content").forEach((t) => t.classList.remove("active"));
        modal.querySelector(`.vm-tab[data-tab='${tabName}']`).classList.add("active");
        modal.querySelector(`.vm-tab-content[data-tab='${tabName}']`).classList.add("active");
      }

      // ── Добавить профиль ──
      quickBtn.onclick = () => {
        const text = quickText.value.trim();
        if (!text) return showToast("Укажи метку для профиля", true);
        const exists = !!DATA.profileMessages[steamId64];
        DATA.profileMessages[steamId64] = text;
        saveData(DATA);
        quickText.value = "";
        renderLists();
        switchTab("profiles");
        showToast(exists ? "Профиль обновлён" : "Профиль добавлен");
      };

      // ── Добавить ник (с steamId64 для мониторинга + заметка со ссылкой) ──
      if (nickBtn) {
        nickBtn.onclick = () => {
          if (!currentNick) return showToast("Ник недоступен", true);
          const label = nickLabel.value.trim();
          if (!label) return showToast("Укажи метку для ника", true);
          const color = nickColor.value;
          const exists = Object.keys(DATA.nicknames).some(
            (k) => k.toLowerCase() === currentNick.toLowerCase()
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
          showToast(exists ? `⚠️ Метка "${currentNick}" обновлена` : `✓ Ник "${currentNick}" добавлен`);
        };
      }
    })();

    // ========== ПРОВЕРКА ОБНОВЛЕНИЙ ==========
    const CURRENT_VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "6.6.7"; // берётся из @version шапки
    const UPDATE_URL =
      "https://raw.githubusercontent.com/Vidrimers/Universal-marker/refs/heads/master/universal.user.js";
    const INSTALL_URL =
      "https://raw.githubusercontent.com/Vidrimers/Universal-marker/refs/heads/master/universal.user.js";
    const UPDATE_CHECK_KEY = "vm_update_last_check";
    const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // раз в сутки

    function parseVersion(str) {
      // "6.5.1" → [6, 5, 1]
      return str.trim().split(".").map(Number);
    }

    function isNewer(remote, current) {
      const r = parseVersion(remote);
      const c = parseVersion(current);
      for (let i = 0; i < Math.max(r.length, c.length); i++) {
        const rv = r[i] || 0,
          cv = c[i] || 0;
        if (rv > cv) return true;
        if (rv < cv) return false;
      }
      return false;
    }

    function showUpdateBanner(remoteVersion) {
      try {
        const banner = modal.querySelector("#vmUpdateBanner");
        const text = modal.querySelector("#vmUpdateText");
        const btn = modal.querySelector("#vmUpdateBtn");
        if (!banner || !text || !btn) return; // защита от null
        text.textContent = `🆕 Доступно обновление: v${CURRENT_VERSION} → v${remoteVersion}`;
        banner.style.display = "flex";
        btn.onclick = () => window.open(INSTALL_URL, "_blank");
      } catch (e) {
        console.warn("[Marker] Ошибка показа баннера:", e);
      }
    }

    // Вставляем текущую версию в настройки
    const verEl = modal.querySelector("#vmCurrentVersion");
    if (verEl) verEl.textContent = CURRENT_VERSION;

    // Кнопка принудительной проверки
    modal.querySelector("#vmCheckUpdate").onclick = () => {
      const btn = modal.querySelector("#vmCheckUpdate");
      btn.textContent = "⏳ Проверяем...";
      btn.disabled = true;
      // Сбрасываем кеш чтобы force сработал чисто
      GM_setValue(UPDATE_CHECK_KEY, 0);
      checkForUpdates(true);
      setTimeout(() => {
        btn.textContent = "🔍 Проверить обновления";
        btn.disabled = false;
        // Если плашка не появилась — значит обновлений нет
        const banner = modal.querySelector("#vmUpdateBanner");
        if (banner && banner.style.display === "none") {
          showToast("✓ Обновлений нет, версия актуальна");
        }
      }, 3000);
    };

    function checkForUpdates(force = false) {
      const lastCheck = GM_getValue(UPDATE_CHECK_KEY, 0);
      const now = Date.now();
      if (!force && now - lastCheck < UPDATE_CHECK_INTERVAL) return;
      GM_xmlhttpRequest({
        method: "GET",
        url: UPDATE_URL + "?_=" + now, // cache bust
        timeout: 8000,
        onload(resp) {
          if (resp.status !== 200) return;
          const match = resp.responseText.match(/\/\/ @version\s+([^\s]+)/);
          if (!match) return;
          const remoteVersion = match[1];
          GM_setValue(UPDATE_CHECK_KEY, now);
          if (isNewer(remoteVersion, CURRENT_VERSION)) {
            showUpdateBanner(remoteVersion);
          }
        },
        onerror() {}, // тихо, не мешаем работе
        ontimeout() {},
      });
    }

    // Tabs
    modal.querySelectorAll(".vm-tab").forEach((tab) => {
      tab.onclick = () => {
        modal
          .querySelectorAll(".vm-tab")
          .forEach((t) => t.classList.remove("active"));
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
        nickCountEl.textContent = `Найдено: ${filteredNicks.length} из ${allNicks.length}`;
      } else {
        nickCountEl.textContent = allNicks.length
          ? `Всего: ${allNicks.length}`
          : "";
      }

      // Счётчик для профилей
      const profCountEl = modal.querySelector("#vmProfSearchCount");
      if (profQ) {
        profCountEl.textContent = `Найдено: ${filteredProfs.length} из ${allProfs.length}`;
      } else {
        profCountEl.textContent = allProfs.length
          ? `Всего: ${allProfs.length}`
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
                            <span class="vm-nick-color-dot" style="background:${escapeHtml(color)}"></span><strong>${escapeHtml(nick)}</strong><span class="vm-arrow">→</span>${escapeHtml(d.label)}${hasNote ? `<button class="vm-note-dot" data-note-nick="${escapeHtml(nick)}" title="Заметка">✎</button>` : `<button class="vm-note-dot vm-note-add" data-note-nick="${escapeHtml(nick)}" title="Добавить заметку" style="opacity:0.35;">+</button>`}
                        </span>
                        <span class="vm-item-actions">
                            <button class="vm-edit-btn" data-nick="${escapeHtml(nick)}" data-label="${escapeHtml(d.label)}" data-color="${escapeHtml(color)}">✎</button>
                            <button class="vm-delete-btn" data-nick="${escapeHtml(nick)}">✕</button>
                        </span>
                    </div>
                    <div class="vm-note-panel" data-note-panel="${escapeHtml(nick)}">
                        <textarea placeholder="Заметка о нике...">${escapeHtml(d.note || "")}</textarea>
                        <button class="vm-btn vm-btn-primary vm-note-save" data-save-nick="${escapeHtml(nick)}">✓</button>
                    </div>
                </div>
            `;
          })
          .join("") ||
        `<div style="padding:12px;text-align:center;color:#555;">${nickQ ? "Ничего не найдено" : "Пусто"}</div>`;

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
        `<div style="padding:12px;text-align:center;color:#555;">${profQ ? "Ничего не найдено" : "Пусто"}</div>`;

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
            <input class="vm-input vm-edit-nick" value="${escapeHtml(oldNick)}" placeholder="Ник" style="flex:1;min-width:80px;">
            <input class="vm-input vm-edit-label" value="${escapeHtml(oldLabel)}" placeholder="Метка" style="flex:1;min-width:80px;">
            <input type="color" class="vm-color-pick vm-edit-color" value="${escapeHtml(oldColor)}" title="Цвет" style="width:36px;height:32px;flex-shrink:0;">
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
              return showToast("Заполните оба поля", true);
            delete DATA.nicknames[oldNick];
            DATA.nicknames[newNick] = {
              label: newLabel,
              color: newColor,
              note: oldNote,
            };
            saveData(DATA);
            pattern = buildPattern();
            renderLists();
            showToast("✓ Изменено");
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
          showToast(note ? "✓ Заметка сохранена" : "✓ Заметка удалена");
        };
      });

      // Profile edit handlers
      profList.querySelectorAll(".vm-edit-btn").forEach((btn) => {
        btn.onclick = () => {
          const oldId = btn.dataset.prof;
          const oldLabel = btn.dataset.label;
          btn.closest(".vm-list-item").outerHTML = `
                        <div class="vm-edit-row" data-editing-prof="${escapeHtml(oldId)}">
                            <input class="vm-input vm-edit-id" value="${escapeHtml(oldId)}" placeholder="ID">
                            <input class="vm-input vm-edit-text" value="${escapeHtml(oldLabel)}" placeholder="Текст">
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
              return showToast("Заполните оба поля", true);
            delete DATA.profileMessages[oldId];
            DATA.profileMessages[newId] = newText;
            saveData(DATA);
            renderLists();
            showToast("✓ Изменено");
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
          showToast("Удалено");
        };
      });
      profList.querySelectorAll(".vm-delete-btn").forEach((btn) => {
        btn.onclick = () => {
          delete DATA.profileMessages[btn.dataset.prof];
          saveData(DATA);
          renderLists();
          showToast("Удалено");
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
      if (!nick || !label) return showToast("Заполните оба поля", true);
      const exists = Object.keys(DATA.nicknames).some(
        (k) => k.toLowerCase() === nick.toLowerCase(),
      );
      const oldNote = exists ? (getNickData(nick) || {}).note || "" : "";
      DATA.nicknames[nick] = { label, color, note: oldNote };
      saveData(DATA);
      pattern = buildPattern();
      modal.querySelector("#vmNewNick").value = "";
      modal.querySelector("#vmNewLabel").value = "";
      // color picker остаётся — удобно добавлять несколько ников с одним цветом
      renderLists();
      showToast(exists ? `⚠️ Метка "${nick}" обновлена` : "✓ Ник добавлен");
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
          '<div style="padding:8px 10px;font-size:12px;color:#555;">Нет сохранённых меток</div>';
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
          '<div style="padding:8px 10px;font-size:12px;color:#555;">Нет сохранённых меток</div>';
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
      btn.textContent = isOpen
        ? "▲ Массовое добавление"
        : "▼ Массовое добавление";
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
      if (!label) return showToast("Укажите метку для ников", true);
      const lines = bulkNicksTA.value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return showToast("Список ников пуст", true);
      if (lines.length > MAX_BULK)
        return showToast(`Максимум ${MAX_BULK} ников за раз`, true);
      const bulkColor = modal.querySelector("#vmBulkColor").value;
      let added = 0,
        updated = 0;
      for (const nick of lines) {
        const exists = Object.keys(DATA.nicknames).some(
          (k) => k.toLowerCase() === nick.toLowerCase(),
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
      if (added) parts.push(`добавлено ${added}`);
      if (updated) parts.push(`⚠️ обновлено ${updated}`);
      showToast(`✓ ${parts.join(", ")}`);
    };

    // Add profile
    modal.querySelector("#vmAddProf").onclick = () => {
      const id = modal.querySelector("#vmNewProfId").value.trim();
      const text = modal.querySelector("#vmNewProfText").value.trim();
      if (!id || !text) return showToast("Заполните оба поля", true);
      DATA.profileMessages[id] = text;
      saveData(DATA);
      modal.querySelector("#vmNewProfId").value = "";
      modal.querySelector("#vmNewProfText").value = "";
      renderLists();
      showToast("✓ Профиль добавлен");
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
      showToast("✓ Настройки сохранены");
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
      showToast(`💾 Сохраните файл (${allKeys.length} сайтов)...`);
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
            showToast(`✓ Импортировано ${count} сайтов! Обновите страницу.`);
          } catch (err) {
            showToast("Ошибка: " + err.message, true);
          }
        };
        reader.readAsText(e.target.files[0]);
      };
      input.click();
    };

    // Refresh
    modal.querySelector("#vmRefresh").onclick = () => location.reload();

    // Bug report
    modal.querySelector("#vmReport").onclick = () =>
      window.open(
        "https://github.com/Vidrimers/Universal-marker/issues/new?assignees=&labels=bug%2C+needs+triage%2C+universal-marker&template=bug_report.md&title=%5BBUG%5D+%3Cкраткое+описание+проблемы%3E",
        "_blank",
      );

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