const express = require('express');
const cors = require('cors');
const fs = require('fs');
const xml2js = require('xml2js');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const TINKOFF_CONFIG = {
    terminalKey: process.env.TINKOFF_TERMINAL_KEY,
    password: process.env.TINKOFF_PASSWORD,
    apiUrl: "https://securepay.tinkoff.ru/v2/Init",
    successUrl: "https://securepay.tinkoff.ru/html/payForm/success.html",
    failUrl: "https://securepay.tinkoff.ru/html/payForm/fail.html"
};

/**
 * Функция для запуска Python-скрипта генерации YML
 */
function runYmlGenerator() {
    console.log('Запуск генератора YML-фида...');
    
    // Используем 'python3' для совместимости
    const pythonProcess = spawn('python3', ['generate_yml.py']);

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python Script]: ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Script Error]: ${data}`);
    });

    pythonProcess.on('close', (code) => {
        if (code === 0) {
            console.log('Генерация YML-фида успешно завершена.');
        } else {
            console.error(`Процесс генерации завершился с кодом ошибки: ${code}`);
        }
    });
}

// --- АВТОМАТИЗАЦИЯ ---
// 1. Запускаем генератор один раз при старте сервера, чтобы файл точно был
runYmlGenerator();

// 2. Устанавливаем расписание: запускать в 03:00 ночи 1-го числа каждого месяца
cron.schedule('0 3 1 * *', () => {
    console.log('Плановый запуск генератора YML по расписанию (раз в месяц).');
    runYmlGenerator();
}, {
    scheduled: true,
    timezone: "Europe/Moscow"
});

// --- API ЭНДПОИНТЫ ---

// Эндпоинт для получения каталога
app.get('/api/catalog', async (req, res) => {
    try {
        if (!fs.existsSync('price_feed.yml')) {
            return res.status(404).json({ error: "Файл каталога (price_feed.yml) еще не сгенерирован. Пожалуйста, подождите." });
        }
        const ymlData = fs.readFileSync('price_feed.yml', 'utf8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(ymlData);

        const shop = result.yml_catalog.shop;
        res.json({
            categories: shop.categories.category,
            offers: shop.offers.offer
        });
    } catch (error) {
        console.error("Ошибка чтения или парсинга YML:", error);
        res.status(500).json({ error: "Не удалось загрузить каталог" });
    }
});

// Эндпоинт для инициализации платежа (без изменений)
app.post('/api/pay', async (req, res) => {
    // ... (код этого эндпоинта остается точно таким же, как в предыдущем ответе)
    const { id, name, price, currency } = req.body;

    if (!TINKOFF_CONFIG.terminalKey || !TINKOFF_CONFIG.password) {
        return res.status(500).json({ error: "Tinkoff credentials are not configured on the server." });
    }
    
    const requestData = {
        TerminalKey: TINKOFF_CONFIG.terminalKey,
        Amount: price * 100,
        OrderId: `${id}-${Date.now()}`,
        Description: name,
        SuccessURL: TINKOFF_CONFIG.successUrl,
        FailURL: TINKOFF_CONFIG.failUrl,
        Receipt: {
            Email: "customer@test.ru",
            Taxation: "usn_income",
            Items: [{
                Name: name,
                Price: price * 100,
                Quantity: 1.00,
                Amount: price * 100,
                Tax: "none"
            }]
        }
    };
    const tokenData = { ...requestData, Password: TINKOFF_CONFIG.password };
    delete tokenData.Receipt;
    const sortedKeys = Object.keys(tokenData).sort((a, b) => a.localeCompare(b));
    const concatenatedValues = sortedKeys.map(key => tokenData[key]).join('');
    const token = crypto.createHash('sha256').update(concatenatedValues).digest('hex');
    requestData.Token = token;

    try {
        const tinkoffResponse = await fetch(TINKOFF_CONFIG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        const result = await tinkoffResponse.json();
        if (result.Success) {
            res.json({ paymentUrl: result.PaymentURL });
        } else {
            console.error("Tinkoff Error:", result);
            res.status(400).json({ error: `Tinkoff API error: ${result.Message}` });
        }
    } catch (error) {
        console.error("Fetch to Tinkoff failed:", error);
        res.status(500).json({ error: "Failed to communicate with payment gateway." });
    }
});


app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
});