require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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

app.listen(PORT, () => {
  console.log(`🌐 Сервер: http://localhost:${PORT}`);
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'example.com'}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан');
} else {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    const name = ctx.from.first_name || 'Мастер Души';
    ctx.replyWithMarkdown(
      `🐉 *Боевой Континент: Путь Души*\n\n` +
      `Привет, *${name}*! Ты стоишь на пороге Академии Шрека.\n\n` +
      `• Пробуди свою Боевую Душу\n` +
      `• Побеждай духовных зверей\n` +
      `• Поглощай кольца душ и расти до Бога Души`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)],
        [Markup.button.callback('📜 Как играть', 'help')]
      ])
    );
  });

  bot.help((ctx) => ctx.replyWithMarkdown(
    `📜 *Как играть*\n\n` +
    `1️⃣ Нажми «Играть», чтобы открыть Mini App.\n` +
    `2️⃣ Пробуди свою Боевую Душу на алтаре.\n` +
    `3️⃣ Иди на охоту — побеждай зверей.\n` +
    `4️⃣ После победы поглоти кольцо души.\n` +
    `5️⃣ Прокачивайся и побеждай на Арене.`,
    Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
  ));

  bot.action('help', (ctx) => {
    ctx.answerCbQuery();
    ctx.replyWithMarkdown(
      `📜 *Как играть:* жми «🎮 Играть» — и погнали!`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
    );
  });

  bot.command('profile', (ctx) => {
    ctx.replyWithMarkdown(
      `👤 *${ctx.from.first_name}*\n\n` +
      `Прогресс сохраняется в игре. Открой Mini App, чтобы увидеть детали.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });

  bot.launch(() => console.log('🚀 Бот запущен'))
     .catch((e) => console.error('❌ Ошибка бота:', e));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
