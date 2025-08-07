# generate_yml.py (финальная версия с Indexing API)
import requests
import pandas as pd
import zipfile
import io
import os
import xml.etree.ElementTree as ET
from xml.dom import minidom
from datetime import datetime
import re
import shutil
import json # Добавляем модуль для работы с JSON

# --- КОНФИГУРАЦИЯ ---
PRICE_URL = "https://1c.ru/ftp/pub/pricelst/price_1c.zip"
SHOP_NAME = "Краммерти.рф"
COMPANY_NAME = "ООО \"Краммерти\""
SHOP_URL = "https://краммерти.рф"
WIDGET_PAGE_SLUG = "1c_supermarket" # Путь к странице с вашим виджетом
OUTPUT_YML_FILE = "price_feed.yml"
OUTPUT_HTML_DIR = "products"

# --- ССЫЛКА НА ИЗОБРАЖЕНИЕ, КОТОРАЯ БУДЕТ В YML ---
BACKEND_URL = "https://krammerti-payment-backend.onrender.com"
PRODUCT_IMAGE_URL = f"{BACKEND_URL}/logo-1c.svg" # Правильная ссылка на ваш бэкенд

# --- НОВЫЕ ПАРАМЕТРЫ ДЛЯ INDEXING API ---
YANDEX_API_KEY = os.environ.get('YANDEX_API_KEY')
YANDEX_HOST_ID = os.environ.get('YANDEX_HOST_ID') # <-- Новая переменная
YANDEX_HOST = "https://api.webmaster.yandex.net"

CURRENCY_MAP = {
    'РУБ.': 'RUR', 'USD': 'USD', 'У.Е.': 'USD', 'KZT': 'KZT',
    'BYN': 'BYN', 'KGS': 'KGS', 'EUR': 'EUR', 'MDL': 'MDL',
    'TJS': 'TJS', 'GEL': 'GEL',
}

# --- ОБНОВЛЕННЫЙ ШАБЛОН HTML-СТРАНИЦЫ С ЯНДЕКС.МЕТРИКОЙ ---
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <meta name="description" content="{description}">
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; background-color: #f4f5f7; color: #172b4d; }}
        .container {{ max-width: 800px; margin: 40px auto; padding: 20px 40px; background-color: #fff; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.05); }}
        .product-header {{ border-bottom: 1px solid #dfe1e6; padding-bottom: 20px; margin-bottom: 20px; }}
        h1 {{ font-size: 28px; margin: 0; }}
        .product-code {{ font-size: 14px; color: #5e6c84; margin-top: 5px; }}
        .product-body {{ display: flex; flex-wrap: wrap; gap: 30px; }}
        .product-image {{ width: 150px; height: auto; flex-shrink: 0; object-fit: contain; }}
        .product-info {{ flex-grow: 1; min-width: 300px; }}
        .product-info p {{ line-height: 1.6; }}
        .product-buy-zone {{ margin-top: 30px; padding: 20px; background-color: #fafbfc; border-radius: 6px; text-align: center; }}
        .price {{ font-size: 24px; font-weight: bold; margin-bottom: 15px; }}
        .buy-button {{
            background-color: #e02329; color: white; border: none; border-radius: 6px; padding: 15px 30px;
            font-size: 18px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block;
        }}
    </style>

    <!-- НОВЫЙ БЛОК: Микроразметка Schema.org -->
    <script type="application/ld+json">
    {{
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": "{name_json}",
      "image": "{picture}",
      "description": "{description_json}",
      "sku": "{id}",
      "offers": {{
        "@type": "Offer",
        "url": "{url}",
        "priceCurrency": "{currency}",
        "price": "{price}",
        "availability": "https://schema.org/InStock"
      }}
    }}
    </script>
</head>
<body>
    <div class="container">
        <header class="product-header">
            <h1>{name}</h1>
            <div class="product-code">Код товара: {id}</div>
        </header>
        <main class="product-body">
            <img src="{picture}" alt="{name}" class="product-image">
            <div class="product-info">
                <h2>Описание</h2>
                <p>{description_full}</p>
            </div>
        </main>
        <div class="product-buy-zone">
            <div class="price">Цена: {price} {currency}</div>
            <a href="{buy_link}" class="buy-button">Добавить в корзину и перейти в каталог</a>
        </div>
    </div>

    <!-- Yandex.Metrika counter -->
    <script type="text/javascript">
        (function(m,e,t,r,i,k,a){{
            m[i]=m[i]||function(){{(m[i].a=m[i].a||[]).push(arguments)}};
            m[i].l=1*new Date();
            for (var j = 0; j < document.scripts.length; j++) {{if (document.scripts[j].src === r) {{ return; }}}}
            k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
        }})(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=103609697', 'ym');

        ym(103609697, 'init', {{ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", accurateTrackBounce:true, trackLinks:true}});
    </script>
    <noscript><div><img src="https://mc.yandex.ru/watch/103609697" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
    <!-- /Yandex.Metrika counter -->



</body>
</html>
"""

# --- ИСПРАВЛЕННАЯ ФУНКЦИЯ ДЛЯ ОТПРАВКИ URL В ЯНДЕКС ---
def ping_yandex_for_indexing(url_list):
    if not YANDEX_API_KEY:
        print("Ключ YANDEX_API_KEY не найден. Пропускаем отправку.")
        return
    if not YANDEX_HOST_ID:
        print("YANDEX_HOST_ID не найден. Пропускаем отправку.")
        return

    print(f"Отправка {len(url_list)} URL в Яндекс Indexing API для хоста {YANDEX_HOST_ID}...")
    
    # --- КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: МЕНЯЕМ 'OAuth' НА 'Bearer' ---
    headers = {'Authorization': f'Bearer {YANDEX_API_KEY}', 'Content-Type': 'application/json'}
    
    api_url = f"{YANDEX_HOST}/v4/user/hosts/{YANDEX_HOST_ID}/search-urls/batch"

    for i in range(0, len(url_list), 100):
        chunk = url_list[i:i+100]
        payload = {"url_list": chunk}
        try:
            response = requests.post(api_url, headers=headers, data=json.dumps(payload), timeout=30)
            if response.status_code == 202:
                print(f"Партия из {len(chunk)} URL успешно отправлена в очередь на индексацию.")
            else:
                print(f"Ошибка при отправке URL в Яндекс. Статус: {response.status_code}, Ответ: {response.text}")
        except Exception as e:
            print(f"Исключение при обращении к Яндекс API: {e}")


# 2. Добавить новую функцию для генерации sitemap.xml
def generate_sitemap(offers, base_url, output_dir):
    print("Генерация sitemap.xml...")
    root = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    
    # Добавляем главную страницу каталога
    url_element = ET.SubElement(root, "url")
    ET.SubElement(url_element, "loc").text = f"{base_url}/{WIDGET_PAGE_SLUG}"
    
    # Добавляем все страницы товаров
    for offer in offers:
        url_element = ET.SubElement(root, "url")
        ET.SubElement(url_element, "loc").text = offer['url']

    tree = ET.ElementTree(root)
    file_path = os.path.join(output_dir, "sitemap.xml") # Кладем sitemap в папку products
    tree.write(file_path, encoding='utf-8', xml_declaration=True)
    print(f"Файл sitemap.xml успешно сгенерирован в папке '{output_dir}'.")

def generate_product_pages(offers):
    if os.path.exists(OUTPUT_HTML_DIR):
        shutil.rmtree(OUTPUT_HTML_DIR)
    os.makedirs(OUTPUT_HTML_DIR)
    print(f"Папка '{OUTPUT_HTML_DIR}' создана/очищена.")
    count = 0
    for offer in offers:
        buy_link = f"{SHOP_URL}/{WIDGET_PAGE_SLUG}?addToCart={offer['id']}"
        
        # Готовим данные для вставки, включая недостающий 'description_json'
        page_data = {
            "title": f"Купить {offer['name']} - {SHOP_NAME}",
            "description": f"Купить {offer['name']} по выгодной цене. Код товара: {offer['id']}.",
            "name": offer['name'],
            "id": offer['id'],
            "picture": offer['picture'],
            "price": int(round(offer['price'])),
            "currency": offer['currencyId'],
            "url": offer['url'],
            "description_full": offer['name'], # Используем название как полное описание
            "buy_link": buy_link,
            # Добавляем экранированные версии для JSON-LD
            "name_json": offer['name'].replace('"', '\\"'),
            "description_json": f"Купить {offer['name'].replace('"', '\\"')} по выгодной цене."
        }
        
        page_content = HTML_TEMPLATE.format(**page_data)
        
        file_path = os.path.join(OUTPUT_HTML_DIR, f"{offer['id']}.html")
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(page_content)
        count += 1
    print(f"Успешно сгенерировано {count} HTML-страниц товаров.")

def download_and_extract_pricelist(url):
    print(f"Загрузка прайс-листа с {url}...")
    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            xls_filename = next((name for name in z.namelist() if name.lower().endswith('.xls')), None)
            if not xls_filename: raise FileNotFoundError("XLS file not found in zip.")
            with z.open(xls_filename) as xls_file:
                return pd.read_excel(xls_file, header=1)
    except Exception as e:
        print(f"Ошибка на этапе загрузки или чтения файла: {e}")
        return None

def parse_pricelist(df):
    print("Обработка данных...")
    df.rename(columns={df.columns[0]: 'id', df.columns[1]: 'name', df.columns[3]: 'currency', df.columns[4]: 'price'}, inplace=True)
    categories, offers, used_currencies = [], [], {'RUR'}
    current_category_id = None
    category_regex = re.compile(r'^\s*Раздел\s+(\d+)', re.IGNORECASE)
    for _, row in df.iterrows():
        name_candidate = str(row.get('name', '')).strip()
        id_candidate = str(row.get('id', '')).strip()
        text_to_check = name_candidate if name_candidate != 'nan' else id_candidate
        if text_to_check == 'nan': continue
        match = category_regex.match(text_to_check)
        if match:
            current_category_id = match.group(1)
            category_name = re.sub(r'^\s*Раздел\s*\d+\s*[:.]?\s*', '', text_to_check, count=1).strip()
            categories.append({'id': current_category_id, 'name': category_name})
        elif current_category_id:
            price = pd.to_numeric(str(row.get('price', '')).replace(',', '.'), errors='coerce')
            if pd.notna(price) and price > 0 and pd.notna(row.get('id')) and name_candidate != 'nan':
                product_id_str = str(row['id']).split('.')[0]
                currency_id = CURRENCY_MAP.get(str(row.get('currency', '')).strip().upper(), 'RUR')
                used_currencies.add(currency_id)
                product_page_url = f"{SHOP_URL}/{OUTPUT_HTML_DIR}/{product_id_str}.html"
                offers.append({
                    'id': product_id_str, 'name': name_candidate, 'price': price,
                    'currencyId': currency_id, 'categoryId': current_category_id,
                    'url': product_page_url, 'picture': PRODUCT_IMAGE_URL
                })
    return categories, offers, used_currencies

def generate_yml_feed(categories, offers, used_currencies):
    print("Создание YML фида...")
    yml_catalog = ET.Element('yml_catalog', {'date': datetime.now().strftime('%Y-%m-%d %H:%M')})
    shop = ET.SubElement(yml_catalog, 'shop')
    ET.SubElement(shop, 'name').text = SHOP_NAME
    ET.SubElement(shop, 'company').text = COMPANY_NAME
    ET.SubElement(shop, 'url').text = SHOP_URL
    currencies_xml = ET.SubElement(shop, 'currencies')
    for currency_code in sorted(list(used_currencies)):
        ET.SubElement(currencies_xml, 'currency', {'id': currency_code, 'rate': '1' if currency_code == 'RUR' else 'CBRF'})
    categories_xml = ET.SubElement(shop, 'categories')
    for cat in categories:
        ET.SubElement(categories_xml, 'category', {'id': cat['id']}).text = cat['name']
    offers_xml = ET.SubElement(shop, 'offers')
    for offer in offers:
        offer_element = ET.SubElement(offers_xml, 'offer', {'id': offer['id'], 'available': 'true'})
        for key, value in offer.items():
            if key not in ['id', 'available']: ET.SubElement(offer_element, key).text = str(value)
    xml_string = ET.tostring(yml_catalog, 'utf-8')
    dom = minidom.parseString(xml_string)
    with open(OUTPUT_YML_FILE, 'wb') as f: f.write(dom.toprettyxml(indent="  ", encoding="UTF-8"))
    print(f"YML фид успешно сохранен в файл '{OUTPUT_YML_FILE}'.")

# --- ГЛАВНЫЙ ИСПОЛНЯЕМЫЙ БЛОК (С ИЗМЕНЕНИЯМИ) ---
if __name__ == "__main__":
    dataframe = download_and_extract_pricelist(PRICE_URL)
    if dataframe is not None:
        categories_data, offers_data, currencies_data = parse_pricelist(dataframe)
        if categories_data and offers_data:
            # 1. Генерируем YML
            generate_yml_feed(categories_data, offers_data, currencies_data)
            
            # 2. Генерируем HTML-страницы
            generate_product_pages(offers_data)
            
            # 3. Генерируем Sitemap
            generate_sitemap(offers_data, SHOP_URL, OUTPUT_HTML_DIR)

            # 4. НОВЫЙ ШАГ: Отправляем все URL на быструю индексацию в Яндекс
            all_urls = [offer['url'] for offer in offers_data]
            all_urls.append(f"{SHOP_URL}/{WIDGET_PAGE_SLUG}") # Добавляем и главную страницу каталога
            ping_yandex_for_indexing(all_urls)
        else:
            print("Не удалось извлечь данные для создания фида и страниц.")