require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// СТАТИКА С ОТКЛЮЧЁННЫМ КЭШЕМ ДЛЯ HTML
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.use(express.json({ limit: '2mb' }));

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

// ============================================================
// ГЛАВНАЯ — всегда отдаёт свежий index.html
// ============================================================
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ХРАНИЛИЩЕ В ПАМЯТИ (временно, пока не подключим PostgreSQL)
// ============================================================
const saves = new Map();

app.post('/api/save', (req, res) => {
  const { userId, data } = req.body || {};
  if (!userId || !data) return res.status(400).json({ error: 'missing fields' });
  saves.set(String(userId), data);
  res.json({ ok: true });
});

app.get('/api/save/:userId', (req, res) => {
  res.json({ ok: true, data: saves.get(req.params.userId) || null });
});

// ============================================================
// МАГАЗИН: ЦЕНЫ
// ============================================================
const PRICES = {
  energy_pill: { title: 'Пилюля энергии', description: '+50 энергии', price: 30 },
  gold_pack:   { title: 'Мешок золота', description: '+1000 золота', price: 50 },
  res_pack:    { title: 'Набор ресурсов', description: '+10 трав, +5 кристаллов, +10 руды', price: 60 },
  talisman:    { title: 'Зелье опыта', description: '+500 опыта', price: 80 },
  talent_reset:{ title: 'Сброс талантов', description: 'Вернуть все очки таланта', price: 40 }
};

// ============================================================
// СОЗДАНИЕ ИНВОЙСА STARS
// ============================================================
app.post('/api/shop/invoice', async (req, res) => {
  const { itemCode, userId } = req.body || {};
  const item = PRICES[itemCode];
  if (!item) return res.status(400).json({ error: 'unknown item' });
  const bot = global.__bot;
  if (!bot) return res.status(500).json({ error: 'bot not ready' });
  try {
    const payload = JSON.stringify({ itemCode, userId: userId || 0, ts: Date.now() });
    const link = await bot.telegram.createInvoiceLink({
      title: item.title,
      description: item.description,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: item.title, amount: item.price }]
    });
    res.json({ invoiceLink: link });
  } catch (e) {
    console.error('❌ Invoice error:', e.message);
    res.status(500).json({ error: 'invoice failed', detail: e.message });
  }
});

// ============================================================
// WEBHOOK ОТ TELEGRAM
// ============================================================
app.post('/api/shop/webhook', (req, res) => {
  const update = req.body;
  if (update && update.message && update.message.successful_payment) {
    const sp = update.message.successful_payment;
    let parsed = {};
    try { parsed = JSON.parse(sp.invoice_payload || '{}'); } catch (e) {}
    console.log('💎 PAYMENT:', {
      userId: update.message.from.id,
      itemCode: parsed.itemCode,
      amount: sp.total_amount,
      charge: sp.telegram_payment_charge_id
    });
  }
  res.sendStatus(200);
});

// ============================================================
// СТАРТ СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен: http://localhost:${PORT}`);
});

// ============================================================
// TELEGRAM БОТ
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : 'https://example.com');

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в переменных окружения');
} else {
  const bot = new Telegraf(BOT_TOKEN);
  global.__bot = bot;

  bot.start((ctx) => {
    const name = ctx.from.first_name || 'Мастер Души';
    ctx.replyWithMarkdown(
      `🐉 *Боевой Континент: Путь Души*\n\n` +
      `Привет, *${name}*! Ты стоишь на пороге Академии Шрека.\n\n` +
      `• Пробуди свою Боевую Душу\n` +
      `• Побеждай духовных зверей\n` +
      `• Поглощай кольца душ и расти до Бога Души\n` +
      `• Сражайся на Арене за рейтинг`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)],
        [
          Markup.button.callback('📜 Как играть', 'help'),
          Markup.button.callback('👥 Пригласить', 'invite')
        ]
      ])
    );
  });

  bot.help((ctx) => sendHelp(ctx));
  bot.action('help', (ctx) => { ctx.answerCbQuery(); sendHelp(ctx); });

  function sendHelp(ctx) {
    ctx.replyWithMarkdown(
      `📜 *Как играть*\n\n` +
      `1️⃣ Нажми «🎮 Играть» — откроется Mini App.\n` +
      `2️⃣ Выбери героя и школу.\n` +
      `3️⃣ Пробуди Боевую Душу на алтаре.\n` +
      `4️⃣ Иди на охоту — побеждай зверей.\n` +
      `5️⃣ Поглощай кольца и побеждай на Арене.\n\n` +
      `*Ранги:* Ученик → Мастер Души → Доуло → Титулованный Доуло → Бог Души`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
    );
  }

  bot.command('profile', (ctx) => {
    ctx.replyWithMarkdown(
      `👤 *${ctx.from.first_name}*\n\nОткрой Mini App, чтобы увидеть прогресс.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });

  bot.command('invite', (ctx) => sendInvite(ctx));
  bot.action('invite', (ctx) => { ctx.answerCbQuery(); sendInvite(ctx); });

  function sendInvite(ctx) {
    const me = ctx.botInfo.username;
    const link = `https://t.me/${me}?start=ref_${ctx.from.id}`;
    ctx.replyWithMarkdown(
      `👥 *Пригласи друга*\n\nТвоя ссылка:\n\`${link}\`\n\n` +
      `За каждого друга, который начнёт играть:\n` +
      `• +200 💰 золота\n• +20 ⚡ энергии`,
      Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Играю в «Путь Души» — присоединяйся! 🐉')}`)],
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)]
      ])
    );
  }

  bot.on('pre_checkout_query', (ctx) => {
    ctx.answerPreCheckoutQuery(true).catch((e) => console.error('pre_checkout error:', e));
  });

  bot.on('successful_payment', (ctx) => {
    const sp = ctx.message.successful_payment;
    let parsed = {};
    try { parsed = JSON.parse(sp.invoice_payload || '{}'); } catch (e) {}
    const itemCode = parsed.itemCode || 'unknown';
    const label = PRICES[itemCode] ? PRICES[itemCode].title : itemCode;
    ctx.replyWithMarkdown(
      `✅ *Оплата получена!*\n\n` +
      `Ты купил: *${label}*\n` +
      `Потрачено: ${sp.total_amount} ⭐\n\n` +
      `Открой игру, чтобы забрать покупку.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });

  bot.launch(() => console.log('🚀 Бот запущен'))
     .catch((e) => console.error('❌ Ошибка запуска бота:', e));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ============================================================
// ПЛАНИРОВЩИК УВЕДОМЛЕНИЙ (заглушка)
// ============================================================
setInterval(() => {
  const h = new Date().getHours();
  if (h === 14) console.log('[push] Турнир открыт');
  if (h === 19) console.log('[push] Ледяной Скорпион в Лесу');
}, 60 * 60 * 1000);
