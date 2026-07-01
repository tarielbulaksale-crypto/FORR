// index.js
// Синхронизация МойСклад -> Google Sheets
// Запуск: node index.js   (разовый прогон)
// На Railway настраивается через Cron Schedule в настройках сервиса —
// тогда node-cron внутри файла не обязателен, но оставлен на случай
// постоянно работающего сервиса (worker), а не cron job.

const { google } = require('googleapis');

// ===================== КОНФИГ =====================
const CONFIG = {
  TOKEN: process.env.MS_TOKEN,                  // токен МойСклад
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,    // ID Google-таблицы
  SHEET_OTGRUZKI: 'Выручка_МС',
  SHEET_POZICII: 'Выручка_МС_Детали',
  SHEET_VOZVRAT: 'Возвраты_МС',
  DAYS_BACK: 180
};

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

// ===================== GOOGLE SHEETS AUTH =====================
// На Railway: переменная окружения GOOGLE_SERVICE_ACCOUNT_JSON
// содержит JSON ключ сервисного аккаунта целиком (как строку).
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// ===================== МОЙСКЛАД API =====================
async function apiRequest(url) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.TOKEN,
      'Accept-Encoding': 'gzip'
    }
  });
  if (resp.status === 200) return resp.json();
  const text = await resp.text();
  console.error(`API ${resp.status}: ${text.substring(0, 300)}`);
  return null;
}

function extractId(href) {
  if (!href) return '';
  return href.split('?')[0].split('/').pop();
}

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function buildDateFilter() {
  const d = new Date();
  d.setDate(d.getDate() - CONFIG.DAYS_BACK);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day} 00:00:00`;
}

// ===================== СПРАВОЧНИК ТОВАРОВ =====================
async function loadPriceMap() {
  console.log('Загрузка справочника товаров...');
  const priceMap = {};
  let offset = 0;
  const limit = 1000;
  let total = Infinity;

  while (offset < total) {
    const url = `${BASE_URL}/entity/product?limit=${limit}&offset=${offset}`;
    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;

    resp.rows.forEach(product => {
      const id = extractId(product.meta.href);
      let buyPrice = 0;
      if (product.buyPrice && product.buyPrice.value) {
        buyPrice = product.buyPrice.value / 100;
      }
      priceMap[id] = {
        buyPrice,
        name: product.name || '',
        code: product.code || '',
        article: product.article || ''
      };
    });

    offset += limit;
    console.log(`Загружено товаров: ${Math.min(offset, total)} из ${total}`);
  }
  return priceMap;
}

// ===================== ОТГРУЗКИ =====================
async function loadOtgruzki(priceMap) {
  console.log('Загрузка отгрузок...');
  const dateFrom = buildDateFilter();
  const rowsO = [];
  const rowsP = [];
  let offset = 0;
  const limit = 1000;
  let total = Infinity;

  while (offset < total) {
    const filter = encodeURIComponent('moment>=' + dateFrom);
    const url = `${BASE_URL}/entity/demand?limit=${limit}&offset=${offset}` +
      `&filter=${filter}` +
      `&expand=agent,store,salesChannel,positions,positions.assortment` +
      `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Отгрузки: ${Math.min(offset + limit, total)} из ${total}`);

    resp.rows.forEach(doc => {
      const date = formatDate(doc.moment);
      const number = doc.name || '';
      const store = doc.store ? doc.store.name : '';
      const channel = doc.salesChannel ? doc.salesChannel.name : (store || 'Не указан');
      const agent = doc.agent ? doc.agent.name : '';
      const sum = (doc.sum || 0) / 100;
      let cost = 0;
      const docId = extractId(doc.meta.href);

      if (doc.positions && doc.positions.rows) {
        doc.positions.rows.forEach(pos => {
          const productId = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty = pos.quantity || 0;
          const price = (pos.price || 0) / 100;
          const cpUnit = (pos.costPrice && pos.costPrice > 0)
            ? pos.costPrice / 100
            : (productInfo.buyPrice || 0);
          const sumSale = qty * price;
          const sumCost = qty * cpUnit;
          const profit = sumSale - sumCost;
          cost += sumCost;

          const p = pos.assortment || {};
          rowsP.push([
            date, number, channel,
            productInfo.code || p.code || '',
            productInfo.name || p.name || '',
            productInfo.article || p.article || '',
            qty, price, sumSale, cpUnit, sumCost, profit
          ]);
        });
      }

      const grossProfit = sum - cost;
      const margin = sum > 0 ? Math.round((grossProfit / sum) * 100) : 0;

      rowsO.push([
        date, number, store, channel, agent,
        sum, cost, grossProfit, margin,
        doc.applicable ? 'Проведён' : 'Черновик',
        doc.description || '', docId
      ]);
    });

    offset += limit;
  }

  return { rowsO, rowsP };
}

// ===================== ВОЗВРАТЫ =====================
async function loadVozvraty(priceMap) {
  console.log('Загрузка возвратов...');
  const dateFrom = buildDateFilter();
  const rows = [];
  let offset = 0;
  const limit = 1000;
  let total = Infinity;

  while (offset < total) {
    const filter = encodeURIComponent('moment>=' + dateFrom);
    const url = `${BASE_URL}/entity/salesreturn?limit=${limit}&offset=${offset}` +
      `&filter=${filter}` +
      `&expand=agent,store,salesChannel,positions,positions.assortment` +
      `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;

    resp.rows.forEach(doc => {
      let cost = 0;
      if (doc.positions && doc.positions.rows) {
        doc.positions.rows.forEach(pos => {
          const productId = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty = pos.quantity || 0;
          const cpUnit = (pos.costPrice && pos.costPrice > 0)
            ? pos.costPrice / 100
            : (productInfo.buyPrice || 0);
          cost += qty * cpUnit;
        });
      }

      const channel = doc.salesChannel ? doc.salesChannel.name
        : (doc.store ? doc.store.name : 'Не указан');

      rows.push([
        formatDate(doc.moment),
        doc.name || '',
        doc.agent ? doc.agent.name : '',
        doc.store ? doc.store.name : '',
        channel,
        (doc.sum || 0) / 100,
        cost,
        doc.description || '',
        extractId(doc.meta.href)
      ]);
    });

    offset += limit;
  }

  return rows;
}

// ===================== ЗАПИСЬ В GOOGLE SHEETS =====================
async function writeSheet(sheets, sheetName, headers, rows) {
  // Убедиться что лист существует
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
    });
  }

  // Очистить и записать
  await sheets.spreadsheets.values.clear({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: sheetName
  });

  const values = [headers, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  console.log(`Записано в "${sheetName}": ${rows.length} строк`);
}

// ===================== ГЛАВНАЯ ФУНКЦИЯ =====================
async function syncAll() {
  console.log('=== Запуск синхронизации МойСклад ===');
  const startTime = Date.now();

  try {
    const sheets = getSheetsClient();
    const priceMap = await loadPriceMap();
    console.log(`Товаров в справочнике: ${Object.keys(priceMap).length}`);

    const { rowsO, rowsP } = await loadOtgruzki(priceMap);
    const rowsV = await loadVozvraty(priceMap);

    await writeSheet(sheets, CONFIG.SHEET_OTGRUZKI, [
      'Дата', 'Номер', 'Склад', 'Канал продаж', 'Контрагент',
      'Сумма (сом)', 'Себестоимость (сом)', 'Валовая прибыль',
      'Маржа %', 'Статус', 'Комментарий', 'ID документа'
    ], rowsO);

    await writeSheet(sheets, CONFIG.SHEET_POZICII, [
      'Дата', 'Номер отгрузки', 'Канал продаж', 'Код товара', 'Наименование', 'Артикул',
      'Кол-во', 'Цена продажи', 'Сумма продажи',
      'Себест. ед.', 'Сумма себест.', 'Прибыль по позиции'
    ], rowsP);

    await writeSheet(sheets, CONFIG.SHEET_VOZVRAT, [
      'Дата', 'Номер', 'Контрагент', 'Склад', 'Канал продаж',
      'Сумма возврата (сом)', 'Себестоимость (сом)',
      'Комментарий', 'ID документа'
    ], rowsV);

    const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`=== Готово за ${seconds} сек ===`);
  } catch (e) {
    console.error('ОШИБКА:', e.message);
    console.error(e.stack);
  }
}

// ===================== ЗАПУСК =====================
// Если переменная окружения RUN_ON_CRON=true — держим процесс живым с расписанием.
// Иначе — разовый запуск и выход (так удобно тестировать и так работает Railway Cron Job).
if (process.env.RUN_ON_CRON === 'true') {
  const cron = require('node-cron');
  console.log('Сервис запущен. Синхронизация каждый день в 03:00 (по времени контейнера).');
  cron.schedule('0 3 * * *', () => {
    syncAll();
  });
  syncAll(); // первый прогон сразу при старте
} else {
  syncAll().then(() => process.exit(0));
}
