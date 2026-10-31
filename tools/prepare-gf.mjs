#!/usr/bin/env node
// Генератор публичной копии скрипта для Greasy Fork и других площадок.
//
//   node tools/prepare-gf.mjs
//
// Читает universal.user.js (оригинал НЕ изменяется) и пишет
// gf/universal.public.user.js с правками под правила хостингов:
//   1. без @updateURL / @downloadURL — запрещены альтернативные источники загрузки;
//   2. без внутреннего апдейтера — его кнопка ведёт на GitHub raw;
//   3. @description только на английском;
//   4. строка «Версия скрипта» в настройках — с пояснением о публичной сборке.
//
// Папка gf/ в .gitignore — файл для загрузки не попадает в git.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "universal.user.js");
const outDir = join(root, "gf");
const out = join(outDir, "universal.public.user.js");

let text = readFileSync(src, "utf8");
const originalLength = text.length;
const log = [];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// CRLF-толерантный шаблон из строк (в файле могут быть и \r\n, и \n)
const linesRe = (lines) => lines.map(escRe).join("\r?\n");

function cut(pattern, label) {
  const next = text.replace(pattern, "");
  if (next === text) {
    console.warn(`⚠️  не найдено (пропущено): ${label}`);
  } else {
    log.push(label);
    text = next;
  }
}

function replace(pattern, replacement, label) {
  const next = text.replace(pattern, replacement);
  if (next === text) {
    console.warn(`⚠️  не найдено (пропущено): ${label}`);
  } else {
    log.push(label);
    text = next;
  }
}

// 1) шапка: альтернативные источники загрузки
cut(/^\/\/ @updateURL[^\n]*\r?\n/gm, "@updateURL");
cut(/^\/\/ @downloadURL[^\n]*\r?\n/gm, "@downloadURL");

// 2) @description — только английская часть (до " / ")
replace(
  /^(\/\/ @description\s+[^\n]*?)\s*\/\s*[^\n]*\n/gm,
  "$1\n",
  "@description → EN",
);

// 3) плашки обновления в HTML (их в шаблоне две — с дублирующимися id)
cut(
  new RegExp(
    linesRe([
      '    <div id="vmUpdateBanner" class="vm-update-banner" style="display:none;">',
      '    <span id="vmUpdateText"></span>',
      '    <button id="vmUpdateBtn" class="vm-update-btn">${t("upd.update")}</button>',
      "  </div>",
    ]) + "\r?\n",
    "",
  ),
  "плашка обновления (верхняя)",
);
cut(
  new RegExp(
    linesRe([
      '            <div id="vmUpdateBanner" style="display:none;" class="vm-update-banner">',
      '                <span id="vmUpdateText"></span>',
      '                <button class="vm-update-btn" id="vmUpdateBtn">${t("upd.install")}</button>',
      "            </div>",
      "",
    ]) + "\r?\n",
    "",
  ),
  "плашка обновления (нижняя)",
);

// 4) вызов checkForUpdates() в openModal
cut(/\r?\n\s*checkForUpdates\(\);/g, "вызов checkForUpdates()");

// 5) строка настроек «Версия скрипта» → версия + пояснение о публичной сборке
const settingsRowRe = new RegExp(
  linesRe([
    '                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">',
    '                    <span class="vm-setting-label">${t("set.version")} <strong style="color:#a3b1ff;" id="vmCurrentVersion"></strong></span>',
    '                    <button class="vm-btn vm-btn-ghost" id="vmCheckUpdate" style="font-size:11px;padding:4px 10px;">${t("upd.check")}</button>',
    "                </div>",
  ]),
  "",
);
const settingsRowNew = [
  '                <div class="vm-setting-row" style="border-bottom:none;margin-top:14px;">',
  '                    <span class="vm-setting-label">${t("set.version")} <strong style="color:#a3b1ff;" id="vmCurrentVersion"></strong></span>',
  '                    <span style="font-size:10px;color:#666;flex:1;min-width:0;text-align:right;">${t("set.publicNote")}</span>',
  "                </div>",
].join("\n");
replace(settingsRowRe, settingsRowNew, "строка «Версия скрипта» → пояснение о публичной сборке");

// 6) блок «ПРОВЕРКА ОБНОВЛЕНИЙ» — вырезается целиком, остаётся CURRENT_VERSION
//    и вставка версии в настройки. Границы — секционные комментарии.
const startMark = "    // ========== ПРОВЕРКА ОБНОВЛЕНИЙ ==========";
const endMark = "    // Tabs";
const s = text.indexOf(startMark);
const e = text.indexOf(endMark);
if (s === -1 || e === -1 || e < s) {
  console.error("❌ не найдены границы блока апдейтера — вырезание отменено");
  process.exit(1);
}
const version = (text.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || "0.0.0";
const replacement =
  startMark + "\n" +
  "    // (для Greasy Fork вырезано: апдейтер и адреса GitHub не публикуются)\n" +
  "    const CURRENT_VERSION =\n" +
  "      (typeof GM_info !== \"undefined\" && GM_info.script && GM_info.script.version) ||\n" +
  `      "${version}";\n\n` +
  "    // Вставляем текущую версию в настройки\n" +
  "    const verEl = modal.querySelector(\"#vmCurrentVersion\");\n" +
  "    if (verEl) verEl.textContent = CURRENT_VERSION;\n\n";
text = text.slice(0, s) + replacement + text.slice(e);
log.push(`блок апдейтера (${e - s} символов → константа CURRENT_VERSION)`);

mkdirSync(outDir, { recursive: true });
writeFileSync(out, text, "utf8");
console.log(`✔ gf/universal.public.user.js (${originalLength} → ${text.length} символов)`);
console.log("  вырезано:");
for (const l of log) console.log("   - " + l);

// ── Самопроверка ──
let failed = false;

// 6a) синтаксис
try {
  execFileSync(process.execPath, ["--check", out], { stdio: "pipe" });
  console.log("✔ node --check — синтаксис в порядке");
} catch (err) {
  console.error("❌ node --check провалился:\n" + err.stderr);
  failed = true;
}

// 6b) запрещённые вхождения должны отсутствовать
const final = readFileSync(out, "utf8");
const banned = [
  ["raw.githubusercontent", "ссылка на GitHub raw"],
  ["api.github.com", "ссылка на GitHub API"],
  ["cdn.jsdelivr.net", "ссылка на jsDelivr"],
  ["@updateURL", "@updateURL"],
  ["@downloadURL", "@downloadURL"],
  ["checkForUpdates", "апдейтер (checkForUpdates)"],
  ["vmUpdateBanner", "плашка обновления"],
  ["vmCheckUpdate", "кнопка проверки обновлений"],
  ["INSTALL_URL", "адрес установки"],
];
for (const [needle, label] of banned) {
  if (final.includes(needle)) {
    console.error(`❌ осталось запрещённое вхождение: ${label} (${needle})`);
    failed = true;
  }
}
if (!failed) console.log("✔ запрещённых вхождений нет");

process.exit(failed ? 1 : 0);
