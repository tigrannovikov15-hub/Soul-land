require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== MIDDLEWARE ======
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ====== HEALTH ======
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ====== ХРАНИЛИЩЕ В ПАМЯТИ (для MVP) ======
const saves = new Map();
const payments = new Map();

app.post('/api/save', (req, res) => {
  const { userId, data } = req.body || {};
  if (!userId || !data) return res.status(400).json({ error: 'missing fields' });
  saves.set(String(userId), data);
  res.json({ ok: true });
});

app.get('/api/save/:userId', (req, res) => {
  res.json({ ok: true, data: saves.get(req.params.userId) || null });
});

// ====== МАГАЗИН: PRICES ======
const PRICES = {
  energy_pill: { title: 'Пилюля энергии',      description: '+50 энергии',       price: 30 },
  gold_pack:   { title: 'Мешок золота',        description: '+1000 золота',       price: 50 },
  talisman:    { title: 'Талисман пробуждения',description: 'Новая случайная душа',price: 80 },
  skin_dragon: { title: 'Скин «Бог-Дракон»',   description: 'Золотая аура профиля',price: 150 }
};

// ====== СОЗДАНИЕ ИНВОЙСА STARS ======
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
      provider_token: '',          // для Telegram Stars оставляем пустым
      currency: 'XTR',             // XTR = Telegram Stars
      prices: [{ label: item.title, amount: item.price }]
    });
    res.json({ invoiceLink: link });
  } catch (e) {
    console.error('❌ Invoice error:', e.message);
    res.status(500).json({ error: 'invoice failed', detail: e.message });
  }
});

// ====== WEBHOOK ОТ TELEGRAM (успешная оплата) ======
app.post('/api/shop/webhook', (req, res) => {
  const update = req.body;
  if (update && update.message && update.message.successful_payment) {
    const sp = update.message.successful_payment;
    let parsed = {};
    try { parsed = JSON.parse(sp.invoice_payload || '{}'); } catch (e) {}
    const userId = (update.message.from && update.message.from.id) || 0;
    const itemCode = parsed.itemCode;
    console.log('💎 PAYMENT:', { userId, itemCode, amount: sp.total_amount, charge: sp.telegram_payment_charge_id });
    payments.set(sp.telegram_payment_charge_id, {
      userId, itemCode, amount: sp.total_amount, ts: Date.now()
    });
    // TODO: начислить предмет в БД
  }
  res.sendStatus(200);
});

// ====== СТАРТ СЕРВЕРА ======
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен: http://localhost:${PORT}`);
});

// ====== TELEGRAM БОТ ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : 'https://example.com');

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в переменных окружения');
} else {
  const bot = new Telegraf(BOT_TOKEN);
  global.__bot = bot; // нужен для /api/shop/invoice

  // ====== /start ======
  bot.start((ctx) => {
    const name = ctx.from.first_name || 'Мастер Души';
    const payload = ctx.startPayload; // параметр после ?start=
    let extra = '';
    if (payload && payload.startsWith('ref_')) {
      extra = `\n\n👥 Ты пришёл по приглашению друга!`;
    }
    ctx.replyWithMarkdown(
      `🐉 *Боевой Континент: Путь Души*\n\n` +
      `Привет, *${name}*! Ты стоишь на пороге Академии Шрека.${extra}\n\n` +
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

  // ====== /help ======
  bot.help((ctx) => sendHelp(ctx));
  bot.action('help', (ctx) => { ctx.answerCbQuery(); sendHelp(ctx); });

  function sendHelp(ctx) {
    ctx.replyWithMarkdown(
      `📜 *Как играть*\n\n` +
      `1️⃣ Нажми «🎮 Играть» — откроется Mini App.\n` +
      `2️⃣ Пробуди Боевую Душу на алтаре.\n` +
      `3️⃣ Иди на охоту — побеждай духовных зверей.\n` +
      `4️⃣ После победы поглоти кольцо души.\n` +
      `5️⃣ Прокачивайся и побеждай на Арене.\n\n` +
      `*Ранги:* Ученик → Мастер Души → Доуло → Титулованный Доуло → Бог Души\n\n` +
      `⚡ Энергия тратится на бои. Восстанавливай её отдыхом или жди «Сон духа» пока офлайн.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
    );
  }

  // ====== /profile ======
  bot.command('profile', (ctx) => {
    ctx.replyWithMarkdown(
      `👤 *${ctx.from.first_name}*\n\n` +
      `Открой Mini App, чтобы увидеть детали прогресса.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });

  // ====== /daily ======
  bot.command('daily', (ctx) => {
    ctx.replyWithMarkdown(
      `🎁 *Ежедневная награда*\n\n` +
      `Забери её в игре — вкладка «Задания» внизу.`,
      Markup.inlineKeyboard([[Markup.button.webApp('Получить', WEBAPP_URL)]])
    );
  });

  // ====== /invite ======
  bot.command('invite', (ctx) => sendInvite(ctx));
  bot.action('invite', (ctx) => { ctx.answerCbQuery(); sendInvite(ctx); });

  function sendInvite(ctx) {
    const me = ctx.botInfo.username;
    const link = `https://t.me/${me}?start=ref_${ctx.from.id}`;
    ctx.replyWithMarkdown(
      `👥 *Пригласи друга*\n\n` +
      `Твоя ссылка:\n\`${link}\`\n\n` +
      `За каждого друга, который начнёт играть:\n` +
      `• +200 💰 золота\n• +20 ⚡ энергии\n\n` +
      `_Скопируй ссылку и отправь другу._`,
      Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Играю в «Путь Души» — присоединяйся! 🐉')}`)],
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)]
      ])
    );
  }

  // ====== /top ======
  bot.command('top', (ctx) => {
    ctx.replyWithMarkdown(
      `🏆 *Топ игроков*\n\n` +
      `Смотри рейтинг на Арене в игре.`,
      Markup.inlineKeyboard([[Markup.button.webApp('⚔️ Арена', WEBAPP_URL)]])
    );
  });

  // ====== ОБРАБОТКА PRE-CHECKOUT (Stars) ======
  bot.on('pre_checkout_query', (ctx) => {
    // Можно проверить, что товар существует — и подтвердить
    ctx.answerPreCheckoutQuery(true).catch((e) => console.error('pre_checkout error:', e));
  });

  // ====== SUCCESSFUL PAYMENT ======
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
    // Начисление в БД — см. /api/shop/webhook
  });

  // ====== ЗАПУСК ======
  bot.launch(() => console.log('🚀 Бот запущен'))
     .catch((e) => console.error('❌ Ошибка запуска бота:', e));

  // ====== GRACEFUL SHUTDOWN ======
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ====== ПРОСТОЙ ПЛАНИРОВЩИК УВЕДОМЛЕНИЙ ======
function notifyLoop() {
  setInterval(() => {
    const h = new Date().getHours();
    if (h === 14) console.log('[push] Напоминание: Турнир открыт');
    if (h === 19) console.log('[push] Напоминание: Ледяной Скорпион в Лесу');
  }, 60 * 60 * 1000);
}
notifyLoop();
