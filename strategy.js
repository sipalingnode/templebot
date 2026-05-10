import {
  initialize,
  createOrderRequest
} from '@temple-digital-group/temple-canton-js';

import { error } from './logger.js';

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace(/CC/gi, 'Amulet');
}

function displaySymbol(symbol) {
  return String(symbol || '').replace(/Amulet/gi, 'CC');
}

function formatSimple(
  accName,
  orderType,
  side,
  symbol,
  status,
  price = null,
  orderSize = null
) {
  const typeText =
    String(orderType || 'market')
      .toUpperCase();

  const sideText =
    String(side || 'buy')
      .toUpperCase();

  let convertText = '';

  if (
    Number.isFinite(Number(orderSize)) &&
    Number(orderSize) > 0
  ) {
    if (side === 'buy') {
      const spent =
        Number(orderSize) *
        Number(price || 0);

      convertText =
        `[${accName}] ${spent.toFixed(2)} USDCX => ${Number(orderSize).toFixed(2)} CC`;
    } else {
      const received =
        Number(orderSize) *
        Number(price || 0);

      convertText =
        `[${accName}] ${Number(orderSize).toFixed(2)} CC => ${received.toFixed(2)} USDCX`;
    }
  }

  return [
    `[${accName}] ${typeText} ${sideText}`,
    convertText,
    `[${accName}] PRICE ${Number(price || 0).toFixed(4)}`,
    `[${accName}] ${status}`
  ].join('\n');
}

export async function getCcPrice(apiKey) {
  const res = await fetch(
    'https://api.templedigitalgroup.com/api/v1/market/ticker?symbol=CC/USDCx',
    {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey
      }
    }
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();

  const price = Number(
    json?.ticker?.last_price
  );

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('CC price not found');
  }

  return price;
}

export async function getActiveOrders(apiKey) {
  const res = await fetch(
    'https://api.templedigitalgroup.com/api/trading/orders/active',
    {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey
      }
    }
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

export async function waitAllOrdersSettled(
  apiKey,
  runningCheck
) {
  while (runningCheck()) {

    const data =
      await getActiveOrders(apiKey);

    const orders =
      Array.isArray(data?.orders)
        ? data.orders
        : [];

    if (orders.length === 0) {

      console.log(
        '[SETTLEMENT] All orders filled'
      );

      return true;
    }

    console.log(
      `[SETTLEMENT] Waiting ${orders.length} active orders...`
    );

    await new Promise((r) =>
      setTimeout(r, 5000)
    );
  }

  throw new Error('Stopped by user');
}

async function getUserTrades(
  apiKey,
  type = 'buys',
  symbol = 'CC/USDCx',
  limit = 1000
) {

  const url =
    `https://api.templedigitalgroup.com/api/trading/trades/${type}` +
    `?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

export async function waitTradesSettled(
  apiKey,
  symbol = 'CC/USDCx',
  runningCheck,
  cycleStartedAt = null
) {

  let stableCount = 0;

  while (runningCheck()) {

    const [sales, buys] =
      await Promise.all([
        getUserTrades(
          apiKey,
          'sales',
          symbol
        ),
        getUserTrades(
          apiKey,
          'buys',
          symbol
        )
      ]);

    const allMyTrades = [
      ...(Array.isArray(sales?.trades)
        ? sales.trades
        : []),

      ...(Array.isArray(buys?.trades)
        ? buys.trades
        : [])
    ];

    let filteredTrades =
      allMyTrades;

    if (cycleStartedAt) {

      filteredTrades =
        allMyTrades.filter((t) => {

          const rawTime =
            t?.created_at ||
            t?.createdAt ||
            t?.timestamp;

          if (!rawTime) {
            return false;
          }

          const tradeTime =
            new Date(rawTime).getTime();

          return (
            tradeTime >= cycleStartedAt
          );
        });
    }

    const active =
      filteredTrades.filter((t) => {

        const status =
          String(
            t?.status || ''
          ).toLowerCase();

        return status !== 'settled';
      });

    if (active.length === 0) {

      stableCount++;

      console.log(
        `[SETTLEMENT] Verifying Settled ${stableCount}/5`
      );

      if (stableCount >= 5) {

        console.log(
          '[SETTLEMENT] All user trades settled'
        );

        return true;
      }

    } else {

      stableCount = 0;

      console.log(
        `[SETTLEMENT] Waiting ${active.length} pending user trades...`
      );
    }

    await new Promise((r) =>
      setTimeout(r, 5000)
    );
  }

  throw new Error('Stopped by user');
}

export async function runStrategyForAccount(acc) {

  const side =
    String(
      acc?.side || 'buy'
    ).toLowerCase();

  const orderType =
    String(
      acc?.orderType || 'market'
    ).toLowerCase();

  const symbol =
    normalizeSymbol(acc?.market);

  const accName =
    acc?.name || 'acc';

  try {

    if (
      !acc?.apiKey ||
      !acc?.network ||
      !acc?.market
    ) {

      return formatSimple(
        accName,
        orderType,
        side,
        symbol || 'CC/USDCx',
        'FAILED',
        0,
        acc?.orderSize
      );
    }

    await initialize({
      API_KEY: acc.apiKey,
      NETWORK: acc.network
    });

    const marketPrice =
      await getCcPrice(acc.apiKey);

    if (
      !Number.isFinite(marketPrice) ||
      marketPrice <= 0
    ) {

      return formatSimple(
        accName,
        orderType,
        side,
        symbol,
        'FAILED',
        0,
        acc?.orderSize
      );
    }

    const orderSize =
      n(acc.orderSize, 0);

    if (
      !Number.isFinite(orderSize) ||
      orderSize <= 0
    ) {

      return formatSimple(
        accName,
        orderType,
        side,
        symbol,
        'FAILED',
        0,
        orderSize
      );
    }

    const payload = {
      symbol,
      side,
      quantity: Math.floor(orderSize),
      price: Number(
        marketPrice.toFixed(6)
      ),
      order_type: orderType
    };

    console.log(
      `[ORDER] ${side.toUpperCase()} | ` +
      `${Number(orderSize).toFixed(2)} CC | ` +
      `Price: ${Number(payload.price).toFixed(4)}`
    );

    const result =
      await createOrderRequest(payload);

    if (
      result?.error === true ||
      result?.success !== true
    ) {

      console.log(
        '[ORDER ERROR]',
        JSON.stringify(result, null, 2)
      );

      return formatSimple(
        accName,
        orderType,
        side,
        symbol,
        'FAILED',
        marketPrice,
        orderSize
      );
    }

    const executedPrice = Number(
      result?.avg_price ||
      result?.filled_price ||
      result?.execution_price ||
      result?.price ||
      marketPrice
    );

    return formatSimple(
      accName,
      orderType,
      side,
      symbol,
      'SUCCESS',
      executedPrice,
      orderSize
    );

  } catch (e) {

    error(
      `strategy error: ${e?.message || e}`
    );

    return formatSimple(
      accName,
      orderType,
      side,
      symbol || 'CC/USDCx',
      'FAILED',
      0,
      acc?.orderSize
    );
  }
}