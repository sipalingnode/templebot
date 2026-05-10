import {
  initialize,
  getOrderBook,
  getActiveOrders,
  createOrderRequest
} from '@temple-digital-group/temple-canton-js';

import { config } from './config.js';
import { log } from './logger.js';

let ready = false;

export async function initSdk() {
  if (ready) return;

  await initialize({
    API_KEY: config.apiKey,
    NETWORK: config.network
  });

  ready = true;
  log('Temple v2 beta 4 SDK initialized');
}

export async function fetchOrderBook(symbol) {
  await initSdk();
  return await getOrderBook(symbol, { levels: 1 });
}

export async function fetchActiveOrders(symbol) {
  await initSdk();
  return await getActiveOrders({ symbol, limit: 100 });
}

export async function submitOrder(args) {
  await initSdk();
  return await createOrderRequest(args);
}