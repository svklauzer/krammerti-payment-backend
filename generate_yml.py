# generate_yml.py (финальная, проверенная версия)
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
import json

# --- КОНФИГУРАЦИЯ ---
PRICE_URL = "https://1c.ru/ftp/pub/pricelst/price_1c.zip"
SHOP_NAME = "Краммерти.рф"
COMPANY_NAME = "ООО \"Краммерти\""
SHOP_URL = "https://краммерти.рф"
SHOP_URL_PUNYCODE = "https://xn--80akjflazes.xn--p1ai"
WIDGET_PAGE_SLUG = "1c_supermarket"
BACKEND_URL = "https://krammerti-payment-backend.onrender.com"
PRODUCT_IMAGE_URL = f"{BACKEND_URL}/logo-1c.svg" 

OUTPUT_DIR = "dist"
PRODUCTS_SUBDIR = "products"
YML_FILENAME = "price_feed.yml"

INDEXNOW_KEY = os.environ.get('INDEXNOW_KEY')
INDEXNOW_API_URL = "https://yandex.ru/indexnow"

STATIC_PAGES = ["/", "/1c_supermarket", "/1c-bitrix_aspro", "/krammerti_software_catalog", "/contacts", "/brand", "/terms", "/privacy-policy", "/returns", "/delivery-payment"]

CURRENCY_MAP = {
    'РУБ.': 'RUR', 'USD': 'USD', 'У.Е.': 'USD', 'KZT': 'KZT',
    'BYN': 'BYN', 'KGS': 'KGS', 'EUR': 'EUR', 'MDL': 'MDL',
    'TJS': 'TJS', 'GEL': 'GEL',
}

HTML_TEMPLATE = """...""" # Шаблон без изменений

def generate_seo_files(offers, static_pages, base_url, base_url_punycode, output_dir):
    print("Генерация SEO-файлов (robots.txt, sitemaps)...")
    products_sitemap_path = f"{base_url}/{PRODUCTS_SUBDIR}/sitemap_products.xml"
    main_sitemap_path = f"{base_url}/sitemap_main.xml"
    robots_content = f"User-agent: *\nDisallow:\n\nHost: {base_url_punycode}\n\nSitemap: {main_sitemap_path}\nSitemap: {products_sitemap_path}\n"
    with open(os.path.join(output_dir, "robots.txt"), 'w', encoding='utf-8') as f: f.write(robots_content)
    
    root_main = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for page in static_pages: ET.SubElement(ET.SubElement(root_main, "url"), "loc").text = f"{base_url.rstrip('/')}{page}"
    tree_main = ET.ElementTree(root_main)
    tree_main.write(os.path.join(output_dir, "sitemap_main.xml"), encoding='utf-8', xml_declaration=True)
    
    root_products = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for offer in offers: ET.SubElement(ET.SubElement(root_products, "url"), "loc").text = offer['url']
    tree_products = ET.ElementTree(root_products)
    # ИСПРАВЛЕНО: Правильный путь для sitemap товаров
    tree_products.write(os.path.join(output_dir, PRODUCTS_SUBDIR, "sitemap_products.xml"), encoding='utf-8', xml_declaration=True)
    print("SEO-файлы успешно сгенерированы.")

def ping_indexnow(url_list):
    if not INDEXNOW_KEY:
        print("Ключ INDEXNOW_KEY не найден. Пропускаем отправку.")
        return
    print(f"Отправка {len(url_list)} URL в Яндекс через IndexNow...")
    headers = {'Content-Type': 'application/json; charset=utf-8'}
    host = SHOP_URL_PUNYCODE.replace("https://", "").replace("http://", "").split('/')[0]
    key_location = f"{SHOP_URL_PUNYCODE}/{INDEXNOW_KEY}.txt"
    payload = { "host": host, "key": INDEXNOW_KEY, "keyLocation": key_location, "urlList": url_list }
    try:
        response = requests.post(INDEXNOW_API_URL, headers=headers, data=json.dumps(payload), timeout=30)
        if response.status_code in [200, 202]:
            print(f"Успешный ответ от IndexNow ({response.status_code}): URL отправлены в очередь.")
        else:
            print(f"Ошибка при отправке URL в IndexNow. Статус: {response.status_code}, Ответ: {response.text}")
    except Exception as e:
        print(f"Исключение при обращении к IndexNow API: {e}")

def generate_product_pages(offers, output_base_dir):
    products_path = os.path.join(output_base_dir, PRODUCTS_SUBDIR)
    print(f"Генерация HTML-страниц в папке '{products_path}'...")
    count = 0
    for offer in offers:
        buy_link = f"{SHOP_URL}/{WIDGET_PAGE_SLUG}?addToCart={offer['id']}"
        description_text = offer.get('description', offer['name'])
        page_data = {
            "title": f"Купить {offer['name']} - {SHOP_NAME}",
            "description": f"Купить {offer['name']} по выгодной цене. Код товара: {offer['id']}.",
            "name": offer['name'], "id": offer['id'], "picture": offer['picture'],
            "price": int(round(offer['price'])), "currency": offer['currencyId'], "url": offer['url'],
            "description_full": description_text, "buy_link": buy_link,
            "name_json": offer['name'].replace('"', '\\"'),
            "description_json": (description_text.split('.')[0] + ".").replace('"', '\\"')
        }
        page_content = HTML_TEMPLATE.format(**page_data)
        file_path = os.path.join(products_path, f"{offer['id']}.html")
        with open(file_path, 'w', encoding='utf-8') as f: f.write(page_content)
        count += 1
    print(f"Успешно сгенерировано {count} HTML-страниц товаров.")

def download_and_extract_pricelist(url):
    print(f"Загрузка прайс-листа с {url}...")
    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            xls_filename = next((name for name in z.namelist() if name.lower().endswith('.xls')), None)
            if not xls_filename: raise FileNotFoundError("XLS file not found.")
            with z.open(xls_filename) as xls_file: return pd.read_excel(xls_file, header=1)
    except Exception as e:
        print(f"Ошибка на этапе загрузки: {e}")
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
            product_id_str = str(row.get('id', '')).split('.')[0]
            if pd.notna(price) and price > 0 and product_id_str != 'nan' and name_candidate != 'nan':
                currency_id = CURRENCY_MAP.get(str(row.get('currency', '')).strip().upper(), 'RUR')
                used_currencies.add(currency_id)
                product_page_url = f"{SHOP_URL}/{PRODUCTS_SUBDIR}/{product_id_str}.html"
                offers.append({
                    'id': product_id_str, 'name': name_candidate, 'price': price,
                    'currencyId': currency_id, 'categoryId': current_category_id,
                    'url': product_page_url, 'picture': PRODUCT_IMAGE_URL
                })
    return categories, offers, used_currencies

def generate_yml_feed(categories, offers, used_currencies, output_path):
    print("Создание YML фида...")
    yml_catalog = ET.Element('yml_catalog', {'date': datetime.now().strftime('%Y-%m-%d %H:%M')})
    shop = ET.SubElement(yml_catalog, 'shop')
    ET.SubElement(shop, 'name').text = SHOP_NAME
    ET.SubElement(shop, 'company').text = COMPANY_NAME # Добавлено
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
        # ИСПРАВЛЕНО: Явно указываем поля для избежания лишних данных
        offer_data = {
            'url': offer.get('url'), 'price': str(int(round(offer.get('price', 0)))), 'currencyId': offer.get('currencyId'),
            'categoryId': str(offer.get('categoryId')), 'picture': offer.get('picture'), 'name': offer.get('name'),
            'description': offer.get('name')
        }
        for key, value in offer_data.items():
            if value is not None: ET.SubElement(offer_element, key).text = value
    xml_string = ET.tostring(yml_catalog, 'utf-8')
    dom = minidom.parseString(xml_string)
    with open(output_path, 'wb') as f: f.write(dom.toprettyxml(indent="  ", encoding="UTF-8"))
    print(f"YML фид успешно сохранен в файл '{output_path}'.")

if __name__ == "__main__":
    if os.path.exists(OUTPUT_DIR): shutil.rmtree(OUTPUT_DIR)
    os.makedirs(os.path.join(OUTPUT_DIR, PRODUCTS_SUBDIR))
    dataframe = download_and_extract_pricelist(PRICE_URL)
    if dataframe is not None:
        categories_data, offers_data, currencies_data = parse_pricelist(dataframe)
        if categories_data and offers_data:
            generate_yml_feed(categories_data, offers_data, currencies_data, os.path.join(OUTPUT_DIR, YML_FILENAME))
            generate_product_pages(offers_data, OUTPUT_DIR)
            generate_seo_files(offers_data, STATIC_PAGES, SHOP_URL, SHOP_URL_PUNYCODE, OUTPUT_DIR)
            all_urls = [offer['url'] for offer in offers_data]
            all_urls.extend([f"{SHOP_URL.rstrip('/')}{page}" for page in STATIC_PAGES])
            ping_indexnow(all_urls)