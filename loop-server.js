import { loop, PaymentRequiredError } from './loop-sdk/dist/server/index.js';
import fs from 'fs';
import path from 'path';

function accountsPath() {
  return path.resolve(process.cwd(), 'accounts.json');
}

function readAccountsFile() {
  return JSON.parse(fs.readFileSync(accountsPath(), 'utf8'));
}

function getAccounts() {
  const data = readAccountsFile();
  return Array.isArray(data.accounts) ? data.accounts : [];
}

export function getAccountByIndex(index) {
  const acc = getAccounts()[index];
  if (!acc) throw new Error(`Akun ${index + 1} tidak ditemukan`);
  return acc;
}

export async function initLoopServerForAccount(index, extra = {}) {
  const acc = getAccountByIndex(index);

  const privateKey = acc.loopPrivateKey || '';
  const partyId = acc.partyId || '';
  const network = extra.network || acc.network || 'mainnet';

  if (!privateKey) throw new Error(`loopPrivateKey kosong di akun ${index + 1}`);
  if (!partyId) throw new Error(`partyId kosong di akun ${index + 1}`);

  loop.init({
    privateKey,
    partyId,
    network,
    walletUrl: extra.walletUrl,
    apiUrl: extra.apiUrl,
  });

  await loop.authenticate();
  return loop;
}

export async function getServerProvider(index, extra = {}) {
  await initLoopServerForAccount(index, extra);
  const provider = loop.getProvider();
  if (!provider) {
    throw new Error('Provider tidak tersedia (loop.getProvider null)');
  }
  return provider;
}

export async function getLoopHoldings(index, extra = {}) {
  const provider = await getServerProvider(index, extra);

  if (typeof provider.getHolding !== 'function') {
    throw new Error('provider.getHolding tidak tersedia');
  }

  return await provider.getHolding();
}

export async function getLoopContracts(index, params = {}, extra = {}) {
  const provider = await getServerProvider(index, extra);

  if (typeof provider.getActiveContracts !== 'function') {
    throw new Error('provider.getActiveContracts tidak tersedia');
  }

  return await provider.getActiveContracts(params);
}

export async function prepareLoopTransfer(index, recipient, amount, instrument = {}, opts = {}, extra = {}) {
  const provider = await getServerProvider(index, extra);

  if (typeof provider.transfer !== 'function') {
    throw new Error('provider.transfer tidak tersedia');
  }

  return await provider.transfer(recipient, amount, instrument, {
    requestedAt: opts.requestedAt || new Date(),
    executeBefore: opts.executeBefore || new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...opts,
  });
}

export async function checkAndPayDueGas(index, extra = {}, trackingId = undefined) {
  await initLoopServerForAccount(index, extra);
  const dueGas = await loop.checkDueGas(trackingId);

  if (dueGas?.pending && dueGas?.tracking_id) {
    const payResult = await loop.payGas(dueGas.tracking_id);
    return { hadPendingGas: true, dueGas, payResult };
  }
  return { hadPendingGas: false, dueGas, payResult: null };
}

export async function executeLoopTransaction(index, preparedPayload, extra = {}) {
  await initLoopServerForAccount(index, extra);
  await checkAndPayDueGas(index, extra);

  try {
    return await loop.executeTransaction(preparedPayload);
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      await checkAndPayDueGas(index, extra, error.trackingId);
      return await loop.executeTransaction(preparedPayload);
    }
    throw error;
  }
}

export { loop };