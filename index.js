const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const crypto = require('crypto');
const cron = require('node-cron');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer'); // Добавили nodemailer

const app = express();
const port = process.env.PORT || 3000;

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

// --- ФУНКЦИЯ ОТПРАВКИ EMAIL ---
async function sendNotificationEmail({ to, subject, html }) {
    if (!SMTP_CONFIG.auth.user || !SMTP_CONFIG.auth.pass) {
        console.error("SMTP credentials not configured. Skipping email.");
        return;
    }
    const transporter = nodemailer.createTransport(SMTP_CONFIG);
    try {
        await transporter.sendMail({
            from: `"${SHOP_INFO.name}" <${SMTP_CONFIG.auth.user}>`,
            to,
            subject,
            html
        });
        console.log(`Email sent successfully to ${to}`);
    } catch (error) {
        console.error(`Error sending email to ${to}:`, error);
    }
}

// --- API ЭНДПОИНТ ДЛЯ ОПЛАТЫ (ПОЛНОСТЬЮ ПЕРЕРАБОТАН) ---
app.post('/api/pay', async (req, res) => {
    // Получаем новые данные: корзина и информация о клиенте
    const { cart, customer } = req.body;

    if (!cart || cart.length === 0 || !customer || !customer.name || !customer.email) {
        return res.status(400).json({ error: "Неполные данные для оформления заказа." });
    }

    // 1. Формируем детализированный чек
    const totalAmount = cart.reduce((sum, item) => sum + parseFloat(item.price), 0);
    const receiptItems = cart.map(item => ({
        Name: item.name.substring(0, 128), // Ограничение длины названия для чека
        Price: Math.round(parseFloat(item.price) * 100),
        Quantity: 1.00,
        Amount: Math.round(parseFloat(item.price) * 100),
        Tax: "none"
    }));

    const orderId = `cart-${Date.now()}`;
    const requestData = {
        TerminalKey: TINKOFF_CONFIG.terminalKey,
        Amount: Math.round(totalAmount * 100),
        OrderId: orderId,
        Description: `Заказ №${orderId} в магазине ${SHOP_INFO.name}`,
        Receipt: {
            Email: customer.email, // Используем email клиента для чека
            Phone: customer.phone || '',
            Taxation: "usn_income",
            Items: receiptItems
        },
        // DATA - для передачи доп. информации, которую Тинькофф вернет в нотификации
        DATA: {
            CustomerName: customer.name,
            CustomerEmail: customer.email,
            CustomerPhone: customer.phone
        }
    };

    // 2. Рассчитываем токен
    const tokenData = { ...requestData, Password: TINKOFF_CONFIG.password };
    delete tokenData.Receipt; // Чек не участвует в подписи
    delete tokenData.DATA; // DATA не участвует в подписи
    const sortedKeys = Object.keys(tokenData).sort((a, b) => a.localeCompare(b));
    const concatenatedValues = sortedKeys.map(key => tokenData[key]).join('');
    requestData.Token = crypto.createHash('sha256').update(concatenatedValues).digest('hex');

    // 3. Отправляем запрос в Т-Банк
    try {
        const tinkoffResponse = await fetch(TINKOFF_CONFIG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        const result = await tinkoffResponse.json();
        
        if (result.Success) {
            // Если все хорошо, отправляем уведомления
            const subjectClient = `Ваш заказ №${orderId} в ${SHOP_INFO.name} создан`;
            const htmlClient = `
                <h1>Здравствуйте, ${customer.name}!</h1>
                <p>Ваш заказ №${orderId} успешно создан и ожидает оплаты.</p>
                <p><b>Состав заказа:</b></p>
                <ul>
                    ${cart.map(item => `<li>${item.name} - ${item.price} ${item.currency}</li>`).join('')}
                </ul>
                <p><b>Итого: ${totalAmount.toFixed(2)} RUR</b></p>
                <p>Вы можете завершить оплату по ссылке: <a href="${result.PaymentURL}">Оплатить</a></p>
                <hr>
                <p>С Уважением, ${SHOP_INFO.director}<br>${SHOP_INFO.name}<br>${SHOP_INFO.url}</p>
            `;
            await sendNotificationEmail({ to: customer.email, subject: subjectClient, html: htmlClient });

            const subjectAdmin = `Новый заказ №${orderId}`;
            const htmlAdmin = `
                <h1>Новый заказ №${orderId}</h1>
                <p><b>Клиент:</b> ${customer.name}</p>
                <p><b>Email:</b> ${customer.email}</p>
                <p><b>Телефон:</b> ${customer.phone || 'Не указан'}</p>
                <p><b>Состав заказа:</b></p>
                <ul>
                    ${cart.map(item => `<li>${item.name} (Код: ${item.id}) - ${item.price} ${item.currency}</li>`).join('')}
                </ul>
                <p><b>Итого: ${totalAmount.toFixed(2)} RUR</b></p>
            `;
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

// Остальные части: запуск YML-генератора и эндпоинт /api/catalog без изменений
function runYmlGenerator() { /* ... */ }
setTimeout(runYmlGenerator, 5000);
cron.schedule('0 3 1 * *', runYmlGenerator, { scheduled: true, timezone: "Europe/Moscow" });
app.get('/api/catalog', async (req, res) => { /* ... */ });
app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));