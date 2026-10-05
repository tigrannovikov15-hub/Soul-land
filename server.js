const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище сохранений (в памяти, для простоты)
const saves = new Map();

// Простая проверка Telegram initData (опционально)
function verifyTelegramData(initData) {
    // В продакшене здесь должна быть проверка HMAC с токеном бота
    return !!initData;
}

// Сохранение прогресса
app.post('/api/save', (req, res) => {
    try {
        const initData = req.headers['x-telegram-init-data'];
        if (!initData) return res.status(401).json({ error: 'No auth' });

        // Используем хеш initData как ключ пользователя
        const userId = crypto.createHash('sha256').update(initData).digest('hex').slice(0, 16);
        saves.set(userId, req.body.data);
        console.log(`💾 Saved user ${userId}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Загрузка сохранения
app.get('/api/save', (req, res) => {
    try {
        const initData = req.headers['x-telegram-init-data'];
        if (!initData) return res.status(401).json({ error: 'No auth' });

        const userId = crypto.createHash('sha256').update(initData).digest('hex').slice(0, 16);
        const save = saves.get(userId);
        res.json({ save: save || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🐉 Soul Land сервер запущен на порту ${PORT}`);
});
