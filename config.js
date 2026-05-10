import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({}, { quiet: true });

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v, d = false) {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
}

function loadAccountsFile() {
  const file = process.env.ACCOUNTS_FILE || 'accounts.json';
  const filePath = path.resolve(process.cwd(), file);

  if (!fs.existsSync(filePath)) {
    return { common: {}, accounts: [] };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    common: parsed.common || {},
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
  };
}

const { common, accounts } = loadAccountsFile();

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID || '',
  accountsFile: process.env.ACCOUNTS_FILE || 'accounts.json',

  common: {
    network: common.network || 'mainnet',
    market: common.market || 'CC/USDCx',
    orderType: String(common.orderType || 'market').toLowerCase(),

    // ?? NEW (penting)
    buyStep: num(common.buyStep, 6),     // step USDCx
    minSell: num(common.minSell, 35),   // min CC

    buyDiscount: num(common.buyDiscount, 0.0005),
    sellPremium: num(common.sellPremium, 0.0005),
    slippagePct: num(common.slippagePct, 0.1),
    dryRun: bool(common.dryRun, false)
  },

  accounts: accounts.map((a) => ({
    name: a.name || '',
    apiKey: a.apiKey || '',
    orderType: String(a.orderType || common.orderType || 'market').toLowerCase()
  }))
};