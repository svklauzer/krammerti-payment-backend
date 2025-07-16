const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const archiver = require('archiver'); // <-- Добавили зависимость

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- КОНФИГУРАЦИЯ ---
const TINKOFF_CONFIG = {
    terminalKey: process.env.TINKOFF_TERMINAL_KEY,
    password: process.env.TINKOFF_PASSWORD,
    apiUrl: "https://securepay.tinkoff.ru/v2/Init",
};

const SMTP_CONFIG = {
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
};
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const SHOP_INFO = {
    name: "Интернет-магазин Краммерти.рф",
    url: "https://краммерти.рф",
    director: "Кляузер Сергей Викторович",
    inn: "8602310773"
};

// --- НОВЫЙ ПАРАМЕТР ДЛЯ СКАЧИВАНИЯ ---
const DOWNLOAD_SECRET_KEY = process.env.DOWNLOAD_KEY || "default_secret_key_change_me";


// --- ФУНКЦИЯ ОТПРАВКИ EMAIL (без изменений) ---
async function sendNotificationEmail({ to, subject, html }) {
    if (!SMTP_CONFIG.auth.user || !SMTP_CONFIG.auth.pass || !ADMIN_EMAIL) {
        console.error("SMTP или ADMIN_EMAIL не настроены в переменных окружения. Пропускаем отправку письма.");
        return;
    }
    try {
        const transporter = nodemailer.createTransport(SMTP_CONFIG);
        await transporter.verify();
        const mailOptions = { from: `"${SHOP_INFO.name}" <${SMTP_CONFIG.auth.user}>`, to, subject, html };
        await transporter.sendMail(mailOptions);
        console.log(`Письмо успешно отправлено на ${to}`);
    } catch (error) {
        console.error(`Критическая ошибка при отправке письма на ${to}:`, error);
    }
}

// --- ФУНКЦИЯ-ГЕНЕРАТОР YML (без изменений) ---
function runYmlGenerator() {
    return new Promise((resolve, reject) => {
        console.log('Запуск генератора YML-фида...');
        const pythonProcess = spawn('python3', ['generate_yml.py']);
        let errorOutput = '';
        pythonProcess.stdout.on('data', (data) => console.log(`[Python Script]: ${data.toString()}`));
        pythonProcess.stderr.on('data', (data) => {
            console.error(`[Python Script Error]: ${data.toString()}`);
            errorOutput += data.toString();
        });
        pythonProcess.on('close', (code) => {
            if (code === 0) { console.log('Генерация YML-фида успешно завершена.'); resolve(); } 
            else { reject(new Error(`Python script failed with code ${code}: ${errorOutput}`)); }
        });
        pythonProcess.on('error', (err) => { console.error('Не удалось запустить Python-скрипт.', err); reject(err); });
    });
}


// --- API ЭНДПОИНТЫ ---

// Эндпоинт для получения каталога (без изменений)
app.get('/api/catalog', async (req, res) => {
    console.log("Получен запрос на /api/catalog. Читаем готовый YML файл...");
    try {
        if (!fs.existsSync('price_feed.yml')) {
            console.warn("Файл price_feed.yml не найден.");
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


// Эндпоинт для инициализации платежа (без изменений)
app.post('/api/pay', async (req, res) => {
    const { cart, customer } = req.body;
    if (!cart || cart.length === 0 || !customer || !customer.name || !customer.email) {
        return res.status(400).json({ error: "Неполные данные для оформления заказа." });
    }
    const totalAmount = cart.reduce((sum, item) => sum + parseFloat(item.price), 0);
    const receiptItems = cart.map(item => ({ Name: item.name.substring(0, 128), Price: Math.round(parseFloat(item.price) * 100), Quantity: 1.00, Amount: Math.round(parseFloat(item.price) * 100), Tax: "none" }));
    const orderId = `cart-${Date.now()}`;
    const requestData = { TerminalKey: TINKOFF_CONFIG.terminalKey, Amount: Math.round(totalAmount * 100), OrderId: orderId, Description: `Заказ №${orderId} в магазине ${SHOP_INFO.name}`, Receipt: { Email: customer.email, Phone: customer.phone || '', Taxation: "usn_income", Items: receiptItems }, DATA: { CustomerName: customer.name, CustomerEmail: customer.email, CustomerPhone: customer.phone } };
    const tokenData = { ...requestData, Password: TINKOFF_CONFIG.password }; delete tokenData.Receipt; delete tokenData.DATA;
    const sortedKeys = Object.keys(tokenData).sort((a, b) => a.localeCompare(b));
    const concatenatedValues = sortedKeys.map(key => tokenData[key]).join('');
    requestData.Token = crypto.createHash('sha256').update(concatenatedValues).digest('hex');
    try {
        const tinkoffResponse = await fetch(TINKOFF_CONFIG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestData) });
        const result = await tinkoffResponse.json();
        if (result.Success) {
            const subjectClient = `Ваш заказ №${orderId} в ${SHOP_INFO.name} создан`;
            const htmlClient = `<h1>Здравствуйте, ${customer.name}!</h1><p>Ваш заказ №${orderId} успешно создан и ожидает оплаты.</p><p><b>Состав заказа:</b></p><ul>${cart.map(item => `<li>${item.name} - ${item.price} ${item.currency}</li>`).join('')}</ul><p><b>Итого: ${totalAmount.toFixed(2)} RUR</b></p><p>Вы можете завершить оплату по ссылке: <a href="${result.PaymentURL}">Оплатить</a></p><hr><p>С Уважением, ${SHOP_INFO.director}<br>${SHOP_INFO.name}<br>${SHOP_INFO.url}</p>`;
            await sendNotificationEmail({ to: customer.email, subject: subjectClient, html: htmlClient });
            const subjectAdmin = `Новый заказ №${orderId}`;
            const htmlAdmin = `<h1>Новый заказ №${orderId}</h1><p><b>Клиент:</b> ${customer.name}</p><p><b>Email:</b> ${customer.email}</p><p><b>Телефон:</b> ${customer.phone || 'Не указан'}</p><p><b>Состав заказа:</b></p><ul>${cart.map(item => `<li>${item.name} (Код: ${item.id}) - ${item.price} ${item.currency}</li>`).join('')}</ul><p><b>Итого: ${totalAmount.toFixed(2)} RUR</b></p>`;
            await sendNotificationEmail({ to: ADMIN_EMAIL, subject: subjectAdmin, html: htmlAdmin });
            res.json({ paymentUrl: result.PaymentURL });
        } else {
            throw new Error(`Tinkoff API error: ${result.Message}`);
        }
    } catch (error) {
        console.error("Ошибка при инициализации платежа:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- НОВЫЙ ЭНДПОИНТ ДЛЯ СКАЧИВАНИЯ ---
app.get('/api/download-products', (req, res) => {
    if (req.query.key !== DOWNLOAD_SECRET_KEY) {
        return res.status(403).send('Forbidden: Invalid Key');
    }

    const sourceDir = path.join(__dirname, 'products');

    if (!fs.existsSync(sourceDir)) {
        return res.status(404).send('Directory not found. Please wait for generation to complete.');
    }

    res.attachment('products.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => res.status(500).send({ error: err.message }));
    archive.on('end', () => console.log('Archive has been finalized.'));
    
    archive.pipe(res);
    archive.directory(sourceDir, false);
    archive.finalize();
});


// --- ЛОГИКА ЗАПУСКА СЕРВЕРА (без изменений) ---
async function startServer() {
    try {
        console.log("Шаг 1: Первоначальная генерация каталога перед запуском сервера...");
        await runYmlGenerator();
        console.log("Шаг 2: Первоначальный YML-файл готов.");

        app.listen(port, () => {
            console.log(`Шаг 3: Сервер успешно запущен на порту ${port} и готов принимать запросы.`);
        });

        cron.schedule('0 3 1 * *', () => {
            console.log('Плановый запуск генератора YML по расписанию (раз в месяц).');
            runYmlGenerator().catch(err => {
                console.error("Ошибка при плановом обновлении каталога:", err);
            });
        }, {
            scheduled: true,
            timezone: "Europe/Moscow"
        });

    } catch (error) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Не удалось сгенерировать первоначальный каталог. Сервер не будет запущен.", error);
        process.exit(1);
    }
}

// Запускаем всю логику
startServer();