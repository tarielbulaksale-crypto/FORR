const { google } = require('googleapis');

const CONFIG = {
  TOKEN:          process.env.MS_TOKEN,
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  DATE_FROM:      '2025-01-01 00:00:00',
  SHEET_ORDERS:        'Заказы_МС',
  SHEET_ORDERS_DETAIL: 'Заказы_МС_Детали',
  SHEET_DEMAND:        'Выручка_МС',
  SHEET_DEMAND_DETAIL: 'Выручка_МС_Детали',
  SHEET_RETURNS:       'Возвраты_МС',
  SHEET_PAY_IN:        'Платежи_Приход',
  SHEET_PAY_OUT:       'Платежи_Расход',
  SHEET_SUPPLY:        'Приёмки_МС',
  SHEET_PURCHASE:      'Закупки_МС',
};

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

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

// ===================== СПРАВОЧНИК ТОВАРОВ =====================
async function loadPriceMap() {
  console.log('Загрузка справочника товаров...');
  const priceMap = {};
  let offset = 0;
  const limit = 1000;
  let total = Infinity;

  while (offset < total) {
    const resp = await apiRequest(`${BASE_URL}/entity/product?limit=${limit}&offset=${offset}`);
    if (!resp) break;
    total = resp.meta.size;
    resp.rows.forEach(p => {
      const id = extractId(p.meta.href);
      priceMap[id] = {
        buyPrice: (p.buyPrice && p.buyPrice.value) ? p.buyPrice.value / 100 : 0,
        name:    p.name    || '',
        code:    p.code    || '',
        article: p.article || ''
      };
    });
    offset += limit;
    console.log(`Товары: ${Math.min(offset, total)} из ${total}`);
  }
  return priceMap;
}

// ===================== ЗАКАЗЫ ПОКУПАТЕЛЕЙ =====================
async function loadOrders(priceMap) {
  console.log('Загрузка заказов покупателей...');
  const rowsO = [], rowsD = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/customerorder`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,store,salesChannel,positions,positions.assortment`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Заказы: ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      const date    = formatDate(doc.moment);
      const number  = doc.name || '';
      const agent   = doc.agent ? doc.agent.name : '';
      const store   = doc.store ? doc.store.name : '';
      const channel = doc.salesChannel ? doc.salesChannel.name : (store || 'Не указан');
      const sum     = (doc.sum || 0) / 100;
      const paid    = (doc.payedSum || 0) / 100;
      const shipped = (doc.shippedSum || 0) / 100;
      const status  = doc.applicable ? 'Проведён' : 'Черновик';
      const docId   = extractId(doc.meta.href);

      let manager = '';
      if (doc.attributes && doc.attributes.length > 0) {
        const attrs = doc.attributes.map(a => `${a.name}: ${a.value && a.value.name ? a.value.name : (a.value || '')}`);
        manager = attrs.join(' | ');
      }

      let cost = 0;
      if (doc.positions && doc.positions.rows) {
        for (const pos of doc.positions.rows) {
          const productId   = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty    = pos.quantity || 0;
          const price  = (pos.price || 0) / 100;
          const disc   = pos.discount || 0;
          const priceWithDisc = price * (1 - disc / 100);
          const cpUnit = (pos.costPrice && pos.costPrice > 0)
            ? pos.costPrice / 100
            : (productInfo.buyPrice || 0);
          const sumSale = qty * priceWithDisc;
          const sumCost = qty * cpUnit;
          cost += sumCost;

          const p = pos.assortment || {};
          rowsD.push([
            date, docId, number, agent, channel,
            productInfo.code    || p.code    || '',
            productInfo.name    || p.name    || '',
            productInfo.article || p.article || '',
            qty, price, disc, priceWithDisc, sumSale,
            cpUnit, sumCost, sumSale - sumCost
          ]);
        }
      }

      const grossProfit = sum - cost;
      const margin = sum > 0 ? Math.round((grossProfit / sum) * 100) : 0;

      rowsO.push([
        date, number, agent, store, channel,
        sum, paid, shipped,
        cost, grossProfit, margin,
        doc.invoicesOut ? doc.invoicesOut.length : 0,
        status, manager,
        doc.description || '', docId
      ]);
    }
    offset += limit;
  }
  return { rowsO, rowsD };
}

// ===================== ОТГРУЗКИ =====================
async function loadDemands(priceMap) {
  console.log('Загрузка отгрузок...');
  const rowsO = [], rowsD = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/demand`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,store,salesChannel,positions,positions.assortment`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Отгрузки: ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      const date    = formatDate(doc.moment);
      const number  = doc.name || '';
      const store   = doc.store ? doc.store.name : '';
      const channel = doc.salesChannel ? doc.salesChannel.name : (store || 'Не указан');
      const agent   = doc.agent ? doc.agent.name : '';
      const sum     = (doc.sum || 0) / 100;
      const docId   = extractId(doc.meta.href);
      let cost = 0;

      if (doc.positions && doc.positions.rows) {
        for (const pos of doc.positions.rows) {
          const productId   = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty    = pos.quantity || 0;
          const price  = (pos.price || 0) / 100;
          const disc   = pos.discount || 0;
          const priceWithDisc = price * (1 - disc / 100);
          const cpUnit = (pos.costPrice && pos.costPrice > 0)
            ? pos.costPrice / 100
            : (productInfo.buyPrice || 0);
          const sumSale = qty * priceWithDisc;
          const sumCost = qty * cpUnit;
          cost += sumCost;

          const p = pos.assortment || {};
          rowsD.push([
            date, docId, number, agent, channel,
            productInfo.code    || p.code    || '',
            productInfo.name    || p.name    || '',
            productInfo.article || p.article || '',
            qty, price, disc, priceWithDisc, sumSale,
            cpUnit, sumCost, sumSale - sumCost
          ]);
        }
      }

      const grossProfit = sum - cost;
      const margin = sum > 0 ? Math.round((grossProfit / sum) * 100) : 0;

      rowsO.push([
        date, number, store, channel, agent,
        sum, cost, grossProfit, margin,
        doc.applicable ? 'Проведён' : 'Черновик',
        doc.description || '', docId
      ]);
    }
    offset += limit;
  }
  return { rowsO, rowsD };
}

// ===================== ВОЗВРАТЫ =====================
async function loadReturns(priceMap) {
  console.log('Загрузка возвратов...');
  const rows = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/salesreturn`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,store,salesChannel,positions,positions.assortment`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;

    for (const doc of resp.rows) {
      let cost = 0;
      if (doc.positions && doc.positions.rows) {
        for (const pos of doc.positions.rows) {
          const productId   = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty    = pos.quantity || 0;
          const cpUnit = (pos.costPrice && pos.costPrice > 0)
            ? pos.costPrice / 100
            : (productInfo.buyPrice || 0);
          cost += qty * cpUnit;
        }
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
    }
    offset += limit;
  }
  return rows;
}

// ===================== ВХОДЯЩИЕ ПЛАТЕЖИ (ОДС приход) =====================
async function loadPaymentsIn() {
  console.log('Загрузка входящих платежей...');
  const rows = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/paymentin`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,expenseItem,contract`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Платежи (приход): ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      rows.push([
        formatDate(doc.moment),
        doc.name || '',
        doc.agent ? doc.agent.name : '',
        (doc.sum || 0) / 100,
        doc.paymentPurpose || '',
        doc.expenseItem ? doc.expenseItem.name : '',
        doc.applicable ? 'Проведён' : 'Черновик',
        doc.description || '',
        extractId(doc.meta.href)
      ]);
    }
    offset += limit;
  }
  return rows;
}

// ===================== ИСХОДЯЩИЕ ПЛАТЕЖИ (ОДС расход) =====================
async function loadPaymentsOut() {
  console.log('Загрузка исходящих платежей...');
  const rows = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/paymentout`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,expenseItem,contract`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Платежи (расход): ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      rows.push([
        formatDate(doc.moment),
        doc.name || '',
        doc.agent ? doc.agent.name : '',
        (doc.sum || 0) / 100,
        doc.paymentPurpose || '',
        doc.expenseItem ? doc.expenseItem.name : '',
        doc.applicable ? 'Проведён' : 'Черновик',
        doc.description || '',
        extractId(doc.meta.href)
      ]);
    }
    offset += limit;
  }
  return rows;
}

// ===================== ПРИЁМКИ ОТ ПОСТАВЩИКОВ =====================
async function loadSupplies(priceMap) {
  console.log('Загрузка приёмок...');
  const rows = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/supply`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,store,positions,positions.assortment`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Приёмки: ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      const docId  = extractId(doc.meta.href);
      const date   = formatDate(doc.moment);
      const agent  = doc.agent ? doc.agent.name : '';
      const store  = doc.store ? doc.store.name : '';

      if (doc.positions && doc.positions.rows) {
        for (const pos of doc.positions.rows) {
          const productId   = pos.assortment ? extractId(pos.assortment.meta.href) : '';
          const productInfo = priceMap[productId] || {};
          const qty    = pos.quantity || 0;
          const price  = (pos.price || 0) / 100;

          const p = pos.assortment || {};
          rows.push([
            date, docId, doc.name || '', agent, store,
            productInfo.code    || p.code    || '',
            productInfo.name    || p.name    || '',
            productInfo.article || p.article || '',
            qty, price, qty * price
          ]);
        }
      }
    }
    offset += limit;
  }
  return rows;
}

// ===================== ЗАКАЗЫ ПОСТАВЩИКАМ =====================
async function loadPurchaseOrders() {
  console.log('Загрузка заказов поставщикам...');
  const rows = [];
  let offset = 0;
  const limit = 100;
  let total = Infinity;
  const filter = encodeURIComponent('moment>=' + CONFIG.DATE_FROM);

  while (offset < total) {
    const url = `${BASE_URL}/entity/purchaseorder`
      + `?limit=${limit}&offset=${offset}`
      + `&filter=${filter}`
      + `&expand=agent,store`
      + `&order=moment%2Casc`;

    const resp = await apiRequest(url);
    if (!resp) break;
    total = resp.meta.size;
    console.log(`Заказы поставщикам: ${Math.min(offset + limit, total)} из ${total}`);

    for (const doc of resp.rows) {
      rows.push([
        formatDate(doc.moment),
        doc.name || '',
        doc.agent ? doc.agent.name : '',
        doc.store ? doc.store.name : '',
        (doc.sum || 0) / 100,
        (doc.payedSum || 0) / 100,
        (doc.shippedSum || 0) / 100,
        doc.applicable ? 'Проведён' : 'Черновик',
        doc.description || '',
        extractId(doc.meta.href)
      ]);
    }
    offset += limit;
  }
  return rows;
}

// ===================== ЗАПИСЬ В GOOGLE SHEETS =====================
async function writeSheet(sheets, name, headers, rows) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: name
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${name}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers, ...rows] }
  });

  console.log(`✅ "${name}": ${rows.length} строк`);
}

// ===================== ГЛАВНАЯ ФУНКЦИЯ =====================
async function syncAll() {
  console.log('=== Запуск синхронизации МойСклад ===');
  const start = Date.now();

  try {
    const sheets = getSheetsClient();
    const priceMap = await loadPriceMap();
    console.log(`Товаров: ${Object.keys(priceMap).length}`);

    // Заказы покупателей
    const { rowsO: ordersO, rowsD: ordersD } = await loadOrders(priceMap);
    await writeSheet(sheets, CONFIG.SHEET_ORDERS, [
      'Дата', 'Номер', 'Контрагент', 'Склад', 'Канал продаж',
      'Сумма', 'Оплачено', 'Отгружено',
      'Себестоимость', 'Валовая прибыль', 'Маржа %',
      'Кол-во счетов', 'Статус', 'Атрибуты (менеджер и др.)',
      'Комментарий', 'ID документа'
    ], ordersO);

    await writeSheet(sheets, CONFIG.SHEET_ORDERS_DETAIL, [
      'Дата', 'ID документа', 'Номер заказа', 'Контрагент', 'Канал продаж',
      'Код товара', 'Наименование', 'Артикул',
      'Кол-во', 'Цена', 'Скидка %', 'Цена со скидкой', 'Сумма продажи',
      'Себест. ед.', 'Сумма себест.', 'Прибыль по позиции'
    ], ordersD);

    // Отгрузки
    const { rowsO: demandO, rowsD: demandD } = await loadDemands(priceMap);
    await writeSheet(sheets, CONFIG.SHEET_DEMAND, [
      'Дата', 'Номер', 'Склад', 'Канал продаж', 'Контрагент',
      'Сумма (сом)', 'Себестоимость (сом)', 'Валовая прибыль',
      'Маржа %', 'Статус', 'Комментарий', 'ID документа'
    ], demandO);

    await writeSheet(sheets, CONFIG.SHEET_DEMAND_DETAIL, [
      'Дата', 'ID документа', 'Номер отгрузки', 'Контрагент', 'Канал продаж',
      'Код товара', 'Наименование', 'Артикул',
      'Кол-во', 'Цена', 'Скидка %', 'Цена со скидкой', 'Сумма продажи',
      'Себест. ед.', 'Сумма себест.', 'Прибыль по позиции'
    ], demandD);

    // Возвраты
    const returns = await loadReturns(priceMap);
    await writeSheet(sheets, CONFIG.SHEET_RETURNS, [
      'Дата', 'Номер', 'Контрагент', 'Склад', 'Канал продаж',
      'Сумма возврата (сом)', 'Себестоимость (сом)',
      'Комментарий', 'ID документа'
    ], returns);

    // Входящие платежи (ОДС приход)
    const paymentsIn = await loadPaymentsIn();
    await writeSheet(sheets, CONFIG.SHEET_PAY_IN, [
      'Дата', 'Номер', 'Контрагент',
      'Сумма', 'Назначение платежа', 'Статья',
      'Статус', 'Комментарий', 'ID документа'
    ], paymentsIn);

    // Исходящие платежи (ОДС расход)
    const paymentsOut = await loadPaymentsOut();
    await writeSheet(sheets, CONFIG.SHEET_PAY_OUT, [
      'Дата', 'Номер', 'Контрагент',
      'Сумма', 'Назначение платежа', 'Статья расхода',
      'Статус', 'Комментарий', 'ID документа'
    ], paymentsOut);

    // Приёмки от поставщиков
    const supplies = await loadSupplies(priceMap);
    await writeSheet(sheets, CONFIG.SHEET_SUPPLY, [
      'Дата', 'ID документа', 'Номер приёмки', 'Поставщик', 'Склад',
      'Код товара', 'Наименование', 'Артикул',
      'Кол-во', 'Цена закупки', 'Сумма закупки'
    ], supplies);

    // Заказы поставщикам
    const purchases = await loadPurchaseOrders();
    await writeSheet(sheets, CONFIG.SHEET_PURCHASE, [
      'Дата', 'Номер', 'Поставщик', 'Склад',
      'Сумма', 'Оплачено', 'Принято',
      'Статус', 'Комментарий', 'ID документа'
    ], purchases);

    console.log(`=== Готово за ${((Date.now() - start) / 1000).toFixed(1)} сек ===`);
  } catch (e) {
    console.error('ОШИБКА:', e.message, e.stack);
  }
}

// ===================== ЗАПУСК =====================
if (process.env.RUN_ON_CRON === 'true') {
  const cron = require('node-cron');
  console.log('Сервис запущен. Синхронизация каждый день в 03:00 по Бишкеку.');
  cron.schedule('0 21 * * *', () => syncAll());
  syncAll();
} else {
  syncAll().then(() => process.exit(0));
}