// Полный index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path'); // Добавлен модуль
const xml2js = require('xml2js');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Раздача статических файлов из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

const TINKOFF_CONFIG = {
    terminalKey: process.env.TINKOFF_TERMINAL_KEY,
    password: process.env.TINKOFF_PASSWORD,
    apiUrl: "https://securepay.tinkoff.ru/v2/Init",
    successUrl: "https://securepay.tinkoff.ru/html/payForm/success.html",
    failUrl: "https://securepay.tinkoff.ru/html/payForm/fail.html"
};

function runYmlGenerator() {
    console.log('Запуск фонового генератора YML-фида...');
    const pythonProcess = spawn('python3', ['generate_yml.py']);
    pythonProcess.stdout.on('data', (data) => console.log(`[Python Script]: ${data.toString()}`));
    pythonProcess.stderr.on('data', (data) => console.error(`[Python Script Error]: ${data.toString()}`));
    pythonProcess.on('close', (code) => {
        console.log(`Процесс фоновой генерации завершился с кодом: ${code}`);
    });
}

setTimeout(runYmlGenerator, 5000);
cron.schedule('0 3 1 * *', runYmlGenerator, { scheduled: true, timezone: "Europe/Moscow" });

app.get('/api/catalog', async (req, res) => {
    console.log("Получен запрос на /api/catalog. Читаем готовый YML файл...");
    try {
        if (!fs.existsSync('price_feed.yml')) {
            return res.status(404).json({ error: "Каталог временно недоступен, идет обновление." });
        }
        const ymlData = fs.readFileSync('price_feed.yml', 'utf8');
        const parser = new xml2js.Parser({ explicitArray: false, emptyTag: null });
        const result = await parser.parseStringPromise(ymlData);
        if (!result?.yml_catalog?.shop) { throw new Error("Неверная структура YML файла после парсинга."); }
        const shop = result.yml_catalog.shop;
        const categories = shop.categories?.category ? [].concat(shop.categories.category) : [];
        const offers = shop.offers?.offer ? [].concat(shop.offers.offer) : [];
        res.json({ categories, offers });
    } catch (error) {
        console.error("Критическая ошибка при чтении или парсинге YML:", error);
        res.status(500).json({ error: "Не удалось загрузить каталог из-за внутренней ошибки сервера." });
    }
});

app.post('/api/pay', async (req, res) => {
    const { id, name, price, currency } = req.body;
    if (!TINKOFF_CONFIG.terminalKey || !TINKOFF_CONFIG.password) { return res.status(500).json({ error: "Tinkoff credentials are not configured on the server." }); }
    const requestData = { TerminalKey: TINKOFF_CONFIG.terminalKey, Amount: Math.round(price * 100), OrderId: `${id}-${Date.now()}`, Description: name, SuccessURL: TINKOFF_CONFIG.successUrl, FailURL: TINKOFF_CONFIG.failUrl, Receipt: { Email: "customer@test.ru", Taxation: "usn_income", Items: [{ Name: name, Price: Math.round(price * 100), Quantity: 1.00, Amount: Math.round(price * 100), Tax: "none" }] } };
    const tokenData = { ...requestData, Password: TINKOFF_CONFIG.password }; delete tokenData.Receipt;
    const sortedKeys = Object.keys(tokenData).sort((a, b) => a.localeCompare(b));
    const concatenatedValues = sortedKeys.map(key => tokenData[key]).join('');
    const token = crypto.createHash('sha256').update(concatenatedValues).digest('hex');
    requestData.Token = token;
    try {
        const tinkoffResponse = await fetch(TINKOFF_CONFIG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestData) });
        const result = await tinkoffResponse.json();
        if (result.Success) { res.json({ paymentUrl: result.PaymentURL }); }
        else { console.error("Tinkoff Error:", result); res.status(400).json({ error: `Tinkoff API error: ${result.Message}` }); }
    } catch (error) { console.error("Fetch to Tinkoff failed:", error); res.status(500).json({ error: "Failed to communicate with payment gateway." }); }
});

app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));