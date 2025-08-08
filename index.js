// index.js (финальная, проверенная версия)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const archiver = require('archiver');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Раздаем YML файл из папки dist для Яндекса и статику
app.use(express.static(path.join(__dirname, 'dist'))); 

const TINKOFF_CONFIG = {
    terminalKey: process.env.TINKOFF_TERMINAL_KEY,
    password: process.env.TINKOFF_PASSWORD,
    apiUrl: "https://securepay.tinkoff.ru/v2/Init",
};
const SMTP_CONFIG = {
    host: 'smtp.yandex.ru', port: 465, secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
};
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const SHOP_INFO = {
    name: "Интернет-магазин Краммерти.рф", url: "https://краммерти.рф",
    director: "Кляузер Сергей Викторович", inn: "8602310773"
};
const DOWNLOAD_SECRET_KEY = process.env.DOWNLOAD_KEY || "default_secret_key_change_me";

let catalogCache = null;

function runYmlGeneratorAndUpdateCache() {
    return new Promise((resolve, reject) => {
        console.log('Запуск генератора YML-фида и обновление кэша...');
        const pythonProcess = spawn('python3', ['generate_yml.py']);
        pythonProcess.stdout.on('data', (data) => console.log(`[Python Script]: ${data.toString()}`));
        pythonProcess.stderr.on('data', (data) => console.error(`[Python Script Error]: ${data.toString()}`));
        pythonProcess.on('close', async (code) => {
            if (code === 0) {
                console.log('Генерация завершена. Обновляем кэш...');
                try {
                    const ymlData = fs.readFileSync(path.join(__dirname, 'dist', 'price_feed.yml'), 'utf8');
                    const parser = new xml2js.Parser({ explicitArray: false, emptyTag: null });
                    const result = await parser.parseStringPromise(ymlData);
                    if (!result?.yml_catalog?.shop) { throw new Error("Неверная структура YML."); }
                    const shop = result.yml_catalog.shop;
                    catalogCache = {
                        categories: shop.categories?.category ? [].concat(shop.categories.category) : [],
                        offers: shop.offers?.offer ? [].concat(shop.offers.offer) : []
                    };
                    console.log('Кэш каталога успешно обновлен.');
                    resolve();
                } catch (error) { console.error("Ошибка при обновлении кэша:", error); reject(error); }
            } else { reject(new Error(`Python script failed with code ${code}`)); }
        });
    });
}

// Эндпоинты
app.get('/api/catalog', (req, res) => {
    if (catalogCache) res.json(catalogCache);
    else res.status(503).json({ error: "Каталог инициализируется. Пожалуйста, попробуйте через минуту." });
});

app.get('/api/download-site-files', (req, res) => {
    if (req.query.key !== DOWNLOAD_SECRET_KEY) return res.status(403).send('Forbidden');
    const sourceDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(sourceDir)) return res.status(404).send('Directory not found.');
    res.attachment('krammerti_site_files.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.status(500).send({ error: err.message }));
    archive.pipe(res);
    archive.directory(sourceDir, false);
    archive.finalize();
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


// --- ЛОГИКА ЗАПУСКА (обновлен путь к YML в кэше) ---
async function startServer() {
    try {
        await runYmlGeneratorAndUpdateCache();
        app.listen(port, () => {
            console.log(`Сервер запущен на порту ${port} с готовым кэшем каталога.`);
        });
        cron.schedule('0 3 1 * *', () => {
            runYmlGeneratorAndUpdateCache().catch(err => console.error("Ошибка при плановом обновлении кэша:", err));
        });
    } catch (error) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА при запуске:", error);
        process.exit(1);
    }
}

startServer();