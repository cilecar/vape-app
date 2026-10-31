import { useState, useEffect, useMemo, useRef, createContext, useContext } from "react";
import { flushSync } from "react-dom";
import { Preferences } from "@capacitor/preferences";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";

/* ── storage ── */
// ключи, которые не удалось даже прочитать: в эту сессию их не перезаписываем
const unread = new Set();
const isObj = v => !!v && typeof v==="object" && !Array.isArray(v);
// испорченное значение (не json или не той формы — ok) не затираем молча: перед тем как
// работать с умолчанием, откладываем копию рядом (ключ_broken), её можно достать руками
async function readJSON(key, d, ok = isObj) {
  let value;
  try { ({ value } = await Preferences.get({ key })); }
  catch { unread.add(key); return d; }
  if (!value) return d;
  try { const v = JSON.parse(value); if (ok(v)) return v; } catch {}
  await Preferences.set({ key: key+"_broken", value }).catch(()=>{});
  return d;
}
// списка нет или он испорчен — собираем заново по ключам самих карточек, иначе они пропадут из приложения
async function getIds(idsKey) {
  const ids = await readJSON(idsKey, null, Array.isArray);
  if (ids) return ids;
  const { key } = Object.values(TYPES).find(t => t.idsKey===idsKey);
  const { keys } = await Preferences.keys();
  const found = keys.filter(k => k.startsWith(key)).map(k => k.slice(key.length));
  // сохраняем, чтобы не собирать заново на каждом запуске; не прочитавшийся список не трогаем
  if (!unread.has(idsKey)) await setIds(idsKey, found);
  return found;
}
async function setIds(idsKey, ids) {
  await Preferences.set({ key: idsKey, value: JSON.stringify(ids) });
}
// список id меняем строго по очереди: иначе параллельные save/remove читают один и тот же
// список, и последний затирает изменение другого
let idsQueue = Promise.resolve();
const updateIds = (idsKey, fn) => {
  const job = idsQueue.then(async () => {
    const ids = await getIds(idsKey), next = fn(ids);
    if (next!==ids) await setIds(idsKey, next);
  });
  idsQueue = job.catch(()=>{});
  return job;
};
// возвращает то, что записано: новое фото в нём уже путём к файлу, а не data:-url
const save = async (l, type) => {
  const { key, idsKey } = TYPES[type];
  const s = await storePhoto(l);
  const old = await readJSON(key + l.id, null);
  await Preferences.set({ key: key + l.id, value: JSON.stringify(s) });
  // фото заменили или убрали — старый файл больше не нужен
  if (old?.photo!==s.photo) dropPhoto(old?.photo);
  await updateIds(idsKey, ids => ids.includes(l.id) ? ids : [...ids, l.id]);
  return s;
};
const remove = async (id, type) => {
  const { key, idsKey } = TYPES[type];
  const old = await readJSON(key + id, null);
  await Preferences.remove({ key: key + id });
  dropPhoto(old?.photo);
  await updateIds(idsKey, ids => ids.filter(x => x !== id));
};
async function loadAll(type) {
  const { key, idsKey } = TYPES[type];
  try {
    const ids = await getIds(idsKey);
    const items = (await Promise.all(ids.map(async id => {
      try { const { value } = await Preferences.get({ key: key + id }); return value ? JSON.parse(value) : null; }
      catch { return null; }
    }))).filter(Boolean);
    // старые карточки: фото из data:-url — в файл; один раз и по одной, чтобы не держать все в памяти
    if (NATIVE) for (const [i, l] of items.entries()) if (l.photo?.startsWith("data:")) {
      try {
        const s = await storePhoto(l);
        await Preferences.set({ key: key + l.id, value: JSON.stringify(s) });
        items[i] = s;
      } catch {}
    }
    return items;
  } catch { return []; }
}

/* ── photos ── */
// На телефоне фото — отдельные файлы в Data/photos, в карточке только путь «photos/….jpg»:
// base64 в Preferences раздувал файл настроек, который Android читает в память целиком.
// В вебе (разработка) и в данных до переноса — data:-url прямо в карточке
const PHOTO_DIR = "photos";
const isPhotoFile = p => typeof p==="string" && /^photos\/[\w-]+\.(jpg|png|webp|gif)$/.test(p);
let photoBase = ""; // file:///…/files, известен после initPhotos
const photoSrc = p => isPhotoFile(p) ? Capacitor.convertFileSrc(`${photoBase}/${p}`) : p;
async function initPhotos() {
  if (NATIVE) photoBase = (await Filesystem.getUri({ path: "", directory: Directory.Data })).uri.replace(/\/$/, "");
}
// карточку с тем же новым фото могут сохранить ещё раз до того, как в состоянии появился путь
// (например, звёздочка сразу после сохранения), — тогда не плодим второй файл
const lastWritten = new Map(); // id карточки → {data, path}
async function storePhoto(l) {
  if (!NATIVE || !l.photo?.startsWith("data:")) return l;
  const w = lastWritten.get(l.id);
  if (w?.data===l.photo) return { ...l, photo: w.path };
  const ext = { "image/png":"png", "image/webp":"webp", "image/gif":"gif" }[l.photo.slice(5, l.photo.indexOf(";"))] || "jpg";
  const path = `${PHOTO_DIR}/${l.id}-${uid()}.${ext}`;
  await Filesystem.writeFile({ path, data: l.photo.slice(l.photo.indexOf(",")+1), directory: Directory.Data, recursive: true });
  lastWritten.set(l.id, { data: l.photo, path });
  return { ...l, photo: path };
}
const dropPhoto = p => { if (isPhotoFile(p)) Filesystem.deleteFile({ path: p, directory: Directory.Data }).catch(()=>{}); };

/* ── config ── */
// тексты — в словаре L ниже; здесь только то, что не зависит от языка
const TYPES = {
  vape: { key: "liq:", idsKey: "liq_ids", showNicotine: true, criteria: ["taste","feel","accuracy","fatigue","repeat"] },
  sticks: { key: "stk:", idsKey: "stk_ids", showNicotine: false, criteria: ["taste","feel","smell","aftertaste","repeat"] },
};

const STATUSES = {
  have: { color: "#4caf50" },
  want: { color: "#ff9800" },
  out:  { color: "#757575" },
};

/* ── i18n ── */
const plural = (n, [one, few, many]) => {
  const a = Math.abs(n)%100, b = a%10;
  return a>10&&a<20 ? many : b===1 ? one : b>=2&&b<=4 ? few : many;
};
const L = {
  ru: {
    locale: "ru",
    back: "← Назад", settings: "Настройки", edit: "Редактировать", save: "Сохранить", del: "Удалить",
    cancel: "✕ Отмена", loading: "Загрузка…", search: "Поиск…", fav: "★ Избранные",
    empty: "Пока пусто", notFound: "Ничего не найдено", noBrand: "Без бренда",
    cmpPick: "Выбери для сравнения", cmpGo: "Сравнить →", cmpSel: n => `Выбрано ${n} из 2`,
    "st.have": "В наличии", "st.want": "Хочу попробовать", "st.out": "Закончилось",
    "tab.tracker": "Счётчик", "title.tracker": "СЧЁТЧИК",
    sticksWord: n => plural(n, ["стик","стика","стиков"]),
    weekdays: ["вс","пн","вт","ср","чт","пт","сб"], todayShort: "сег",
    // счётчик
    todayN: n => `${L.ru.sticksWord(n)} сегодня`, yest: n => `вчера ${n}`, perDay: v => ` · в среднем ${v} в день`,
    endsToday: "кончится сегодня", lastsDays: d => `хватит ≈ на ${d} дн.`,
    deletedSticks: "Удалённые стики", openedAt: d => `открыта ${d}`, ofN: n => `из ${n}`,
    plusOne: "+1 стик", packOut: "Пачка кончилась — открыть новую", enterLeft: "Ввести остаток",
    newPack: "Новая пачка", cancelPack: "Отменить открытие этой пачки",
    noPack: "Пачка не открыта", noPackHint: "Выбери стики — дальше отмечай по штуке или вечером вводи, сколько осталось",
    openPack: "Открыть пачку",
    remindAsk: "Напоминать вечером?",
    remindAskHint: t => `Каждый день в ${t} придёт уведомление — вводишь, сколько осталось в пачке, прямо из шторки.`,
    enable: "Включить", noThanks: "Не надо",
    secToday: "Сегодня", nothingYet: "Пока ничего не отмечено", days14: "14 дней",
    nothingDay: "В этот день ничего не отмечено", vsAvg: d => `${d} к среднему`,
    "kind.left": "по остатку", "kind.finish": "докурил пачку",
    avg7: "Ср. за 7 дн", avg30: "Ср. за 30 дн", maxDay: "Макс за день", total: "Всего", packs: "Пачек", spent30: "Потрачено 30 дн",
    howMany: "Сколько осталось?", byRecords: (name, left, size) => `${name} · по записям ${left} из ${size}`,
    leftHint: "Разница запишется как выкуренное сейчас.",
    addSticksFirst: "Сначала добавь стики во вкладке «Стики» — потом выбирай их здесь.",
    whichSticks: "Какие стики открыл?", lastPack: "прошлая пачка", pcs: "Штук",
    packPrice: c => `Цена пачки, ${c}`, optional: "необязательно",
    finishOld: (name, n) => `${name} докурил — записать оставшиеся ${n} шт`,
    openPacks: "Открытые пачки", leftOf: (n, size) => `осталось ${n} из ${size}`,
    finishPack: "Закончить пачку", finishAsk: n => `Записать оставшиеся ${n} шт как выкуренные и закрыть пачку?`,
    // настройки
    look: "Оформление", theme: "Тема", dark: "Тёмная", light: "Светлая", lang: "Язык",
    currency: "Валюта", currencyHint: "Меняется только значок — введённые цены не пересчитываются по курсу",
    remind: "Напоминание", remindTitle: "Каждый вечер спрашивать остаток",
    remindNative: "Ответить можно прямо из уведомления", remindWeb: "Работает только в приложении на телефоне", test: "Проверить",
    backup: "Резервная копия", backupHint: "Жижи, стики, фото, счётчик и настройки — в одном файле",
    backupSave: "Сохранить бэкап", backupShare: "Отправить файл", restore: "Восстановить из файла",
    backupSaved: p => `Сохранено: ${p}`, backupFail: "Не удалось сохранить: ",
    restoreAsk: d => `Все текущие данные заменятся данными из бэкапа${d?" от "+d:""}. Продолжить?`,
    restoreBad: "Это не файл бэкапа этого приложения", restoreFail: "Не удалось восстановить: ", shareFail: "Не удалось отправить: ",
    ai: "ИИ-распознавание", aiTitle: "Заполнять карточку через Gemini", aiHint: "По названию находит бренд, вкус, объём и крепость",
    aiKey: "Ключ Gemini API", aiKeyHint: "Получить бесплатно: aistudio.google.com/apikey. Ключ хранится на телефоне. В сохранённый бэкап он попадает, в отправленный файл — нет",
    aiKeyEmpty: "Ключ не указан — поиск в интернете при добавлении отключён",
    aiKeyChecking: "Проверяю ключ…", aiKeyOk: "✓ Ключ работает", aiKeyBad: "Ключ не подходит: ", aiKeyNet: "Не удалось проверить — нет связи с Google",
    aiOff: "ИИ-поиск выключен в настройках", aiNoKey: "Нет ключа Gemini — добавь его в настройках",
    // сравнение
    need2: "Нужно 2 позиции", compare: "Сравнение", byCrit: "По критериям", price: "Цена",
    // форма / карточка
    webSearch: "Поиск в интернете", find: "Найти", errPrefix: "Ошибка: ", aiTimeout: "Gemini не ответил за 30 секунд — похоже, сервис перегружен. Попробуй позже", aiBusy: "Сервис Gemini сейчас перегружен. Попробуй позже", aiQuota: "Лимит запросов к Gemini исчерпан. Попробуй позже", aiEmpty: "Gemini ничего не нашёл — попробуй уточнить запрос", aiBadReply: "Не удалось разобрать ответ Gemini", storeFail: "Не сохранилось в памяти телефона: ", photoErr: "Не удалось обработать фото.",
    manufacturer: "Производитель", name: "Название", flavorDesc: "Описание вкуса", strength: "Крепость",
    status: "Статус", notes: "Заметки", ownPhoto: "Своё фото", camera: "📷 Камера", gallery: "🖼 Галерея",
    favOn: "★ Избранное", favOff: "☆ В избранное", avgShort: "ср. оценка", avgLong: "средняя оценка", taste: "Вкус",
    perUnit: u => `Цена за ${u}`, smoked: "Выкурено", smokedVal: (n, p) => `${n} шт · ${p} пач.`,
    rating: "Оценка", date: "Дата", cmpWith: "⇄ Сравнить с…", share: "↑ Поделиться",
    // сообщения
    notifDenied: "Уведомления запрещены — разреши их для приложения в настройках Android",
    notifLost: "Напоминание выключено: у приложения нет разрешения на уведомления. Включи напоминание снова",
    notifWebOnly: "Уведомления работают только в приложении на телефоне",
    notifSent: "Отправил — проверь шторку", failed: "Не получилось: ",
    tooMany: n => `По записям в пачке ${n} — больше быть не может. Если открыл новую, нажми «Новая пачка».`,
    mismatch: "Не сходится", recorded: d => `Записал +${d}`, matches: "Сходится с записями",
    leftBody: (c, n) => `сегодня ${c} ${L.ru.sticksWord(c)} · в пачке осталось ${n}${n===0?" — пачка кончилась":""}`,
    badAnswer: "Не понял ответ", badAnswerBody: i => `«${i}» — нужно число. Введи остаток в приложении.`,
    staleAnswer: "Ответ не записан", staleAnswerBody: "Пачку из напоминания уже докурили или отменили. Введи остаток в приложении.",
    sticksDefault: "Стики",
    notifPackTitle: "Сколько стиков осталось в пачке?", notifNoPackTitle: "Сколько выкурил сегодня?",
    notifPackBody: (name, left, size) => `${name} — по записям ${left} из ${size}`, notifNoPackBody: "Открой счётчик и отметь пачку",
    actDone: "Готово",
    types: {
      vape: {
        tabLabel: "Жижи", title: "ЖИЖИ", addBtn: "+ Добавить жижу", newTitle: "Новая жижа",
        emptyHint: "Добавь первую жижу", deleteMsg: "Удалить жижу?", backLabel: "← Все жижи",
        searchPlaceholder: "Напр.: Husky Mint Party", unit: "мл", volumeLabel: "Объём", volumePlaceholder: "30 мл",
        crit: { taste: "Вкус", feel: "Ощущение (throat hit)", accuracy: "Соответствие описанию", fatigue: "Не приедается", repeat: "Купил бы снова" },
        ai: q => `Жидкость для вейпа: "${q}".
Верни ТОЛЬКО валидный JSON без markdown:
{"manufacturer":"бренд (Ice Fox, Husky, WNT)","name":"полное название: бренд + вкус (Ice Fox Кислый мармелад)","flavor":"1-2 предложения об ощущениях при парении","volume":"объём в мл (30 мл)","nicotine":"только: 20 light или 40 strong"}
Если не знаешь — оставь поле пустой строкой.`,
      },
      sticks: {
        tabLabel: "Стики", title: "СТИКИ", addBtn: "+ Добавить стики", newTitle: "Новые стики",
        emptyHint: "Добавь первую пачку стиков", deleteMsg: "Удалить стики?", backLabel: "← Все стики",
        searchPlaceholder: "Напр.: Terea Amber", unit: "шт", volumeLabel: "В пачке", volumePlaceholder: "20 шт",
        crit: { taste: "Вкус", feel: "Насыщенность затяжки", smell: "Запах (не воняет)", aftertaste: "Послевкусие", repeat: "Купил бы снова" },
        ai: q => `Табачные стики для IQOS / систем нагревания табака: "${q}".
Верни ТОЛЬКО валидный JSON без markdown:
{"manufacturer":"линейка стиков (Terea, Heets, Fiit, Sentia, Delia)","name":"полное название: линейка + вариант (Terea Amber)","flavor":"1-2 предложения: табак, ментол/капсула, фруктовые ноты, крепость","volume":"штук в пачке (20 шт)"}
Если не знаешь — оставь поле пустой строкой.`,
      },
    },
  },
  en: {
    locale: "en",
    back: "← Back", settings: "Settings", edit: "Edit", save: "Save", del: "Delete",
    cancel: "✕ Cancel", loading: "Loading…", search: "Search…", fav: "★ Favorites",
    empty: "Nothing here yet", notFound: "Nothing found", noBrand: "No brand",
    cmpPick: "Pick to compare", cmpGo: "Compare →", cmpSel: n => `Selected ${n} of 2`,
    "st.have": "In stock", "st.want": "Want to try", "st.out": "Ran out",
    "tab.tracker": "Tracker", "title.tracker": "TRACKER",
    sticksWord: n => n===1 ? "stick" : "sticks",
    weekdays: ["Su","Mo","Tu","We","Th","Fr","Sa"], todayShort: "tdy",
    todayN: n => `${L.en.sticksWord(n)} today`, yest: n => `yesterday ${n}`, perDay: v => ` · ${v} a day on average`,
    endsToday: "runs out today", lastsDays: d => `lasts ≈ ${d} days`,
    deletedSticks: "Deleted sticks", openedAt: d => `opened ${d}`, ofN: n => `of ${n}`,
    plusOne: "+1 stick", packOut: "Pack is empty — open a new one", enterLeft: "Enter what's left",
    newPack: "New pack", cancelPack: "Undo opening this pack",
    noPack: "No pack open", noPackHint: "Pick your sticks — then tap one at a time or enter what's left in the evening",
    openPack: "Open pack",
    remindAsk: "Remind you in the evening?",
    remindAskHint: t => `Every day at ${t} you'll get a notification — enter what's left in the pack right from the shade.`,
    enable: "Turn on", noThanks: "No thanks",
    secToday: "Today", nothingYet: "Nothing logged yet", days14: "14 days",
    nothingDay: "Nothing logged that day", vsAvg: d => `${d} vs average`,
    "kind.left": "by count", "kind.finish": "finished pack",
    avg7: "7-day avg", avg30: "30-day avg", maxDay: "Max per day", total: "Total", packs: "Packs", spent30: "Spent 30 days",
    howMany: "How many left?", byRecords: (name, left, size) => `${name} · logged ${left} of ${size}`,
    leftHint: "The difference is logged as smoked now.",
    addSticksFirst: "Add sticks in the “Sticks” tab first — then pick them here.",
    whichSticks: "Which sticks did you open?", lastPack: "previous pack", pcs: "Count",
    packPrice: c => `Pack price, ${c}`, optional: "optional",
    finishOld: (name, n) => `Finished ${name} — log the remaining ${n}`,
    openPacks: "Open packs", leftOf: (n, size) => `${n} of ${size} left`,
    finishPack: "Finish this pack", finishAsk: n => `Log the remaining ${n} as smoked and close the pack?`,
    look: "Appearance", theme: "Theme", dark: "Dark", light: "Light", lang: "Language",
    currency: "Currency", currencyHint: "Only the symbol changes — prices you entered aren't converted",
    remind: "Reminder", remindTitle: "Ask what's left every evening",
    remindNative: "You can reply right from the notification", remindWeb: "Works only in the phone app", test: "Test",
    backup: "Backup", backupHint: "Liquids, sticks, photos, tracker and settings — in one file",
    backupSave: "Save backup", backupShare: "Send file", restore: "Restore from file",
    backupSaved: p => `Saved: ${p}`, backupFail: "Couldn't save: ",
    restoreAsk: d => `All current data will be replaced with the backup${d?" from "+d:""}. Continue?`,
    restoreBad: "This isn't a backup file of this app", restoreFail: "Couldn't restore: ", shareFail: "Couldn't share: ",
    ai: "AI recognition", aiTitle: "Fill in cards with Gemini", aiHint: "Finds brand, flavor, volume and strength by name",
    aiKey: "Gemini API key", aiKeyHint: "Get one for free: aistudio.google.com/apikey. The key is stored on the phone. It's included in saved backups but not in shared files",
    aiKeyEmpty: "No key — web search when adding items is disabled",
    aiKeyChecking: "Checking the key…", aiKeyOk: "✓ The key works", aiKeyBad: "The key doesn't work: ", aiKeyNet: "Couldn't check — no connection to Google",
    aiOff: "AI search is turned off in settings", aiNoKey: "No Gemini key — add one in settings",
    need2: "Need 2 items", compare: "Compare", byCrit: "By criteria", price: "Price",
    webSearch: "Search the web", find: "Find", errPrefix: "Error: ", aiTimeout: "Gemini didn't answer in 30 seconds — the service seems overloaded. Try again later", aiBusy: "Gemini is overloaded right now. Try again later", aiQuota: "Gemini request limit reached. Try again later", aiEmpty: "Gemini found nothing — try a more specific query", aiBadReply: "Couldn't read Gemini's reply", storeFail: "Couldn't save to the phone: ", photoErr: "Couldn't process the photo.",
    manufacturer: "Manufacturer", name: "Name", flavorDesc: "Flavor", strength: "Strength",
    status: "Status", notes: "Notes", ownPhoto: "Photo", camera: "📷 Camera", gallery: "🖼 Gallery",
    favOn: "★ Favorite", favOff: "☆ Add to favorites", avgShort: "avg rating", avgLong: "average rating", taste: "Flavor",
    perUnit: u => `Price per ${u}`, smoked: "Smoked", smokedVal: (n, p) => `${n} pcs · ${p} packs`,
    rating: "Rating", date: "Date", cmpWith: "⇄ Compare with…", share: "↑ Share",
    notifDenied: "Notifications are blocked — allow them for the app in Android settings",
    notifLost: "Reminder turned off: the app isn't allowed to send notifications. Turn the reminder on again",
    notifWebOnly: "Notifications work only in the phone app",
    notifSent: "Sent — check the notification shade", failed: "Didn't work: ",
    tooMany: n => `The pack has ${n} logged — it can't be more. If you opened a new one, tap “New pack”.`,
    mismatch: "Doesn't add up", recorded: d => `Logged +${d}`, matches: "Matches the log",
    leftBody: (c, n) => `today ${c} ${L.en.sticksWord(c)} · ${n} left in the pack${n===0?" — pack is empty":""}`,
    badAnswer: "Didn't get that", badAnswerBody: i => `“${i}” — a number is needed. Enter what's left in the app.`,
    staleAnswer: "Answer not saved", staleAnswerBody: "The pack from that reminder is already finished or undone. Enter what's left in the app.",
    sticksDefault: "Sticks",
    notifPackTitle: "How many sticks are left in the pack?", notifNoPackTitle: "How many did you smoke today?",
    notifPackBody: (name, left, size) => `${name} — logged ${left} of ${size}`, notifNoPackBody: "Open the tracker and log a pack",
    actDone: "Done",
    types: {
      vape: {
        tabLabel: "Liquids", title: "LIQUIDS", addBtn: "+ Add liquid", newTitle: "New liquid",
        emptyHint: "Add your first liquid", deleteMsg: "Delete this liquid?", backLabel: "← All liquids",
        searchPlaceholder: "E.g.: Husky Mint Party", unit: "ml", volumeLabel: "Volume", volumePlaceholder: "30 ml",
        crit: { taste: "Flavor", feel: "Throat hit", accuracy: "Matches description", fatigue: "Doesn't get old", repeat: "Would buy again" },
        ai: q => `E-liquid for vaping: "${q}".
Return ONLY valid JSON without markdown:
{"manufacturer":"brand (Ice Fox, Husky, WNT)","name":"full name: brand + flavor (Ice Fox Sour Marmalade)","flavor":"1-2 sentences in English on how it feels when vaping","volume":"volume in ml (30 ml)","nicotine":"only: 20 light or 40 strong"}
If you don't know, leave the field as an empty string.`,
      },
      sticks: {
        tabLabel: "Sticks", title: "STICKS", addBtn: "+ Add sticks", newTitle: "New sticks",
        emptyHint: "Add your first pack of sticks", deleteMsg: "Delete these sticks?", backLabel: "← All sticks",
        searchPlaceholder: "E.g.: Terea Amber", unit: "pcs", volumeLabel: "Per pack", volumePlaceholder: "20 pcs",
        crit: { taste: "Flavor", feel: "Draw intensity", smell: "Smell (no stink)", aftertaste: "Aftertaste", repeat: "Would buy again" },
        ai: q => `Tobacco sticks for IQOS / heated tobacco systems: "${q}".
Return ONLY valid JSON without markdown:
{"manufacturer":"stick line (Terea, Heets, Fiit, Sentia, Delia)","name":"full name: line + variant (Terea Amber)","flavor":"1-2 sentences in English: tobacco, menthol/capsule, fruit notes, strength","volume":"sticks per pack (20 pcs)"}
If you don't know, leave the field as an empty string.`,
      },
    },
  },
};
const LANGS = { ru: "Русский", en: "English" };
// t("key", ...args): строка или функция из словаря; чего нет в английском — берём из русского
const makeT = lang => (k, ...a) => { const v = L[lang]?.[k] ?? L.ru[k] ?? k; return typeof v==="function" ? v(...a) : v; };
const typeCfg = (type, lang) => {
  const tx = (L[lang]||L.ru).types[type];
  return { ...TYPES[type], ...tx, criteria: TYPES[type].criteria.map(k=>[k, tx.crit[k]]) };
};

/* ── helpers ── */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const localDate = (d = new Date()) => new Date(d - d.getTimezoneOffset()*60000).toISOString().slice(0, 10);
const today = () => localDate();
const fmtDate = d => d.split("-").reverse().join(".");
const lastPrice = l => l.prices?.length ? [...l.prices].sort((a,b)=>a.date.localeCompare(b.date)).at(-1) : null;
// цена на дату: последняя запись не позже неё, а если все записи позже — самая ранняя
const priceAt = (l, date) => {
  const ps = [...(l?.prices||[])].sort((a,b)=>a.date.localeCompare(b.date));
  return (ps.findLast(p=>p.date<=date) || ps[0])?.price;
};
const avgRating = (l, criteria) => {
  const vals = criteria.map(([k]) => l.ratings?.[k] || 0).filter(v => v > 0);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
};
const pricePerUnit = l => {
  const lp = lastPrice(l); const vol = parseFloat(l.volume);
  return lp && vol ? (lp.price / vol).toFixed(1) : null;
};
const compressImg = file => new Promise((res, rej) => {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(1, 700/Math.max(img.width,img.height));
    const c = document.createElement("canvas");
    c.width = img.width*s; c.height = img.height*s;
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    res(c.toDataURL("image/jpeg", 0.82));
  };
  img.onerror = rej; img.src = URL.createObjectURL(file);
});

/* ── ai ── */
// ключ вписывается в настройках и хранится на телефоне
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
// описание модели — бесплатный запрос: видно и рабочий ли ключ, и доступна ли ему эта модель
const keyChecks = new Map();
async function checkGeminiKey(key, signal) {
  let resp;
  try { resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`, { signal, headers:{"x-goog-api-key":key} }); }
  catch (e) { if (e?.name==="AbortError") throw e; return { state:"net" }; }
  if (resp.ok) return { state:"ok" };
  const d = await resp.json().catch(()=>null);
  return { state:"bad", msg: d?.error?.message || `HTTP ${resp.status}` };
}
const AI_TIMEOUT = 30000;
async function aiSearch(query, type, lang, key) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { method:"POST", headers:{"Content-Type":"application/json", "x-goog-api-key":key},
      body: JSON.stringify({ contents:[{role:"user",parts:[{text:typeCfg(type, lang).ai(query)}]}], generationConfig:{temperature:0.1, responseMimeType:"application/json"} }),
      signal: AbortSignal.timeout(AI_TIMEOUT) }
  );
  // при сбое сервера (или прокси, портале wi-fi) в ответе бывает html, а не json;
  // таймаут во время чтения тела — пробрасываем как есть
  let d = null;
  try { d = await resp.json(); } catch (e) { if (e?.name==="TimeoutError") throw e; }
  // перегрузка и лимиты — своими словами: английский текст Google пользователю ничего не скажет
  if (resp.status===429) throw aiErr("aiQuota");
  if (resp.status>=500) throw aiErr("aiBusy");
  if (!resp.ok || d?.error) throw new Error(d?.error?.message || `HTTP ${resp.status}`);
  if (!d) throw aiErr("aiBadReply");
  // пусто — например, запрос отсёк фильтр безопасности
  const text = (d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw aiErr("aiEmpty");
  let r; try { r = JSON.parse(m[0]); } catch {}
  if (!isObj(r)) throw aiErr("aiBadReply");
  return r;
}
// code — ключ текста ошибки в словаре
// aiCode, а не code: code бывает у DOMException и ошибок плагинов
const aiErr = aiCode => Object.assign(new Error(aiCode), { aiCode });
const NICOTINE = ["20 light","40 strong"];
// модель может вернуть число или объект вместо строки — в форму берём только строки
const aiField = (k, v) => {
  if (typeof v==="number") v = String(v);
  if (typeof v!=="string" || !v.trim()) return null;
  if (k!=="nicotine") return v.trim();
  if (NICOTINE.includes(v.trim())) return v.trim();
  // крепость — к одной из двух кнопок: «2%» = 20 мг/мл; до 30 мг — light, больше — strong
  const n = parseFloat(v.replace(",", "."));
  const mg = /%/.test(v) ? n*10 : n;
  return !(mg>0) ? null : mg<=30 ? NICOTINE[0] : NICOTINE[1];
};

/* ── tracker ── */
const DAY_START = 4; // до 4 утра считается ещё вчерашним днём
const dayKey = t => localDate(new Date(t - DAY_START*3600e3));
// ключ дня — в полдень: переход на летнее время не сдвинет дату
const parseDay = k => new Date(k+"T12:00:00");
const shiftDay = (k, n) => { const d = parseDay(k); d.setDate(d.getDate()+n); return localDate(d); };
const fmtTime = t => new Date(t).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
// cur — пачка, которую курят сейчас; открытыми могут быть несколько, у каждой свой остаток
const TRK_DEFAULT = { packs:[], log:[], cur:null, cfg:{remind:null, time:"22:00"} };
const NO_ITEMS = [];
const TABS = [...Object.keys(TYPES), "tracker"];
const tabIndex = t => TABS.indexOf(t);

/* ── settings ── */
const APP_DEFAULT = { currency:"USD", lang:"ru", theme:"dark", ai:true, geminiKey:"" };
// только подпись: уже введённые цены не пересчитываются
const CURRENCIES = { USD:{ru:"$", en:"$"}, EUR:{ru:"€", en:"€"}, RUB:{ru:"₽", en:"₽"}, RSD:{ru:"дин", en:"din"} };
const THEMES = ["dark","light"];
async function loadSettings(trkCfg) {
  const saved = await readJSON("app_cfg", {});
  // валюта раньше лежала в настройках счётчика
  return { ...APP_DEFAULT, ...(trkCfg.currency?{currency:trkCfg.currency}:{}), ...saved };
}
const saveSettings = v => unread.has("app_cfg") ? Promise.resolve() : Preferences.set({ key: "app_cfg", value: JSON.stringify(v) });
// ошибка записи — сразу окном (flash виден не на всех экранах). Фоновые записи (счётчик пишет
// на каждый +1) — не чаще раза в 30 с; сохранение карточки — всегда, это отдельное действие
let lastAutoFail = 0;
const reportStoreFail = (lang, e, auto) => {
  if (auto) {
    if (Date.now()-lastAutoFail < 30000) return;
    lastAutoFail = Date.now();
  }
  alert(makeT(lang)("storeFail") + (e?.message||String(e)));
};
const Ctx = createContext({ cur:"$", lang:"ru", t:makeT("ru"), ai:{on:false, key:""} });
const useCur = () => useContext(Ctx).cur;
const useT = () => useContext(Ctx).t;
const useTypeCfg = type => typeCfg(type, useContext(Ctx).lang);

// пачки и журнал — одним ключом trk_data: открытие пачки меняет оба, и записи не должны разойтись.
// trk_packs/trk_log — старый формат (и старые бэкапы): читаем их, пока trk_data нет
// и элементы: одна кривая запись в журнале уронила бы packLeft при каждом рендере
const isPacks = v => Array.isArray(v) && v.every(p => isObj(p) && typeof p.size==="number");
const isLog = v => Array.isArray(v) && v.every(e => isObj(e) && typeof e.n==="number" && typeof e.t==="number");
const isTrkData = v => isObj(v) && isPacks(v.packs) && isLog(v.log) && (v.cur==null || typeof v.cur==="string");
async function loadTracker() {
  const [data, cfg] = await Promise.all([readJSON("trk_data", null, isTrkData), readJSON("trk_cfg", TRK_DEFAULT.cfg)]);
  // переход на cur записываем сразу, а не ждём первого изменения в счётчике
  const withCfg = async d => {
    const r = withCur(d);
    if (!("cur" in d) && r.packs.length && !unread.has("trk_data"))
      await Preferences.set({ key: "trk_data", value: JSON.stringify(r) }).catch(()=>{});
    return { ...r, cfg: {...TRK_DEFAULT.cfg, ...cfg} };
  };
  // trk_data не прочитался — не лезем в старые ключи: после миграции их уже нет, был бы пустой счётчик
  if (data || unread.has("trk_data")) return withCfg(data || TRK_DEFAULT);
  const [packs, log] = await Promise.all([readJSON("trk_packs", TRK_DEFAULT.packs, isPacks), readJSON("trk_log", TRK_DEFAULT.log, isLog)]);
  if (unread.has("trk_packs")||unread.has("trk_log")) {
    // старое не прочиталось — нельзя записать вместо него пустое
    unread.add("trk_data");
  } else if (packs.length||log.length) {
    // миграция: сначала новый ключ, потом удаляем старые; оборвётся — повторится при следующем запуске
    try {
      await Preferences.set({ key: "trk_data", value: JSON.stringify({ packs, log }) });
      await Promise.all(["trk_packs","trk_log"].map(key => Preferences.remove({ key })));
    } catch {}
  }
  return withCfg({ packs, log });
}
// раньше открытой была только последняя пачка, а недокуренные старые просто бросали —
// при переходе закрываем их, иначе все всплыли бы среди открытых
// cur на пачку, которой нет (кривой бэкап), — берём последнюю открытую
function withCur(d) {
  const open = openPacks(d.packs, d.log);
  if ("cur" in d) {
    const cur = d.packs.some(p=>p.id===d.cur) ? d.cur : open.at(-1)?.id ?? null;
    return { packs:d.packs, log:d.log, cur };
  }
  const last = d.packs.at(-1), openIds = new Set(open.map(p=>p.id));
  const packs = d.packs.map(p => p!==last && openIds.has(p.id) ? {...p, done:true} : p);
  return { packs, log:d.log, cur:last?.id ?? null };
}
const saveTracker = (k, v) => unread.has("trk_"+k) ? Promise.resolve() : Preferences.set({ key: "trk_"+k, value: JSON.stringify(v) });

const usedByPack = log => { const m = {}; log.forEach(e => { if (e.pack) m[e.pack] = (m[e.pack]||0) + e.n; }); return m; };
const packLeft = (p, log) => p ? p.size - (usedByPack(log)[p.id]||0) : 0;
// открытые пачки с остатками, по порядку открытия
const openPacks = (packs, log) => {
  const used = usedByPack(log);
  return packs.map(p => ({...p, left:p.size-(used[p.id]||0)})).filter(p => !p.done && p.left>0);
};
const dayTotals = log => {
  const m = {};
  log.forEach(e => { const k = dayKey(e.t); m[k] = (m[k]||0) + e.n; });
  return m;
};

/* ── reminder ── */
const NATIVE = Capacitor.isNativePlatform();
// Повторяющийся `on` у плагина не годится: перезаведённый после срабатывания будильник
// потом не отменяется (ни выключить, ни сменить время). Поэтому ставим разовые
// напоминания на месяц вперёд, у каждого дня свой id, и обновляем их при каждом запуске.
const REMIND_BASE = 4210, REMIND_DAYS = 30;
const REMIND_ALL = Array.from({length:REMIND_DAYS+1}, (_,i)=>REMIND_BASE+i);
const LEGACY_IDS = [4201, 4203]; // старые повторяющиеся — убрать из хранилища плагина
const TEST_ID = 4202;
const remindIdFor = d => REMIND_BASE + Math.round(Date.parse(localDate(d))/864e5) % (REMIND_DAYS+1);
// кнопка с полем ввода прямо в уведомлении; тип должен быть зарегистрирован до планирования,
// а при смене языка — перерегистрирован с новыми подписями
let actionsReady = Promise.resolve();
const registerActions = t => {
  if (NATIVE) actionsReady = LocalNotifications.registerActionTypes({ types: [{ id: "CHECKIN", actions: [
    { id: "left", title: t("enterLeft"), input: true, inputButtonTitle: t("actDone"), inputPlaceholder: t("howMany") },
  ] }] }).catch(() => {});
};
const reminderPayload = (pack, left, name, t) => ({
  title: pack ? t("notifPackTitle") : t("notifNoPackTitle"),
  body: pack ? t("notifPackBody", name, left, pack.size) : t("notifNoPackBody"),
  actionTypeId: pack ? "CHECKIN" : undefined,
  extra: { kind: "checkin", pack: pack?.id },
  autoCancel: true,
  isExactNotification: false,
});
const notifyResult = (id, title, body) => {
  if (!NATIVE||id==null) return;
  LocalNotifications.schedule({ notifications: [{ id, title, body, autoCancel: true, isExactNotification: false, extra: { kind: "summary" } }] }).catch(() => {});
};
// вызовы идут строго по очереди, и из ожидающих выполняется только последний —
// иначе старый вызов (напоминание вкл.) мог завести будильники после нового (выкл.)
let remindChain = Promise.resolve(), remindGen = 0;
function syncReminder(...args) {
  if (!NATIVE) return;
  const gen = ++remindGen;
  remindChain = remindChain.then(()=>gen===remindGen && doSyncReminder(...args));
}
async function doSyncReminder(cfg, pack, left, name, t) {
  try {
    await actionsReady;
    // cancel/schedule плагина заодно убирают видимое уведомление с тем же id —
    // висящие в шторке (напоминание или итог ответа) не трогаем, их будильник уже отработал
    const shown = new Set((await LocalNotifications.getDeliveredNotifications()).notifications.map(n => n.id));
    const free = [...REMIND_ALL, ...LEGACY_IDS].filter(id => !shown.has(id));
    if (free.length) await LocalNotifications.cancel({ notifications: free.map(id => ({ id })) });
    if (!cfg.remind) return;
    const [hour, minute] = cfg.time.split(":").map(Number);
    // точный будильник только если он уже разрешён (USE_EXACT_ALARM в манифесте), иначе плагин открыл бы настройки
    const exact = (await LocalNotifications.checkExactNotificationSetting())?.exact_alarm === "granted";
    const now = new Date(), payload = reminderPayload(pack, left, name, t), list = [];
    for (let i = 0; i <= REMIND_DAYS; i++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate()+i, hour, minute);
      const id = remindIdFor(at);
      if (at > now && !shown.has(id)) list.push({ id, ...payload, isExactNotification: exact, schedule: { at, allowWhileIdle: true } });
    }
    await LocalNotifications.schedule({ notifications: list });
  } catch {}
}

/* ── share card ── */
function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const t = line ? line+" "+w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath();
}
async function shareCard(l, cfg, cur, t) {
  const W = 720, H = 920;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d0d0d"; ctx.fillRect(0,0,W,H);

  const IS = 180, ix = (W-IS)/2, iy = 44;
  if (l.photo) {
    await new Promise(res => {
      const img = new Image();
      img.onload = () => {
        ctx.save(); rrect(ctx,ix,iy,IS,IS,20); ctx.clip();
        const sc = Math.max(IS/img.width, IS/img.height);
        ctx.drawImage(img,(img.width-IS/sc)/2,(img.height-IS/sc)/2,IS/sc,IS/sc,ix,iy,IS,IS);
        ctx.restore(); res();
      };
      img.onerror = res; img.src = photoSrc(l.photo);
    });
  } else {
    ctx.fillStyle = "#f2f2f2"; rrect(ctx,ix,iy,IS,IS,20); ctx.fill();
    ctx.fillStyle="#0d0d0d"; ctx.font="bold 70px sans-serif";
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText((l.name||"?")[0].toUpperCase(), W/2, iy+IS/2);
  }

  ctx.textAlign="center"; ctx.textBaseline="top";
  let y = iy+IS+22;

  ctx.fillStyle="#f2f2f2"; ctx.font="bold 32px sans-serif";
  wrapText(ctx, l.name||"", W-80).slice(0,2).forEach(ln => { ctx.fillText(ln,W/2,y); y+=40; });

  if (l.manufacturer) {
    ctx.fillStyle="#7a7a7a"; ctx.font="20px sans-serif";
    ctx.fillText(l.manufacturer,W/2,y); y+=32;
  }
  if (l.flavor) {
    ctx.fillStyle="#aaa"; ctx.font="18px sans-serif";
    wrapText(ctx,l.flavor,W-100).slice(0,2).forEach(ln => { ctx.fillText(ln,W/2,y); y+=24; });
    y+=6;
  }

  y+=10; ctx.strokeStyle="#2a2a2a"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(40,y); ctx.lineTo(W-40,y); ctx.stroke(); y+=20;

  const avg = avgRating(l, cfg.criteria);
  if (avg > 0) {
    ctx.fillStyle="#f2f2f2"; ctx.font="bold 50px sans-serif";
    ctx.fillText(avg.toFixed(1),W/2,y); y+=62;
    ctx.fillStyle="#7a7a7a"; ctx.font="16px sans-serif";
    ctx.fillText(t("avgLong"),W/2,y); y+=28;
    y+=10; ctx.strokeStyle="#2a2a2a";
    ctx.beginPath(); ctx.moveTo(40,y); ctx.lineTo(W-40,y); ctx.stroke();
  }
  y+=18;

  cfg.criteria.forEach(([k,label]) => {
    const val = l.ratings?.[k]||0;
    ctx.textAlign="left"; ctx.fillStyle="#8a8a8a"; ctx.font="17px sans-serif";
    ctx.fillText(label,40,y);
    ctx.textAlign="right"; ctx.fillStyle=val>0?"#f2f2f2":"#555"; ctx.font="bold 17px sans-serif";
    ctx.fillText(val>0?val+"/5":"—",W-40,y); y+=24;
    ctx.fillStyle="#1d1d1d"; ctx.fillRect(40,y,W-80,6);
    if (val>0) { ctx.fillStyle="#f2f2f2"; ctx.fillRect(40,y,(W-80)*val/5,6); }
    y+=18;
  });

  const lp = lastPrice(l); const ppm = pricePerUnit(l);
  if (lp) {
    y+=8; ctx.fillStyle="#7a7a7a"; ctx.font="16px sans-serif"; ctx.textAlign="center";
    ctx.fillText(`${lp.price} ${cur}${ppm?" · "+ppm+" "+cur+"/"+cfg.unit:""}${l.volume?" · "+l.volume:""}`,W/2,y);
  }
  ctx.fillStyle="#333"; ctx.font="14px sans-serif"; ctx.textAlign="center";
  ctx.fillText("VapeTracker",W/2,H-20);

  const blob = await new Promise(res => canvas.toBlob(res,"image/png"));
  const fname = (l.name||"review").replace(/[^a-zа-яё0-9]/gi,"_")+".png";
  const file = new File([blob], fname, {type:"image/png"});
  try {
    if (navigator.share && navigator.canShare?.({files:[file]})) {
      await navigator.share({files:[file],title:l.name}); return;
    }
  } catch {}
  downloadBlob(blob, fname);
}

/* ── backup ── */
const BACKUP_APP = "vape-tracker";
// withKey=false — файл для отправки: ключ Gemini в мессенджеры и облака не уходит
async function makeBackup(withKey = true) {
  const { keys } = await Preferences.keys();
  const vals = await Promise.all(keys.map(k => Preferences.get({ key: k })));
  const data = Object.fromEntries(keys.map((k, i) => [k, vals[i].value]));
  if (!withKey) {
    // и сырая копия испорченных настроек: в ней тоже может быть ключ
    delete data.app_cfg_broken;
    // испорченный app_cfg не разобрать — не отдаём его вовсе, ключ мог остаться внутри
    if (data.app_cfg) try { const c = JSON.parse(data.app_cfg); delete c.geminiKey; data.app_cfg = JSON.stringify(c); } catch { delete data.app_cfg; }
  }
  // фото карточек лежат файлами — кладём их в бэкап рядом с данными
  const photos = Object.entries(data)
    .filter(([k]) => Object.values(TYPES).some(t => k.startsWith(t.key)))
    .map(([, v]) => { try { return JSON.parse(v).photo; } catch { return null; } })
    .filter(isPhotoFile);
  const files = Object.fromEntries((await Promise.all(photos.map(path =>
    Filesystem.readFile({ path, directory: Directory.Data }).then(r => [path, r.data], () => null) // файла нет — без него
  ))).filter(Boolean));
  return JSON.stringify({ app: BACKUP_APP, v: 2, created: new Date().toISOString(), data, files });
}
const parseBackup = text => {
  let b; try { b = JSON.parse(text); } catch { return null; }
  return b?.app===BACKUP_APP && b.data && typeof b.data==="object" ? b : null;
};
// сначала пишем всё из файла, потом убираем лишнее — если запись оборвётся, старое не потеряется
async function restoreBackup(b) {
  const data = {...b.data};
  // в отправленном файле (и в старых бэкапах, где app_cfg ещё не было) ключа нет —
  // оставляем тот, что уже на телефоне
  const key = (await readJSON("app_cfg", {})).geminiKey;
  if (key) {
    let c = null;
    try { c = JSON.parse(data.app_cfg); } catch {}
    if (!isObj(c)) c = {};
    if (!c.geminiKey) data.app_cfg = JSON.stringify({...c, geminiKey:key});
  }
  // фото — раньше карточек, чтобы карточка не ссылалась на ещё не записанный файл.
  // В бэкапах v1 файлов нет: фото там data:-url в карточках, при запуске они переедут в файлы
  const files = NATIVE && isObj(b.files) ? Object.entries(b.files).filter(([p, v]) => isPhotoFile(p) && typeof v==="string") : [];
  await Promise.all(files.map(([path, data]) => Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true })));
  // список ключей — после чтения выше: оно могло завести app_cfg_broken, его тоже убрать
  const { keys } = await Preferences.keys();
  await Promise.all(Object.entries(data).filter(([, v]) => typeof v==="string").map(([key, value]) => Preferences.set({ key, value })));
  await Promise.all(keys.filter(k => typeof data[k]!=="string").map(key => Preferences.remove({ key })));
  // фото карточек, которых в бэкапе нет, — убрать
  if (NATIVE) try {
    const keep = new Set(files.map(([p]) => p));
    const { files: have } = await Filesystem.readdir({ path: PHOTO_DIR, directory: Directory.Data });
    await Promise.all(have.filter(f => !keep.has(`${PHOTO_DIR}/${f.name}`)).map(f => Filesystem.deleteFile({ path: `${PHOTO_DIR}/${f.name}`, directory: Directory.Data })));
  } catch {}
}
const backupName = () => `vape-backup-${today()}-${new Date().toTimeString().slice(0,5).replace(":","")}.json`;
// в «Документы»; имя с временем — файл от прошлой установки приложения перезаписать нельзя
async function saveBackupFile(json) {
  const path = `VapeTracker/${backupName()}`;
  if (!NATIVE) { downloadText(json, path.split("/")[1]); return path; }
  await Filesystem.writeFile({ path, data: json, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
  return "Documents/" + path;
}
async function shareBackupFile(json) {
  const name = backupName();
  if (!NATIVE) return downloadText(json, name);
  // прошлые отправленные копии убираем здесь, а не сразу после Share — их ещё может читать получатель
  try {
    const { files } = await Filesystem.readdir({ path: "", directory: Directory.Cache });
    await Promise.all(files.filter(f => /^vape-backup-.*\.json$/.test(f.name)).map(f => Filesystem.deleteFile({ path: f.name, directory: Directory.Cache })));
  } catch {}
  const { uri } = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: name, files: [uri] });
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
const downloadText = (text, name) => downloadBlob(new Blob([text], { type: "application/json" }), name);

/* ── переходы ── */
// View Transitions: браузер снимает старый экран и анимирует его уход вместе с появлением нового.
// nav — направление (fwd/back/fade/tab-r/tab-l/sheet), по нему css выбирает анимацию
const VT = typeof document!=="undefined" && !!document.startViewTransition;
let vtQueue = null, vtRunning = false, vtCur = null;
function animate(nav, fn) {
  // вложенный вызов внутри перехода — уже часть его, направление задал внешний
  if (vtRunning) return fn();
  // несколько переходов из одного обработчика — одной анимацией, направление у последнего;
  // в очередь даже без анимации, иначе обгонит уже отложенные обновления
  if (vtQueue) { document.documentElement.dataset.nav = nav; vtQueue.push(fn); return; }
  if (!VT || matchMedia("(prefers-reduced-motion: reduce)").matches) return fn();
  document.documentElement.dataset.nav = nav;
  vtQueue = [fn];
  // до снимка экран ещё старый и нажимается: второе нажатие повторило бы то же действие
  // (дважды записать остаток, открыть две пачки)
  document.body.style.pointerEvents = "none";
  const flush = ()=>{
    const fns = vtQueue; vtQueue = null; vtRunning = true;
    let err = null;
    try { flushSync(()=>fns.forEach(f=>{ try { f(); } catch (e) { err ??= e; } })); }
    finally { vtRunning = false; document.body.style.pointerEvents = ""; }
    if (err) reportError(err);
  };
  let vt;
  try { vt = document.startViewTransition(flush); }
  catch {
    // переход не запустился — применяем без анимации, иначе экран так и остался бы без нажатий
    delete document.documentElement.dataset.nav;
    return flush();
  }
  vtCur = vt;
  // прерванный более новым переходом не стирает его направление
  const done = ()=>{ if (vtCur===vt) { vtCur = null; delete document.documentElement.dataset.nav; } };
  vt.finished.then(done, done);
}
const DEPTH = { list:0, settings:1, compare:1, detail:1 };
const depth = v => v.page==="form" ? (v.id?2:1) : DEPTH[v.page];
const navDir = (from, to) => { const d = depth(to)-depth(from); return d>0?"fwd":d<0?"back":"fade"; };

/* ── css ── */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Inter:wght@400;500;600&display=swap');
:root{color-scheme:dark;--bg:#0a0a0a;--s1:#131313;--s2:#1d1d1d;--line:#2a2a2a;--line2:#3e3e3e;--mute2:#555;--mute:#808080;--fg:#f2f2f2;
--star:#f2c400;--danger:#e57373;--ok-bg:#1d2a1d;--ok-line:#2e4a2e;--ok-fg:#cfe8cf;--err-bg:#2a1d1d;--err-line:#4a2a2a;--err-fg:#f0c4c4;--shadow:rgba(0,0,0,.6);--scrim:rgba(0,0,0,.65)}
:root[data-theme=light]{color-scheme:light;--bg:#f4f4f1;--s1:#ffffff;--s2:#e9e9e6;--line:#dcdcd8;--line2:#bdbdb8;--mute2:#9c9c97;--mute:#6b6b66;--fg:#141414;
--star:#d9a400;--danger:#c62828;--ok-bg:#e6f2e6;--ok-line:#b9d9b9;--ok-fg:#1e4d1e;--err-bg:#fbeaea;--err-line:#eac4c4;--err-fg:#8a1f1f;--shadow:rgba(0,0,0,.18);--scrim:rgba(0,0,0,.4)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}body{margin:0;background:var(--bg)}
.vt{min-height:100vh;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:env(safe-area-inset-top) 16px 90px}
.disp{font-family:Unbounded,sans-serif}
.hdr{padding:22px 0 10px;display:flex;justify-content:space-between;align-items:center}
.hdr h1{margin:0;font-size:20px;letter-spacing:.02em}
.hdr-right{display:flex;gap:8px}
.icon-btn{background:none;border:1px solid var(--line);border-radius:10px;color:var(--fg);padding:7px 11px;font-size:15px;cursor:pointer;line-height:1;font-family:Inter,sans-serif;font-weight:500}
.tabs{display:flex;border-bottom:1px solid var(--line);margin-bottom:10px}
.tab{flex:1;text-align:center;padding:10px 0 12px;font:600 13px Inter;cursor:pointer;border:none;background:transparent;color:var(--mute);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .25s,border-color .25s}
.tab.on{color:var(--fg);border-bottom-color:var(--fg)}
.srow{display:flex;gap:8px;margin-bottom:8px}
.srow input{flex:1;padding:9px 12px;font-size:14px}
.chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{white-space:nowrap;background:var(--s1);border:1px solid var(--line);border-radius:999px;color:var(--mute);font:500 12px Inter;padding:5px 12px;cursor:pointer;flex:none}
.chip.on{border-color:var(--fg);color:var(--fg);background:var(--s2)}
.grp{margin-top:18px}.grp>h2{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);margin:0 0 8px;display:flex;justify-content:space-between}
.card{display:flex;gap:12px;align-items:center;padding:12px;background:var(--s1);border:1px solid var(--line);border-radius:14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s;position:relative}
.card:active{border-color:var(--mute2)}.card.sel{border-color:var(--fg)}
.thumb{width:56px;height:56px;border-radius:10px;object-fit:cover;background:var(--s2);flex:none}
.tile{width:56px;height:56px;border-radius:10px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:24px;flex:none}
.card .nm{font-weight:600;font-size:15px;padding-right:24px}
.card .fl{color:var(--mute);font-size:12.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50vw}
.card .pr{margin-left:auto;text-align:right;font-size:13px;white-space:nowrap;padding-right:4px}
.card .pr small{display:block;color:var(--mute);font-size:10.5px}
.badge{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}
.star-btn{background:none;border:none;cursor:pointer;font-size:15px;padding:4px;position:absolute;top:9px;right:9px;line-height:1}
.chk{width:22px;height:22px;border:2px solid var(--line2);border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px}
.chk.on{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.fab{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);border:none;border-radius:999px;padding:14px 28px;font:600 14px Inter;cursor:pointer;box-shadow:0 6px 24px var(--shadow);z-index:100;white-space:nowrap}
.fab:disabled{opacity:.5}
.btn{background:var(--fg);color:var(--bg);border:none;border-radius:10px;padding:11px 16px;font:600 13px Inter;cursor:pointer}
.btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line2)}
.btn.danger{background:transparent;color:var(--danger);border:1px solid var(--err-line)}
.btn:disabled{opacity:.45}
input,textarea{width:100%;background:var(--s1);border:1px solid var(--line);border-radius:10px;color:var(--fg);padding:11px 12px;font:400 14px Inter;outline:none}
input:focus,textarea:focus{border-color:var(--mute2)}
input:disabled{opacity:.45}
label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:14px 0 6px}
.row{display:flex;gap:10px}.row>*{flex:1}
.hero{width:100%;height:210px;object-fit:cover;border-radius:16px;background:var(--s1);margin-top:16px}
.herotile{width:100%;height:210px;border-radius:16px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:64px;margin-top:16px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.meta div{background:var(--s1);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.meta small{display:block;color:var(--mute);font-size:10px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px}
.sec{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);margin:26px 0 10px}
.crit{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--s2);font-size:13.5px}
.dots{display:flex;gap:7px}
.dot{width:20px;height:20px;border-radius:6px;border:1px solid var(--line2);background:transparent;cursor:pointer;padding:0}
.dot.on{background:var(--fg);border-color:var(--fg)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
th{text-align:left;color:var(--mute);font-weight:500;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:6px 0;border-bottom:1px solid var(--line)}
td{padding:8px 0;border-bottom:1px solid var(--s2)}td:last-child,th:last-child{text-align:right}
.back{background:none;border:none;color:var(--mute);font:500 13px Inter;cursor:pointer;padding:16px 0 0;display:block}
.err{color:var(--danger);font-size:13px;margin-top:10px}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;display:flex;align-items:center;justify-content:center}
.lightbox img{max-width:100%;max-height:100%;object-fit:contain}
.spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
.empty{text-align:center;color:var(--mute);padding:70px 20px;font-size:14px;line-height:1.7}
.empty b{color:var(--fg);display:block;font-size:17px;margin-bottom:6px}
.sbar{height:6px;background:var(--s2);border-radius:3px;margin-top:5px}
.sbar-fill{height:100%;background:var(--fg);border-radius:3px}
.panel{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:12px}
/* пачки делят строку поровну — во всю ширину панелей; урезается имя, а не остаток */
.chips.packs{margin-top:12px;padding-bottom:0}
.chips.packs .chip{flex:1 1 0;min-width:0;display:flex;justify-content:center;gap:6px;padding:8px 12px;font-size:12.5px}
.chips.packs .chip span:first-child{overflow:hidden;text-overflow:ellipsis}
.chips.packs .chip span:last-child{flex:none;font-weight:600}
.pack-pic{position:relative;flex:none}
.pack-x{position:absolute;top:-7px;left:-7px;width:22px;height:22px;border-radius:50%;background:var(--s2);border:1px solid var(--line);color:var(--mute);font-size:10px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer}
.pack-x::before{content:"";position:absolute;inset:-10px}
.big{font-size:56px;font-weight:700;line-height:1}
.hint{color:var(--mute);font-size:12.5px;margin-top:3px;line-height:1.45}
.flash{border-radius:12px;padding:11px 14px;font-size:13.5px;margin-top:6px;background:var(--ok-bg);border:1px solid var(--ok-line);color:var(--ok-fg)}
.flash.err{background:var(--err-bg);border-color:var(--err-line);color:var(--err-fg)}
.sheet-bg{position:fixed;inset:0;background:var(--scrim);z-index:200;display:flex;align-items:flex-end;justify-content:center}
.sheet{background:var(--s1);border:1px solid var(--line);border-bottom:none;border-radius:20px 20px 0 0;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;padding:20px 16px calc(24px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 4px;font-size:17px}
.numgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:14px}
.numgrid button{aspect-ratio:1;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:600 16px Inter;cursor:pointer;padding:0}
.numgrid button.cur{border-color:var(--fg)}
.pick{display:flex;gap:12px;align-items:center;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:12px;margin-bottom:8px;cursor:pointer}
.pick.on{border-color:var(--fg)}
.switch{width:46px;height:28px;border-radius:14px;background:var(--line);border:none;position:relative;cursor:pointer;flex:none;padding:0}
.switch::after{content:"";position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:var(--mute);transition:left .15s}
.switch.on{background:var(--fg)}.switch.on::after{left:22px;background:var(--bg)}
.logrow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--s2);font-size:13.5px}
@keyframes inR{from{opacity:0;transform:translateX(32px)}to{opacity:1;transform:none}}
@keyframes inL{from{opacity:0;transform:translateX(-32px)}to{opacity:1;transform:none}}
.in-r{animation:inR .28s cubic-bezier(.2,.8,.2,1)}.in-l{animation:inL .28s cubic-bezier(.2,.8,.2,1)}
@keyframes vtOutL{to{opacity:0;transform:translateX(-40px)}}
@keyframes vtOutR{to{opacity:0;transform:translateX(40px)}}
@keyframes vtInR{from{opacity:0;transform:translateX(40px)}}
@keyframes vtInL{from{opacity:0;transform:translateX(-40px)}}
@keyframes vtFadeOut{to{opacity:0}}
@keyframes vtFadeIn{from{opacity:0}}
@keyframes vtSheetIn{from{transform:translateY(100%)}}
@keyframes vtSheetOut{to{transform:translateY(100%)}}
::view-transition-old(*),::view-transition-new(*){mix-blend-mode:normal}
::view-transition-old(root),::view-transition-old(tabpane){animation:vtFadeOut .16s cubic-bezier(.4,0,1,1) both}
::view-transition-new(root),::view-transition-new(tabpane){animation:vtFadeIn .3s cubic-bezier(0,0,.2,1) .06s both}
:root[data-nav=fwd]::view-transition-old(root),:root[data-nav=tab-r]::view-transition-old(tabpane){animation-name:vtOutL}
:root[data-nav=fwd]::view-transition-new(root),:root[data-nav=tab-r]::view-transition-new(tabpane){animation-name:vtInR}
:root[data-nav=back]::view-transition-old(root),:root[data-nav=tab-l]::view-transition-old(tabpane){animation-name:vtOutR}
:root[data-nav=back]::view-transition-new(root),:root[data-nav=tab-l]::view-transition-new(tabpane){animation-name:vtInL}
:root[data-nav=sheet]::view-transition-old(root){animation:vtFadeOut .24s ease both}
:root[data-nav=sheet]::view-transition-new(root){animation:vtFadeIn .24s ease both}
/* при смене вкладки едет только содержимое, шапка и вкладки стоят */
:root[data-nav^=tab] .swipe{view-transition-name:tabpane}
:root[data-nav^=tab] .fab{view-transition-name:fab}
:root[data-nav^=tab]::view-transition-old(root),:root[data-nav^=tab]::view-transition-new(root),::view-transition-group(tabpane){animation:none}
.sheet{view-transition-name:sheet}
::view-transition-group(sheet){animation:none}
::view-transition-new(sheet){animation:vtSheetIn .34s cubic-bezier(.2,.8,.2,1) both}
::view-transition-old(sheet){animation:vtSheetOut .22s cubic-bezier(.4,0,1,1) both}
`;

/* ── atoms ── */
const Tile = ({l, big}) => (
  <div className={(big?"herotile":"tile")+" disp"}>{(l.name||"?")[0].toUpperCase()}</div>
);

function Dots({v, onChange}) {
  return (
    <div className="dots">
      {[1,2,3,4,5].map(n=>(
        <button key={n} className={"dot"+(v>=n?" on":"")} onClick={()=>onChange(v===n?0:n)}/>
      ))}
    </div>
  );
}

function Chart({data}) {
  const W=340,H=170,P=26;
  const ps=data.map(d=>d.p),mn=Math.min(...ps),mx=Math.max(...ps),sp=mx-mn||1;
  const x=i=>P+(i*(W-2*P))/(data.length-1);
  const y=v=>H-P-((v-mn)*(H-2*P))/sp;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",marginTop:16}}>
      {[0,.5,1].map(t=><line key={t} x1={P} x2={W-P} y1={y(mn+sp*t)} y2={y(mn+sp*t)} stroke="var(--s2)"/>)}
      <polyline fill="none" stroke="var(--fg)" strokeWidth="2" points={data.map((d,i)=>`${x(i)},${y(d.p)}`).join(" ")}/>
      {data.map((d,i)=>(
        <g key={i}>
          <circle cx={x(i)} cy={y(d.p)} r="3.5" fill="var(--fg)"/>
          <text x={x(i)} y={y(d.p)-8} fill="var(--fg)" fontSize="9.5" textAnchor="middle">{d.p}</text>
          <text x={x(i)} y={H-8} fill="var(--mute)" fontSize="9" textAnchor="middle">{d.d}</text>
        </g>
      ))}
    </svg>
  );
}

// открытый лайтбокс перехватывает системный «назад»
let closeLightbox = null;
function Lightbox({src, onClose}) {
  useEffect(()=>{
    if (!src) return;
    closeLightbox = onClose;
    return ()=>{ closeLightbox = null; };
  },[src,onClose]);
  if (!src) return null;
  return <div className="lightbox" onClick={onClose}><img src={src} alt=""/></div>;
}

/* ── tracker page ── */
function Sheet({onClose, children}) {
  return <div className="sheet-bg" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}>{children}</div></div>;
}

// выделен показанный день (sel); нажимается вся колонка — низкий столбец иначе не попасть
function DayBars({data, onPick}) {
  const W=340,H=140,P=10,bw=(W-2*P)/data.length,mx=Math.max(...data.map(d=>d.v),1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%"}}>
      {data.map((d,i)=>{
        const h=d.v?(H-46)*d.v/mx:2, x=P+i*bw+3, w=bw-6, y=H-22-h;
        return (
          <g key={d.k}>
            <rect x={x} y={y} width={w} height={h} rx="3" fill={d.sel?"var(--fg)":d.v?"var(--line2)":"var(--line)"}/>
            {d.v>0&&<text x={x+w/2} y={y-5} fill={d.sel?"var(--fg)":"var(--mute)"} fontSize="10" textAnchor="middle">{d.v}</text>}
            <text x={x+w/2} y={H-7} fill={d.sel?"var(--fg)":"var(--mute2)"} fontSize="9" textAnchor="middle">{d.label}</text>
            {onPick&&<rect x={P+i*bw} y={0} width={bw} height={H} fill="transparent" style={{cursor:"pointer"}} role="button" aria-label={d.title} aria-pressed={d.sel} onClick={()=>onPick(d.k)}/>}
          </g>
        );
      })}
    </svg>
  );
}

function LeftSheet({pack, left, name, onPick, onClose}) {
  const t = useT();
  return (
    <Sheet onClose={onClose}>
      <h3 className="disp">{t("howMany")}</h3>
      <div className="hint">{t("byRecords", name, left, pack.size)}</div>
      <div className="numgrid">
        {Array.from({length:left+1},(_,n)=>(
          <button key={n} className={n===left?"cur":""} onClick={()=>onPick(n)}>{n}</button>
        ))}
      </div>
      <div className="hint" style={{marginTop:14}}>{t("leftHint")}</div>
    </Sheet>
  );
}

const StickPic = ({s}) => s?.photo
  ? <img src={photoSrc(s.photo)} style={{width:40,height:40,borderRadius:8,objectFit:"cover",flex:"none"}} alt=""/>
  : <div className="disp" style={{width:40,height:40,borderRadius:8,background:"var(--fg)",color:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flex:"none"}}>{(s?.name||"?")[0].toUpperCase()}</div>;
const stickSize = s => String(parseInt(s?.volume)||20);
const stickPrice = s => String(priceAt(s, today()) || "");

function PackSheet({sticks, cur, curLeft, open, onOpen, onSwitch, onClose, onAddSticks}) {
  const money = useCur(), t = useT(), lang = useContext(Ctx).lang;
  const lastId = cur?.stickId;
  const ordered = [...sticks].sort((a,b)=>
    (b.id===lastId)-(a.id===lastId) || (b.status==="have")-(a.status==="have") || (a.name||"").localeCompare(b.name||"",lang));
  const [sel, setSel] = useState(ordered[0]?.id||"");
  const [size, setSize] = useState(stickSize(ordered[0]));
  const [price, setPrice] = useState(stickPrice(ordered[0]));
  // пока не трогали — «докурил» только если открывают те же стики: другие курят параллельно
  const [finishSet, setFinish] = useState(null);
  const finish = finishSet ?? sel===cur?.stickId;
  const others = open.filter(p=>p.id!==cur?.id);
  const choose = s => { setSel(s.id); setSize(stickSize(s)); setPrice(stickPrice(s)); };

  if (!sticks.length) return (
    <Sheet onClose={onClose}>
      <h3 className="disp">{t("newPack")}</h3>
      <div className="hint" style={{margin:"6px 0 16px"}}>{t("addSticksFirst")}</div>
      <button className="btn" style={{width:"100%"}} onClick={onAddSticks}>{typeCfg("sticks",lang).addBtn}</button>
    </Sheet>
  );
  return (
    <Sheet onClose={onClose}>
      <h3 className="disp">{t("newPack")}</h3>
      {others.length>0&&(
        <>
          <div className="hint" style={{marginBottom:12}}>{t("openPacks")}</div>
          {others.map(p=>{
            const s = sticks.find(x=>x.id===p.stickId);
            return (
              <div key={p.id} className="pick" onClick={()=>onSwitch(p.id)}>
                <StickPic s={s}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14}}>{s?.name||t("deletedSticks")}</div>
                  <div className="hint" style={{marginTop:1}}>{t("leftOf", p.left, p.size)}</div>
                </div>
                <div style={{fontSize:20,fontWeight:700,flex:"none"}}>{p.left}</div>
              </div>
            );
          })}
        </>
      )}
      <div className="hint" style={{margin:others.length?"6px 0 12px":"0 0 12px"}}>{t("whichSticks")}</div>
      {ordered.map(s=>(
        <div key={s.id} className={"pick"+(sel===s.id?" on":"")} onClick={()=>choose(s)}>
          <StickPic s={s}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,fontSize:14}}>{s.name}</div>
            <div className="hint" style={{marginTop:1}}>{s.id===lastId?t("lastPack"):s.manufacturer}</div>
          </div>
          <div className={"chk"+(sel===s.id?" on":"")}>{sel===s.id?"✓":""}</div>
        </div>
      ))}
      <div className="row">
        <div><label>{t("pcs")}</label><input type="number" inputMode="numeric" value={size} onChange={e=>setSize(e.target.value)}/></div>
        <div><label>{t("packPrice", money)}</label><input type="number" inputMode="decimal" value={price} placeholder={t("optional")} onChange={e=>setPrice(e.target.value)}/></div>
      </div>
      {curLeft>0&&(
        <div className="pick" style={{marginTop:14}} onClick={()=>setFinish(!finish)}>
          <div className={"chk"+(finish?" on":"")}>{finish?"✓":""}</div>
          <div style={{flex:1,fontSize:13.5}}>{t("finishOld", sticks.find(s=>s.id===cur.stickId)?.name||t("deletedSticks"), curLeft)}</div>
        </div>
      )}
      <button className="btn" style={{width:"100%",marginTop:16,padding:"14px 16px"}} disabled={!sel||!(parseInt(size)>0)}
        onClick={()=>onOpen({stickId:sel, size:parseInt(size), price:parseFloat(price)||0, finishOld:curLeft>0&&finish})}>
        {t("openPack")}
      </button>
    </Sheet>
  );
}


function TrackerPage({trk, cur, open, sticks, flash, onAdd, onSwitch, onFinish, onDelEntry, onCancelPack, onSheet, onCfg}) {
  const {packs, log, cfg} = trk;
  const money = useCur(), t = useT();
  const left = packLeft(cur, log);
  // переключатель — между открытыми пачками; текущая в нём, даже если уже пустая
  const tabs = cur && !open.some(p=>p.id===cur.id) ? [...open, {...cur, left}] : open;
  const stick = cur && sticks.find(s=>s.id===cur.stickId);
  const totals = useMemo(()=>dayTotals(log),[log]);
  const packById = useMemo(()=>Object.fromEntries(packs.map(p=>[p.id,p])),[packs]);
  const tk = dayKey(Date.now());
  const todayN = totals[tk]||0, yestN = totals[shiftDay(tk,-1)]||0;
  const firstDay = log.length ? dayKey(log.reduce((m,e)=>Math.min(m,e.t), Infinity)) : tk;
  // среднее за n дней до дня from (сам он не входит)
  const avgOver = (n, from=tk) => {
    let s=0, c=0;
    for (let i=1; i<=n; i++) { const k=shiftDay(from,-i); if (k<firstDay) break; s+=totals[k]||0; c++; }
    return c ? s/c : null;
  };
  const avg7 = avgOver(7), avg30 = avgOver(30);
  // цена пачки — из истории цен стика на день открытия, так правка цены в каталоге сразу
  // пересчитывает траты; цена в самой пачке — запасная, если стик удалили или цен у него нет
  const packPrice = p => p && (priceAt(sticks.find(s=>s.id===p.stickId), localDate(new Date(p.opened))) || p.price);
  const cost = e => { const p = packById[e.pack], pr = packPrice(p); return pr ? e.n*pr/p.size : 0; };
  const costFrom = from => log.reduce((s,e)=>dayKey(e.t)>=from?s+cost(e):s, 0);
  const costToday = costFrom(tk), cost30 = costFrom(shiftDay(tk,-29));
  const nameOf = e => sticks.find(s=>s.id===packById[e.pack]?.stickId)?.name || "";
  // день, показанный вместо «Сегодня»: выбирают столбцом графика, повторное нажатие — обратно сегодня.
  // Журнал изменился (+1, остаток, пустой журнал без графика) — снова сегодня, чтобы новая запись
  // была видна. Сегодня — это null, а не дата: после полуночи «сегодня» сдвинется само
  const [day, setDay] = useState(null);
  const sel = day && day.n===log.length ? day.k : tk, isToday = sel===tk;
  const pickDay = k => setDay(k===sel||k===tk ? null : {k, n:log.length});
  const weekday = k => t("weekdays")[parseDay(k).getDay()];
  const dayLog = log.filter(e=>dayKey(e.t)===sel).sort((a,b)=>b.t-a.t);
  const dayN = totals[sel]||0, dayCost = dayLog.reduce((s,e)=>s+cost(e), 0);
  // со средним за 7 дней перед выбранным; сегодня ещё не кончилось — сравнивать рано
  const avgBefore = isToday ? null : avgOver(7, sel);
  const vsAvg = avgBefore!=null && dayN>0 ? +(dayN-avgBefore).toFixed(1) : null;
  const bars = Array.from({length:14},(_,i)=>{
    const k = shiftDay(tk,i-13);
    return {k, v:totals[k]||0, sel:k===sel, label:k===tk?t("todayShort"):weekday(k), title:`${weekday(k)}, ${fmtDate(k).slice(0,5)}: ${totals[k]||0}`};
  });
  const daysLeft = avg7 && left>0 ? left/avg7 : null;
  const forecast = daysLeft==null ? "" : daysLeft<1 ? t("endsToday") : t("lastsDays", daysLeft.toFixed(daysLeft<3?1:0));
  const bigBtn = {width:"100%",marginTop:14,padding:"15px 16px",fontSize:15};

  return (
    <div>
      {flash&&<div className={"flash"+(flash.err?" err":"")}>{flash.text}</div>}

      <div className="panel">
        <div style={{display:"flex",alignItems:"flex-end",gap:10}}>
          <div className="big disp">{todayN}</div>
          <div style={{paddingBottom:6,color:"var(--mute)",fontSize:14}}>{t("todayN", todayN)}</div>
        </div>
        <div className="hint" style={{marginTop:10}}>
          {t("yest", yestN)}
          {avg7!=null&&t("perDay", avg7.toFixed(1))}
          {costToday>0&&` · ≈ ${Math.round(costToday)} ${money}`}
        </div>
      </div>

      {tabs.length>1&&(
        <div className="chips packs">
          {tabs.map(p=>(
            <button key={p.id} className={"chip"+(p.id===cur?.id?" on":"")} onClick={()=>p.id!==cur?.id&&onSwitch(p.id)}>
              <span>{sticks.find(s=>s.id===p.stickId)?.name||t("deletedSticks")}</span><span>{p.left}</span>
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        {cur ? (
          <>
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              <div className="pack-pic">
                {stick?.photo?<img src={photoSrc(stick.photo)} className="thumb" alt=""/>:<Tile l={stick||{name:"?"}}/>}
                {left>0&&<button className="pack-x" aria-label={t("finishPack")} title={t("finishPack")} onClick={onFinish}>✕</button>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:15}}>{stick?.name||t("deletedSticks")}</div>
                <div className="hint">{t("openedAt", fmtDate(localDate(new Date(cur.opened))))}{forecast&&` · ${forecast}`}</div>
              </div>
              <div style={{textAlign:"right",flex:"none"}}>
                <div style={{fontSize:28,fontWeight:700,lineHeight:1}}>{left}</div>
                <div className="hint">{t("ofN", cur.size)}</div>
              </div>
            </div>
            <div className="sbar" style={{marginTop:12}}><div className="sbar-fill" style={{width:`${Math.max(0,left)/cur.size*100}%`}}/></div>
            {left>0
              ? <button className="btn" style={bigBtn} onClick={onAdd}>{t("plusOne")}</button>
              : <button className="btn" style={bigBtn} onClick={()=>onSheet("pack")}>{t("packOut")}</button>}
            <div className="row" style={{marginTop:8}}>
              <button className="btn ghost" disabled={left<=0} onClick={()=>onSheet("left")}>{t("enterLeft")}</button>
              <button className="btn ghost" onClick={()=>onSheet("pack")}>{t("newPack")}</button>
            </div>
            {left===cur.size&&(
              <button className="back" style={{padding:"12px 0 0",fontSize:12,margin:"0 auto"}} onClick={()=>onCancelPack(cur.id)}>{t("cancelPack")}</button>
            )}
          </>
        ) : (
          <div style={{textAlign:"center",padding:"8px 0"}}>
            <div style={{fontWeight:600}}>{t("noPack")}</div>
            <div className="hint" style={{marginBottom:14}}>{t("noPackHint")}</div>
            <button className="btn" onClick={()=>onSheet("pack")}>{t("openPack")}</button>
          </div>
        )}
      </div>

      {cfg.remind===null&&(
        <div className="panel">
          <div style={{fontWeight:600}}>{t("remindAsk")}</div>
          <div className="hint">{t("remindAskHint", cfg.time)}</div>
          <div className="row" style={{marginTop:12}}>
            <button className="btn" onClick={()=>onCfg({remind:true})}>{t("enable")}</button>
            <button className="btn ghost" onClick={()=>onCfg({remind:false})}>{t("noThanks")}</button>
          </div>
        </div>
      )}

      <div className="sec">{isToday ? t("secToday") : `${weekday(sel)}, ${fmtDate(sel).slice(0,5)}`}</div>
      {dayLog.length>0&&(
        <div className="hint" style={{marginBottom:4}}>
          {`${dayN} ${t("sticksWord", dayN)}`}
          {dayCost>0&&` · ≈ ${Math.round(dayCost)} ${money}`}
          {vsAvg!=null&&` · ${t("vsAvg", (vsAvg>0?"+":vsAvg<0?"−":"±")+Math.abs(vsAvg))}`}
        </div>
      )}
      {dayLog.length===0
        ? <div className="hint">{t(isToday?"nothingYet":"nothingDay")}</div>
        : dayLog.map(e=>(
          <div className="logrow" key={e.id}>
            <span style={{color:"var(--mute)",width:42,flex:"none"}}>{fmtTime(e.t)}</span>
            <span style={{fontWeight:600,width:32,flex:"none"}}>+{e.n}</span>
            <span style={{flex:1,minWidth:0,color:"var(--mute)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {[e.kind&&t("kind."+e.kind), nameOf(e)].filter(Boolean).join(" · ")}
            </span>
            {isToday&&<button className="btn ghost" style={{padding:"4px 10px",fontSize:11,flex:"none"}} onClick={()=>onDelEntry(e.id)}>✕</button>}
          </div>
        ))}

      {log.length>0&&(
        <>
          <div className="sec">{t("days14")}</div>
          <DayBars data={bars} onPick={pickDay}/>
          <div className="meta">
            <div><small>{t("avg7")}</small>{avg7!=null?avg7.toFixed(1):"—"}</div>
            <div><small>{t("avg30")}</small>{avg30!=null?avg30.toFixed(1):"—"}</div>
            <div><small>{t("maxDay")}</small>{Math.max(0,...Object.values(totals))}</div>
            <div><small>{t("total")}</small>{log.reduce((s,e)=>s+e.n,0)}</div>
            <div><small>{t("packs")}</small>{packs.length}</div>
            <div><small>{t("spent30")}</small>{cost30>0?Math.round(cost30)+" "+money:"—"}</div>
          </div>
        </>
      )}

    </div>
  );
}

/* ── settings ── */
function SettingsPage({app, onApp, trkCfg, onTrkCfg, onTest, flash, onFlash, onBack}) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyCheck, setKeyCheck] = useState({state:""});
  useEffect(()=>{
    if (!app.ai || !app.geminiKey) { setKeyCheck({state:""}); return; }
    // этот ключ уже проверяли — не ходим в сеть при каждом заходе в настройки
    const known = keyChecks.get(app.geminiKey);
    if (known) { setKeyCheck(known); return; }
    setKeyCheck({state:"checking"});
    const ac = new AbortController();
    // ждём, пока допечатают / вставят ключ целиком
    const tm = setTimeout(()=>checkGeminiKey(app.geminiKey, ac.signal).then(r=>{
      if (r.state!=="net") keyChecks.set(app.geminiKey, r); // сбой сети — проверим в следующий раз
      setKeyCheck(r);
    }, ()=>{}), 600);
    return ()=>{ clearTimeout(tm); ac.abort(); };
  },[app.ai, app.geminiKey]);
  const chips = (opts, val, onPick) => (
    <div className="chips">
      {opts.map(([k,label])=>(
        <button key={k} className={"chip"+(val===k?" on":"")} onClick={()=>onPick(k)}>{label}</button>
      ))}
    </div>
  );
  const run = async (kind, fn) => {
    setBusy(kind);
    try { await fn(); } catch (e) { onFlash({err:true, text:t({restore:"restoreFail", share:"shareFail"}[kind]||"backupFail")+(e?.message||String(e))}); }
    setBusy("");
  };
  const save = () => run("save", async ()=>onFlash({text:t("backupSaved", await saveBackupFile(await makeBackup()))}));
  const share = () => run("share", async ()=>{
    try { await shareBackupFile(await makeBackup(false)); }
    catch (e) { if (!/cancel/i.test(e?.message||"")) throw e; } // закрыли окно «поделиться» — не ошибка
  });
  const restore = e => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    run("restore", async ()=>{
      const b = parseBackup(await file.text());
      if (!b) return onFlash({err:true, text:t("restoreBad")});
      // дата только для вопроса: кривая (null, «abc», за пределами Date) — спрашиваем без неё
      let made = null;
      try { if (typeof b.created==="string") made = fmtDate(localDate(new Date(b.created))); } catch {}
      if (!confirm(t("restoreAsk", made))) return;
      await restoreBackup(b);
      location.reload();
    });
  };

  return (
    <div>
      <button className="back" onClick={onBack}>{t("back")}</button>
      <h1 className="disp" style={{fontSize:19,margin:"14px 0 0"}}>{t("settings")}</h1>
      {flash&&<div className={"flash"+(flash.err?" err":"")} style={{marginTop:14}}>{flash.text}</div>}

      <div className="sec">{t("theme")}</div>
      {chips(THEMES.map(k=>[k,t(k)]), app.theme, theme=>onApp({theme}))}

      <div className="sec">{t("lang")}</div>
      {chips(Object.entries(LANGS), app.lang, lang=>onApp({lang}))}

      <div className="sec">{t("currency")}</div>
      {chips(Object.entries(CURRENCIES).map(([k,sym])=>[k,`${sym[app.lang]} · ${k}`]), app.currency, currency=>onApp({currency}))}
      <div className="hint">{t("currencyHint")}</div>

      <div className="sec">{t("remind")}</div>
      <div className="panel" style={{marginTop:0}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>{t("remindTitle")}</div>
            <div className="hint">{NATIVE?t("remindNative"):t("remindWeb")}</div>
          </div>
          <button className={"switch"+(trkCfg.remind?" on":"")} onClick={()=>onTrkCfg({remind:!trkCfg.remind})}/>
        </div>
        {trkCfg.remind&&(
          <div className="row" style={{marginTop:12}}>
            <input type="time" value={trkCfg.time} onChange={e=>e.target.value&&onTrkCfg({time:e.target.value})}/>
            <button className="btn ghost" style={{flex:"none"}} onClick={onTest}>{t("test")}</button>
          </div>
        )}
      </div>

      <div className="sec">{t("ai")}</div>
      <div className="panel" style={{marginTop:0}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>{t("aiTitle")}</div>
            <div className="hint">{t("aiHint")}</div>
          </div>
          <button className={"switch"+(app.ai?" on":"")} onClick={()=>onApp({ai:!app.ai})}/>
        </div>
        {app.ai&&(
          <>
            <label>{t("aiKey")}</label>
            <div className="row" style={{marginTop:0}}>
              <input type={showKey?"text":"password"} value={app.geminiKey} autoComplete="off" spellCheck={false}
                placeholder="AIza…" onChange={e=>onApp({geminiKey:e.target.value.trim()})}/>
              <button className="btn ghost" style={{flex:"none"}} onClick={()=>setShowKey(v=>!v)}>{showKey?"🙈":"👁"}</button>
            </div>
            {!app.geminiKey&&<div className="err">{t("aiKeyEmpty")}</div>}
            {keyCheck.state==="checking"&&<div className="hint" style={{marginTop:10}}><span className="spin"/>{t("aiKeyChecking")}</div>}
            {keyCheck.state==="ok"&&<div className="hint" style={{marginTop:10,color:"var(--fg)"}}>{t("aiKeyOk")}</div>}
            {keyCheck.state==="bad"&&<div className="err">{t("aiKeyBad")+keyCheck.msg}</div>}
            {keyCheck.state==="net"&&<div className="err">{t("aiKeyNet")}</div>}
            <div className="hint" style={{marginTop:10}}>{t("aiKeyHint")}</div>
          </>
        )}
      </div>

      <div className="sec">{t("backup")}</div>
      <div className="hint" style={{marginBottom:12}}>{t("backupHint")}</div>
      <div className="row">
        <button className="btn" disabled={!!busy} onClick={save}>{busy==="save"&&<span className="spin"/>}{t("backupSave")}</button>
        <button className="btn ghost" disabled={!!busy} onClick={share}>{busy==="share"&&<span className="spin"/>}{t("backupShare")}</button>
      </div>
      <label className="btn ghost" style={{display:"block",textAlign:"center",margin:"10px 0 0",textTransform:"none",letterSpacing:0,fontSize:13,color:"var(--fg)",opacity:busy?.45:1}}>
        {busy==="restore"&&<span className="spin"/>}{t("restore")}
        <input type="file" disabled={!!busy} onChange={restore} style={{display:"none"}}/>
      </label>
    </div>
  );
}

/* ── compare ── */
function ComparePage({ids, type, items, onBack}) {
  const cfg = useTypeCfg(type), cur = useCur(), t = useT();
  const [a,b] = ids.map(id=>items.find(l=>l.id===id));
  if (!a||!b) return <div><button className="back" onClick={onBack}>{t("back")}</button><div className="empty">{t("need2")}</div></div>;
  return (
    <div>
      <button className="back" onClick={onBack}>{t("back")}</button>
      <h1 className="disp" style={{fontSize:19,margin:"14px 0 16px"}}>{t("compare")}</h1>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:18}}>
        {[a,b].map(l=>(
          <div key={l.id} style={{background:"var(--s1)",border:"1px solid var(--line)",borderRadius:12,padding:12,textAlign:"center"}}>
            {l.photo?<img src={photoSrc(l.photo)} style={{width:64,height:64,borderRadius:12,objectFit:"cover",marginBottom:8}} alt=""/>
              :<div style={{width:64,height:64,borderRadius:12,background:"var(--fg)",color:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:24,margin:"0 auto 8px"}}>{(l.name||"?")[0]}</div>}
            <div style={{fontSize:13,fontWeight:600,lineHeight:1.3,marginBottom:4}}>{l.name}</div>
            <div style={{fontSize:18,fontWeight:700}}>{avgRating(l,cfg.criteria)>0?avgRating(l,cfg.criteria).toFixed(1):"—"}</div>
          </div>
        ))}
      </div>
      <div className="sec">{t("byCrit")}</div>
      {cfg.criteria.map(([k,label])=>{
        const va=a.ratings?.[k]||0, vb=b.ratings?.[k]||0, win=va>vb?"a":vb>va?"b":"";
        return (
          <div key={k} style={{marginBottom:14}}>
            <div style={{fontSize:11,color:"var(--mute)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:6}}>{label}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 52px 1fr",gap:8,alignItems:"center"}}>
              <div style={{height:6,background:"var(--s2)",borderRadius:3,display:"flex",justifyContent:"flex-end"}}>
                <div style={{height:"100%",width:`${(va/5)*100}%`,background:win==="a"?"var(--fg)":"var(--line2)",borderRadius:3}}/>
              </div>
              <div style={{textAlign:"center",fontSize:12,color:"var(--mute)"}}>{va||"—"} / {vb||"—"}</div>
              <div style={{height:6,background:"var(--s2)",borderRadius:3}}>
                <div style={{height:"100%",width:`${(vb/5)*100}%`,background:win==="b"?"var(--fg)":"var(--line2)",borderRadius:3}}/>
              </div>
            </div>
          </div>
        );
      })}
      <div className="sec">{t("price")}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {[a,b].map(l=>{
          const lp=lastPrice(l), ppm=pricePerUnit(l);
          return (
            <div key={l.id} style={{background:"var(--s1)",border:"1px solid var(--line)",borderRadius:12,padding:12}}>
              <div style={{fontSize:18,fontWeight:700}}>{lp?lp.price+" "+cur:"—"}</div>
              {ppm&&<div style={{fontSize:12,color:"var(--mute)",marginTop:2}}>{ppm} {cur}/{cfg.unit}</div>}
              {l.volume&&<div style={{fontSize:12,color:"var(--mute2)",marginTop:2}}>{l.volume}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── form ── */
function Form({initial, type, onSave, onCancel}) {
  const cfg = useTypeCfg(type), t = useT(), {lang, ai} = useContext(Ctx);
  const [f, setF] = useState(initial||{id:uid(),name:"",manufacturer:"",flavor:"",volume:"",nicotine:"",description:"",photo:"",ratings:{},prices:[],favorite:false,status:""});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [lb, setLb] = useState("");
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const aiReady = ai.on && !!ai.key;

  const search = async () => {
    setBusy(true); setErr("");
    const before = f;
    try {
      const r = await aiSearch(q||`${f.manufacturer} ${f.name}`, type, lang, ai.key);
      const keys = ["manufacturer","name","flavor","volume", ...(cfg.showNicotine?["nicotine"]:[])];
      // поле, которое поправили, пока ждали ответа, не трогаем
      setF(p=>({...p, ...Object.fromEntries(keys.map(k=>[k, p[k]!==before[k] ? p[k] : aiField(k, r[k])??p[k]]))}));
    } catch (e) { setErr(t("errPrefix") + (e?.name==="TimeoutError" ? t("aiTimeout") : e?.aiCode ? t(e.aiCode) : e?.message || String(e))); }
    setBusy(false);
  };

  const pickFile = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try { set("photo", await compressImg(file)); } catch { setErr(t("photoErr")); }
  };

  return (
    <div>
      <button className="back" onClick={onCancel}>{t("back")}</button>
      <h1 className="disp" style={{fontSize:19,margin:"14px 0 4px"}}>{initial?t("edit"):cfg.newTitle}</h1>
      <label style={aiReady?null:{opacity:.45}}>{t("webSearch")}</label>
      <div className="row">
        <input placeholder={cfg.searchPlaceholder} value={q} onChange={e=>setQ(e.target.value)} disabled={!aiReady}/>
        <button className="btn" style={{flex:"none"}} disabled={!aiReady||busy||!(q||f.name)} onClick={search}>
          {busy&&<span className="spin"/>}{t("find")}
        </button>
      </div>
      {!aiReady&&<div className="hint">{t(ai.on?"aiNoKey":"aiOff")}</div>}
      {err&&<div className="err">{err}</div>}
      <label>{t("manufacturer")}</label><input value={f.manufacturer} onChange={e=>set("manufacturer",e.target.value)}/>
      <label>{t("name")}</label><input value={f.name} onChange={e=>set("name",e.target.value)}/>
      <label>{t("flavorDesc")}</label><input value={f.flavor} onChange={e=>set("flavor",e.target.value)}/>
      <div className="row">
        <div>
          <label>{cfg.volumeLabel}</label>
          <input value={f.volume} onChange={e=>set("volume",e.target.value)} placeholder={cfg.volumePlaceholder}/>
        </div>
        {cfg.showNicotine&&(
          <div>
            <label>{t("strength")}</label>
            <div className="row" style={{marginTop:0}}>
              {NICOTINE.map(v=>(
                <button key={v} className={"btn"+(f.nicotine===v?"":" ghost")} onClick={()=>set("nicotine",v)}>{v}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <label>{t("status")}</label>
      <div className="row">
        {Object.entries(STATUSES).map(([k,{color}])=>(
          <button key={k} className={"btn"+(f.status===k?"":" ghost")} style={{fontSize:12,padding:"9px 6px"}}
            onClick={()=>set("status",f.status===k?"":k)}>
            <span className="badge" style={{background:color}}/>{t("st."+k)}
          </button>
        ))}
      </div>
      <label>{t("notes")}</label>
      <textarea rows={2} value={f.description} onChange={e=>set("description",e.target.value)}/>
      <label>{t("ownPhoto")}</label>
      <div className="row">
        <label className="btn ghost" style={{textAlign:"center",margin:0,textTransform:"none",letterSpacing:0,fontSize:13,color:"var(--fg)"}}>
          {t("camera")}<input type="file" accept="image/*" capture="environment" onChange={pickFile} style={{display:"none"}}/>
        </label>
        <label className="btn ghost" style={{textAlign:"center",margin:0,textTransform:"none",letterSpacing:0,fontSize:13,color:"var(--fg)"}}>
          {t("gallery")}<input type="file" accept="image/*" onChange={pickFile} style={{display:"none"}}/>
        </label>
        {f.photo&&<button className="btn ghost" style={{flex:"none"}} onClick={()=>set("photo","")}>✕</button>}
      </div>
      {f.photo&&<img src={photoSrc(f.photo)} className="hero" alt="" onClick={()=>setLb(photoSrc(f.photo))} style={{cursor:"zoom-in"}}/>}
      <Lightbox src={lb} onClose={()=>setLb("")}/>
      <div className="row" style={{marginTop:22}}>
        <button className="btn" disabled={!f.name.trim()} onClick={()=>onSave(f)}>{t("save")}</button>
      </div>
    </div>
  );
}

/* ── detail ── */
function Detail({l, type, smoked, onUpdate, onEdit, onDelete, onBack, onStartCompare}) {
  const cfg = useTypeCfg(type), cur = useCur(), t = useT();
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState("");
  const [lb, setLb] = useState("");
  const [sharing, setSharing] = useState(false);
  const prices = useMemo(()=>[...(l.prices||[])].sort((a,b)=>a.date.localeCompare(b.date)),[l.prices]);
  const chart = prices.map(p=>({d:fmtDate(p.date).slice(0,5),p:p.price}));
  const ppm = pricePerUnit(l);
  const avg = avgRating(l, cfg.criteria);
  const st = l.status && STATUSES[l.status];

  const addPrice = () => {
    const v = parseFloat(price.replace(",",".")); if (!v) return;
    // свежая покупка — значит, есть в наличии; задним числом для истории статус не трогаем
    const fresh = (l.prices||[]).every(p=>p.date<=date);
    onUpdate({...l, prices:[...(l.prices||[]),{date,price:v}], ...(fresh?{status:"have"}:{})}); setPrice("");
  };
  const delPrice = i => onUpdate({...l, prices:l.prices.filter((_,j)=>j!==i)});
  const setRating = (k,v) => onUpdate({...l, ratings:{...(l.ratings||{}),[k]:v}});
  const doShare = async () => { setSharing(true); try { await shareCard(l,cfg,cur,t); } catch {} setSharing(false); };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <button className="back" onClick={onBack}>{cfg.backLabel}</button>
        <button className="back" onClick={()=>onUpdate({...l,favorite:!l.favorite})} style={{color:l.favorite?"var(--star)":"var(--mute)"}}>
          {l.favorite?t("favOn"):t("favOff")}
        </button>
      </div>
      {l.photo?<img src={photoSrc(l.photo)} className="hero" alt="" onClick={()=>setLb(photoSrc(l.photo))} style={{cursor:"zoom-in"}} onError={e=>e.target.style.display="none"}/>:<Tile l={l} big/>}
      <Lightbox src={lb} onClose={()=>setLb("")}/>
      <h1 className="disp" style={{fontSize:21,margin:"16px 0 2px"}}>{l.name}</h1>
      <div style={{color:"var(--mute)",fontSize:13,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        {l.manufacturer}
        {st&&<span><span className="badge" style={{background:st.color}}/>{t("st."+l.status)}</span>}
      </div>
      {avg>0&&<div style={{fontSize:28,fontWeight:700,margin:"8px 0 0"}}>{avg.toFixed(1)}<span style={{fontSize:14,color:"var(--mute)",fontWeight:400,marginLeft:6}}>{t("avgShort")}</span></div>}
      <div className="meta">
        {l.flavor&&<div style={{gridColumn:"1/-1"}}><small>{t("taste")}</small>{l.flavor}</div>}
        {l.volume&&<div><small>{cfg.volumeLabel}</small>{l.volume}</div>}
        {l.nicotine&&<div><small>{t("strength")}</small>{l.nicotine}</div>}
        {ppm&&<div><small>{t("perUnit", cfg.unit)}</small>{ppm} {cur}/{cfg.unit}</div>}
        {smoked?.packs>0&&<div><small>{t("smoked")}</small>{t("smokedVal", smoked.n, smoked.packs)}</div>}
        {l.description&&<div style={{gridColumn:"1/-1"}}><small>{t("notes")}</small>{l.description}</div>}
      </div>
      <div className="sec">{t("rating")}</div>
      {cfg.criteria.map(([k,label])=>(
        <div className="crit" key={k}>
          <span>{label}</span>
          <Dots v={l.ratings?.[k]||0} onChange={v=>setRating(k,v)}/>
        </div>
      ))}
      <div className="sec">{t("price")}</div>
      <div className="row">
        <input type="date" value={date} onChange={e=>setDate(e.target.value)}/>
        <input type="number" inputMode="decimal" placeholder={cur} value={price} onChange={e=>setPrice(e.target.value)}/>
        <button className="btn" style={{flex:"none"}} disabled={!price} onClick={addPrice}>+</button>
      </div>
      {chart.length>1&&<Chart data={chart}/>}
      {prices.length>0&&(
        <table>
          <thead><tr><th>{t("date")}</th><th>{t("price")}</th><th></th></tr></thead>
          <tbody>
            {prices.map((p,i)=>(
              <tr key={i}>
                <td>{fmtDate(p.date)}</td><td>{p.price} {cur}</td>
                <td><button className="btn ghost" style={{padding:"4px 10px",fontSize:11}} onClick={()=>delPrice(l.prices.indexOf(p))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{marginTop:28}}>
        <button className="btn ghost" onClick={onEdit}>{t("edit")}</button>
        <button className="btn ghost" onClick={()=>onStartCompare(l.id)}>{t("cmpWith")}</button>
      </div>
      <div className="row" style={{marginTop:10}}>
        <button className="btn ghost" disabled={sharing} onClick={doShare}>
          {sharing&&<span className="spin"/>}{t("share")}
        </button>
        <button className="btn danger" onClick={()=>confirm(cfg.deleteMsg)&&onDelete(l.id)}>{t("del")}</button>
      </div>
    </div>
  );
}

/* ── app ── */
export default function App() {
  const [tab, setTab] = useState("vape");
  const [allItems, setAllItems] = useState(()=>Object.fromEntries(Object.keys(TYPES).map(t=>[t,[]])));
  const [view, setViewNow] = useState({page:"list"});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterFav, setFilterFav] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [cmpMode, setCmpMode] = useState(false);
  const [cmpIds, setCmpIds] = useState([]);
  const [trk, setTrk] = useState(TRK_DEFAULT);
  const [sheet, setSheetNow] = useState(null);
  const [flash, setFlash] = useState(null);
  const [pendingAct, setPendingAct] = useState(null);
  const [slide, setSlide] = useState("");
  const [app, setApp] = useState(APP_DEFAULT);
  // also — остальные изменения того же действия: идут в тот же переход, чтобы старый экран
  // сняли целиком до них, а не наполовину обновлённым
  // экран меняется, даже если also упал: иначе шторка осталась бы открытой и действие повторили бы
  const setView = (v, also) => animate(navDir(view, v), ()=>{ try { also?.(); } finally { setViewNow(v); } });
  const setSheet = (s, also) => animate("sheet", ()=>{ try { also?.(); } finally { setSheetNow(s); } });

  // только что прочитанное: эффекты записи пропускают его, а не пишут обратно при каждом запуске
  const loaded = useRef(null);
  useEffect(()=>{
    const types = Object.keys(TYPES);
    // без базы фото карточки с файлами не покажутся — но и без неё работаем дальше
    initPhotos().catch(()=>{}).then(()=>Promise.all([
      ...types.map(loadAll),
      loadTracker().then(async tr=>[tr, await loadSettings(tr.cfg)]),
    ])).then(res=>{
      const [tr, ap] = res.at(-1);
      loaded.current = {trk:tr, app:ap};
      setAllItems(Object.fromEntries(types.map((t,i)=>[t,res[i]]))); setTrk(tr); setApp(ap); setLoading(false);
      // напоминание включено, а разрешения нет — например, бэкап восстановили на другом телефоне.
      // Только проверяем: запрос при холодном старте Android может отклонить, не показав диалог,
      // а переключатель в настройках запросит его сам
      if (tr.cfg.remind && NATIVE) LocalNotifications.checkPermissions().then(({display})=>{
        if (display==="granted") return;
        setTrk(p=>({...p, cfg:{...p.cfg, remind:false}}));
        // при запуске открыт список, где flash не выводится, — поэтому окном
        alert(makeT(ap.lang)("notifLost"));
      }).catch(()=>{});
    });
  },[]);

  const langRef = useRef(app.lang);
  langRef.current = app.lang;
  const storeFail = e => reportStoreFail(langRef.current, e);
  useEffect(()=>{ if (!loading && (trk.packs!==loaded.current.trk.packs || trk.log!==loaded.current.trk.log || trk.cur!==loaded.current.trk.cur)) saveTracker("data",{packs:trk.packs, log:trk.log, cur:trk.cur}).catch(e=>reportStoreFail(langRef.current, e, true)); },[loading,trk.packs,trk.log,trk.cur]);
  useEffect(()=>{ if (!loading && trk.cfg!==loaded.current.trk.cfg) saveTracker("cfg",trk.cfg).catch(e=>reportStoreFail(langRef.current, e, true)); },[loading,trk.cfg]);
  useEffect(()=>{ if (!loading && app!==loaded.current.app) saveSettings(app).catch(e=>reportStoreFail(langRef.current, e, true)); },[loading,app]);

  const {lang, theme} = app;
  const t = useMemo(()=>makeT(lang),[lang]);
  const cur = (CURRENCIES[app.currency] || CURRENCIES[APP_DEFAULT.currency])[lang];
  const ai = useMemo(()=>({on:app.ai, key:app.geminiKey}),[app.ai,app.geminiKey]);
  const ctx = useMemo(()=>({cur, lang, t, ai}),[cur,lang,t,ai]);
  useEffect(()=>{
    document.documentElement.dataset.theme = theme;
    // Style.Light — тёмные значки для светлого фона
    if (NATIVE) StatusBar.setStyle({ style: theme==="light" ? Style.Light : Style.Dark }).catch(()=>{});
  },[theme]);
  useEffect(()=>{ document.documentElement.lang = lang; registerActions(t); },[lang,t]);

  const sticks = allItems.sticks;
  const curPack = trk.packs.find(p=>p.id===trk.cur);
  const curLeft = packLeft(curPack, trk.log);
  const open = useMemo(()=>openPacks(trk.packs, trk.log),[trk.packs,trk.log]);
  const curName = curPack ? (sticks.find(s=>s.id===curPack.stickId)?.name||t("sticksDefault")) : "";
  // напоминание — про текущую пачку, а если она уже пустая — про последнюю открытую
  const remPack = curLeft>0 ? curPack : open.at(-1) || curPack;
  const remLeft = packLeft(remPack, trk.log);
  const remName = remPack ? (sticks.find(s=>s.id===remPack.stickId)?.name||t("sticksDefault")) : "";
  // серия +1 — одно обновление напоминаний, а не по одному на каждое нажатие
  useEffect(()=>{
    if (loading) return;
    const tm = setTimeout(()=>syncReminder(trk.cfg, remPack, remLeft, remName, t), 500);
    return ()=>clearTimeout(tm);
  },[loading,trk.cfg,remPack,remLeft,remName,t]);

  // статус в каталоге идёт за счётчиком: пачка снова открыта (удалили запись) — «В наличии»,
  // докурили последнюю открытую пачку этих стиков — «Закончилось». Пять путей, которыми пачка
  // кончается или открывается, сходятся здесь. Только на переходах: ручной статус между ними
  // не трогаем. Отменённая пачка (её больше нет) — не «докурили», статус вернёт cancelPack
  const openIds = open.map(p=>p.id).join(" ");
  const prevOpen = useRef(null);
  useEffect(()=>{
    if (loading) return;
    const prev = prevOpen.current, now = new Set(openIds.split(" ").filter(Boolean));
    prevOpen.current = now;
    if (!prev) return;
    const byId = Object.fromEntries(trk.packs.map(p=>[p.id,p]));
    const opened = new Set([...now].filter(id=>!prev.has(id)).map(id=>byId[id].stickId));
    const stillOpen = new Set(open.map(p=>p.stickId));
    const ended = new Set([...prev].filter(id=>!now.has(id)&&byId[id]&&!stillOpen.has(byId[id].stickId)).map(id=>byId[id].stickId));
    sticks.forEach(s=>{
      const status = opened.has(s.id)&&s.status!=="have" ? "have" : ended.has(s.id)&&s.status==="have" ? "out" : null;
      if (status) upsert({...s, status}, "sticks");
    });
  // sticks берём из текущего рендера: срабатывать на правку карточки не нужно
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  },[loading,openIds]);

  useEffect(()=>{
    if (!NATIVE) return;
    const sub = LocalNotifications.addListener("localNotificationActionPerformed", a=>{
      const kind = a.notification?.extra?.kind;
      if (kind==="checkin"||kind==="summary") setPendingAct({input:a.inputValue, id:a.notification.id, kind, pack:a.notification.extra.pack});
    });
    return ()=>{ sub.then(h=>h.remove()); };
  },[]);

  useEffect(()=>{
    if (!flash) return;
    const t = setTimeout(()=>setFlash(null), 6000);
    return ()=>clearTimeout(t);
  },[flash]);

  // слушатель «назад» один на всё время; актуальное состояние берёт через ref
  const backRef = useRef(null);
  useEffect(()=>{
    const sub = CapApp.addListener("backButton",()=>backRef.current?.());
    return ()=>{ sub.then(h=>h.remove()); };
  },[]);

  const items = allItems[tab] || NO_ITEMS;
  const setItems = fn => setAllItems(p=>({...p,[tab]:fn(p[tab])}));
  const cfg = TYPES[tab] && typeCfg(tab, lang);

  const upsert = (l, type=tab) => {
    const setOf = fn => setAllItems(p=>({...p,[type]:fn(p[type])}));
    // новое фото записано файлом — в состоянии заменяем data:-url путём, если карточку не успели поменять
    save(l,type).then(s=>{ if (s.photo!==l.photo) setOf(p=>p.map(x=>x.id===s.id&&x.photo===l.photo?{...x, photo:s.photo}:x)); }).catch(storeFail);
    setOf(p=>{const i=p.findIndex(x=>x.id===l.id); return i<0?[...p,l]:p.map(x=>x.id===l.id?l:x);});
  };
  const del = id => {
    remove(id,tab).catch(storeFail); setView({page:"list"}, ()=>setItems(p=>p.filter(x=>x.id!==id)));
  };
  const switchTab = t => {
    const dir = tabIndex(t)>tabIndex(tab)?"r":tabIndex(t)<tabIndex(tab)?"l":"";
    const go = ()=>{
      // без View Transitions — старая анимация въезда вкладки
      setSlide(!VT&&dir?"in-"+dir:"");
      setTab(t); setViewNow({page:"list"}); setSearch(""); setFilterFav(false);
      setFilterStatus(""); setCmpMode(false); setCmpIds([]);
    };
    // повторный тап по открытой вкладке — просто сброс, без анимации
    const nav = view.page!=="list" ? "back" : dir&&"tab-"+dir;
    if (nav) animate(nav, go); else go();
  };

  backRef.current = () => {
    if (closeLightbox) closeLightbox();
    else if (sheet) setSheet(null);
    else if (view.page==="list"&&cmpMode) { setCmpMode(false); setCmpIds([]); }
    else if (view.page==="list"&&tab!==TABS[0]) switchTab(TABS[0]);
    else if (view.page==="list") CapApp.exitApp();
    else if (view.page==="form") setView(view.id?{page:"detail",id:view.id}:{page:"list"});
    else setView({page:"list"});
  };

  // свайп по экрану списка — на соседнюю вкладку; от самых краёв не ловим, там системный «назад»
  const touch = useRef(null);
  const onTouchStart = e => {
    const t = e.touches[0], edge = 32;
    touch.current = e.touches.length===1 && t.clientX>edge && t.clientX<window.innerWidth-edge
      && !e.target.closest(".chips,input,textarea,.switch,.numgrid")
      ? {x:t.clientX, y:t.clientY, at:Date.now()} : null;
  };
  const onTouchEnd = e => {
    const s = touch.current; touch.current = null;
    if (!s||cmpMode||sheet) return;
    const t = e.changedTouches[0], dx = t.clientX-s.x, dy = t.clientY-s.y;
    if (Math.abs(dx)<70 || Math.abs(dx)<Math.abs(dy)*1.8 || Date.now()-s.at>700) return;
    const next = TABS[tabIndex(tab)+(dx<0?1:-1)];
    if (next) switchTab(next);
  };

  const filteredItems = useMemo(()=>items.filter(l=>{
    if (search&&!`${l.name||""} ${l.manufacturer||""} ${l.flavor||""}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterFav&&!l.favorite) return false;
    if (filterStatus&&l.status!==filterStatus) return false;
    return true;
  }),[items,search,filterFav,filterStatus]);

  const groups = useMemo(()=>{
    const g={};
    filteredItems.forEach(l=>{const k=l.manufacturer?.trim()||t("noBrand");(g[k]=g[k]||[]).push(l);});
    return Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0],lang));
  },[filteredItems,t,lang]);

  const current = items.find(l=>l.id===view.id);

  const toggleCmp = id => {
    setCmpIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):prev.length<2?[...prev,id]:prev);
  };
  const startCompare = id => setView({page:"list"}, ()=>{ setCmpIds([id]); setCmpMode(true); });

  /* tracker actions */
  const todayCount = log => dayTotals(log)[dayKey(Date.now())]||0;
  const addEntry = (n, kind, pack=curPack) => {
    const e = {id:uid(), t:Date.now(), n, pack:pack.id, ...(kind?{kind}:{})};
    setTrk(p=>({...p, log:[...p.log, e]}));
    return [...trk.log, e];
  };
  // notifId — если ответили из шторки: Android 15+ не даёт такое уведомление удалить,
  // поэтому заменяем его итогом с тем же id (иначе оно так и висит с крутилкой)
  // pack — не текущая, если ответили из шторки про пачку, на которую уже переключились
  const applyLeft = (n, notifId, pack=curPack) => setSheet(null, ()=>{
    if (!pack) return;
    const left = packLeft(pack, trk.log);
    if (n>left) {
      const text = t("tooMany", left);
      setFlash({err:true, text}); notifyResult(notifId, t("mismatch"), text);
      return;
    }
    const d = left-n, log = d>0 ? addEntry(d,"left",pack) : trk.log, c = todayCount(log);
    const title = d>0 ? t("recorded", d) : t("matches");
    const body = t("leftBody", c, n);
    setFlash({text:`${title} · ${body}`});
    notifyResult(notifId, title, body[0].toUpperCase()+body.slice(1));
  });
  const openPack = ({stickId, size, price, finishOld}) => setSheet(null, ()=>{
    const id = uid(), now = Date.now();
    // траты считаются по истории цен в каталоге — новую цену записываем туда, на сегодня
    // и статус «В наличии» — той же записью, а не второй параллельной из эффекта статусов
    const s = sticks.find(x=>x.id===stickId), d = today();
    const newPrice = price>0 && price!==priceAt(s, d);
    if (s && (newPrice || s.status!=="have"))
      upsert({...s, status:"have", ...(newPrice?{prices:[...(s.prices||[]).filter(x=>x.date!==d), {date:d, price}]}:{})}, "sticks");
    setTrk(p=>{
      const old = p.packs.find(x=>x.id===p.cur), l = packLeft(old, p.log);
      const log = finishOld&&l>0 ? [...p.log, {id:uid(), t:now, n:l, pack:old.id, kind:"finish", by:id}] : p.log;
      // prev и prevStatus — чтобы отмена вернула всё как было
      return {...p, log, packs:[...p.packs, {id, stickId, size, price, opened:now, prev:p.cur, prevStatus:s?.status||""}], cur:id};
    });
  });
  // отмена: статус стиков — какой был до открытия, если других открытых пачек этих стиков нет;
  // текущей — та, что была до неё (её «докурил» тоже отменился), иначе последняя открытая
  const cancelPack = id => {
    const pack = trk.packs.find(x=>x.id===id), s = pack && sticks.find(x=>x.id===pack.stickId);
    if (s && pack.prevStatus!=null && s.status!==pack.prevStatus && !open.some(p=>p.id!==id&&p.stickId===s.id))
      upsert({...s, status:pack.prevStatus}, "sticks");
    setTrk(p=>{
      const packs = p.packs.filter(x=>x.id!==id), log = p.log.filter(e=>e.by!==id), left = openPacks(packs, log);
      const back = left.find(x=>x.id===pack?.prev)?.id ?? left.at(-1)?.id ?? null;
      return {...p, packs, log, cur: p.cur!==id ? p.cur : back};
    });
  };
  const switchPack = id => setTrk(p=>({...p, cur:id}));
  const finishPack = () => {
    if (curLeft>0 && confirm(t("finishAsk", curLeft))) addEntry(curLeft, "finish");
  };
  const setTrkCfg = async patch => {
    if (patch.remind&&NATIVE) {
      try {
        const { display } = await LocalNotifications.requestPermissions();
        if (display!=="granted") {
          patch = {...patch, remind:false};
          setFlash({err:true, text:t("notifDenied")});
        }
      } catch {}
    }
    setTrk(p=>({...p, cfg:{...p.cfg, ...patch}}));
  };
  const testNotif = async () => {
    if (!NATIVE) return setFlash({err:true, text:t("notifWebOnly")});
    try {
      await actionsReady;
      await LocalNotifications.schedule({ notifications: [{ id:TEST_ID, ...reminderPayload(remPack, remLeft, remName, t) }] });
      setFlash({text:t("notifSent")});
    } catch (e) { setFlash({err:true, text:t("failed")+(e?.message||String(e))}); }
  };

  // ответ из уведомления: применяем, когда данные уже загружены
  useEffect(()=>{
    if (loading||!pendingAct) return;
    setPendingAct(null);
    const {input, id, kind, pack} = pendingAct;
    // форму с несохранёнными правками не бросаем — итог всё равно придёт в шторку
    const inForm = view.page==="form";
    if (!inForm) switchTab("tracker");
    if (kind==="summary") return;
    // напоминание висело в шторке, а пачку с тех пор докурили или отменили
    const target = pack ? trk.packs.find(p=>p.id===pack) : curPack, stale = !(packLeft(target, trk.log)>0);
    const n = input!=null && /^\d+$/.test(input.trim()) ? Number(input.trim()) : NaN;
    if (!stale && !isNaN(n)) return applyLeft(n, id, target);
    if (input!=null) notifyResult(id, ...(stale ? [t("staleAnswer"), t("staleAnswerBody")] : [t("badAnswer"), t("badAnswerBody", input)]));
    if (inForm) return;
    // остаток вводят для той пачки, про которую спрашивали, — на неё и переключаем
    if (!stale) { if (target.id!==trk.cur) switchPack(target.id); setSheet("left"); }
    else if (curLeft>0) setSheet("left");
  // срабатывает только на новое событие; остальное берём из текущего рендера
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  },[loading,pendingAct]);

  const smokedOf = id => {
    const ps = trk.packs.filter(p=>p.stickId===id), ids = new Set(ps.map(p=>p.id));
    return { packs:ps.length, n:trk.log.reduce((s,e)=>ids.has(e.pack)?s+e.n:s, 0) };
  };

  return (
    <Ctx value={ctx}>
    <div className="vt" onTouchStart={view.page==="list"?onTouchStart:undefined} onTouchEnd={view.page==="list"?onTouchEnd:undefined}>
      <style>{css}</style>

      {view.page==="list"&&(
        <>
          <div className="hdr">
            <h1 className="disp">{cmpMode?t("cmpPick"):cfg?.title||t("title.tracker")}</h1>
            <div className="hdr-right">
              {cfg&&cmpMode
                ?<button className="icon-btn" onClick={()=>{setCmpMode(false);setCmpIds([])}}>{t("cancel")}</button>
                :<>
                  {cfg&&<button className="icon-btn" onClick={()=>{setCmpMode(true);setCmpIds([])}}>⇄</button>}
                  <button className="icon-btn" onClick={()=>setView({page:"settings"})}>⚙</button>
                </>
              }
            </div>
          </div>
          <div className="tabs">
            {TABS.map(k=>(
              <button key={k} className={"tab"+(tab===k?" on":"")} onClick={()=>switchTab(k)}>{TYPES[k]?typeCfg(k,lang).tabLabel:t("tab.tracker")}</button>
            ))}
          </div>
          <div key={tab} className={"swipe "+slide}>
          {!cfg?(loading?<div className="empty">{t("loading")}</div>:(
            <TrackerPage trk={trk} cur={curPack} open={open} sticks={sticks} flash={flash}
              onAdd={()=>addEntry(1)} onSwitch={switchPack} onFinish={finishPack} onDelEntry={id=>setTrk(p=>({...p,log:p.log.filter(e=>e.id!==id)}))}
              onCancelPack={cancelPack} onSheet={setSheet} onCfg={setTrkCfg}/>
          )):<>
          {items.length>0&&(
            <>
              <div className="srow">
                <input placeholder={t("search")} value={search} onChange={e=>setSearch(e.target.value)}/>
                {search&&<button className="btn ghost" style={{flex:"none",padding:"9px 12px"}} onClick={()=>setSearch("")}>✕</button>}
              </div>
              <div className="chips">
                <button className={"chip"+(filterFav?" on":"")} onClick={()=>setFilterFav(!filterFav)}>{t("fav")}</button>
                {Object.entries(STATUSES).map(([k,{color}])=>(
                  <button key={k} className={"chip"+(filterStatus===k?" on":"")} onClick={()=>setFilterStatus(filterStatus===k?"":k)}>
                    <span className="badge" style={{background:color}}/>{t("st."+k)}
                  </button>
                ))}
              </div>
            </>
          )}
          {loading?<div className="empty">{t("loading")}</div>
          :filteredItems.length===0&&items.length===0?<div className="empty"><b>{t("empty")}</b>{cfg.emptyHint}</div>
          :filteredItems.length===0?<div className="empty">{t("notFound")}</div>
          :groups.map(([man,its])=>(
            <div className="grp" key={man}>
              <h2>{man}<span>{its.length}</span></h2>
              {its.map(l=>{
                const lp=lastPrice(l), ppm=pricePerUnit(l), st=l.status&&STATUSES[l.status], sel=cmpIds.includes(l.id);
                return (
                  <div className={"card"+(sel?" sel":"")} key={l.id}
                    onClick={()=>cmpMode?toggleCmp(l.id):setView({page:"detail",id:l.id})}>
                    {cmpMode&&<div className={"chk"+(sel?" on":"")}>{sel?"✓":""}</div>}
                    {l.photo?<img src={photoSrc(l.photo)} className="thumb" alt="" onError={e=>e.target.style.display="none"}/>:<Tile l={l}/>}
                    <div style={{minWidth:0,flex:1}}>
                      <div className="nm">{l.favorite&&<span style={{color:"var(--star)",marginRight:4}}>★</span>}{l.name}</div>
                      <div className="fl">{st&&<span className="badge" style={{background:st.color}}/>}{l.flavor||l.nicotine}</div>
                    </div>
                    {lp&&!cmpMode&&<div className="pr">{lp.price} {cur}{ppm&&<small>{ppm} {cur}/{cfg.unit}</small>}</div>}
                    {!cmpMode&&(
                      <button className="star-btn" style={{color:l.favorite?"var(--star)":"var(--line2)"}}
                        onClick={e=>{e.stopPropagation();upsert({...l,favorite:!l.favorite})}}>
                        {l.favorite?"★":"☆"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          </>}
          </div>
          {cfg&&(cmpMode
            ?<button className="fab" disabled={cmpIds.length<2}
                onClick={()=>{if(cmpIds.length===2)setView({page:"compare",compareIds:cmpIds},()=>{setCmpMode(false);setCmpIds([])})}}>
                {cmpIds.length===2?t("cmpGo"):t("cmpSel", cmpIds.length)}
              </button>
            :<button className="fab" onClick={()=>setView({page:"form"})}>{cfg.addBtn}</button>
          )}
        </>
      )}

      {sheet==="left"&&curPack&&(
        <LeftSheet pack={curPack} left={curLeft} name={curName} onPick={applyLeft} onClose={()=>setSheet(null)}/>
      )}
      {sheet==="pack"&&(
        <PackSheet sticks={sticks} cur={curPack} curLeft={curLeft} open={open} onOpen={openPack} onSwitch={id=>setSheet(null, ()=>switchPack(id))} onClose={()=>setSheet(null)}
          onAddSticks={()=>{setSheet(null);switchTab("sticks");setView({page:"form"})}}/>
      )}

      {view.page==="settings"&&(
        <SettingsPage app={app} onApp={patch=>setApp(p=>({...p, ...patch}))} trkCfg={trk.cfg} onTrkCfg={setTrkCfg}
          onTest={testNotif} flash={flash} onFlash={setFlash} onBack={()=>setView({page:"list"})}/>
      )}
      {view.page==="compare"&&<ComparePage ids={view.compareIds} type={tab} items={items} onBack={()=>setView({page:"list"})}/>}
      {view.page==="form"&&(
        <Form initial={view.id?current:null} type={tab}
          onSave={l=>setView({page:"detail",id:l.id},()=>upsert(l))}
          onCancel={()=>setView(view.id?{page:"detail",id:view.id}:{page:"list"})}/>
      )}
      {view.page==="detail"&&current&&(
        <Detail l={current} type={tab} smoked={tab==="sticks"?smokedOf(current.id):null} onUpdate={upsert}
          onEdit={()=>setView({page:"form",id:current.id})}
          onDelete={del} onBack={()=>setView({page:"list"})}
          onStartCompare={startCompare}/>
      )}
    </div>
    </Ctx>
  );
}
