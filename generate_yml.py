# generate_yml.py (с правильной ссылкой на картинку)
import requests
import pandas as pd
import zipfile
import io
import os
import xml.etree.ElementTree as ET
from xml.dom import minidom
from datetime import datetime
import re

# --- КОНФИГУРАЦИЯ ---
PRICE_URL = "https://1c.ru/ftp/pub/pricelst/price_1c.zip"
SHOP_NAME = "Краммерти.рф"
COMPANY_NAME = "ООО \"Краммерти\""
SHOP_URL = "https://краммерти.рф"
OUTPUT_YML_FILE = "price_feed.yml"

# --- ССЫЛКА НА ИЗОБРАЖЕНИЕ, КОТОРАЯ БУДЕТ В YML ---
# ВАЖНО: Укажите здесь URL вашего бэкенд-сервиса на Render!
BACKEND_URL = "https://krammerti-payment-backend.onrender.com"
PRODUCT_IMAGE_URL = f"{BACKEND_URL}/logo-1c.svg" 

CURRENCY_MAP = {
    'РУБ.': 'RUR', 'USD': 'USD', 'У.Е.': 'USD', 'KZT': 'KZT',
    'BYN': 'BYN', 'KGS': 'KGS', 'EUR': 'EUR', 'MDL': 'MDL',
    'TJS': 'TJS', 'GEL': 'GEL',
}

# ... все остальные функции (download_and_extract_pricelist, parse_pricelist, generate_yml_feed, __main__)
# остаются ТОЧНО ТАКИМИ ЖЕ, как в предыдущем ответе. Их менять не нужно.

# Для полноты, привожу весь код файла еще раз
def download_and_extract_pricelist(url):
    print(f"Загрузка прайс-листа с {url}...")
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        print("Распаковка архива...")
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            xls_filename = next((name for name in z.namelist() if name.lower().endswith('.xls')), None)
            if not xls_filename: raise FileNotFoundError("В архиве не найден .xls файл.")
            with z.open(xls_filename) as xls_file:
                df = pd.read_excel(xls_file, header=1)
                print(f"Файл '{xls_filename}' успешно прочитан.")
                return df
    except Exception as e:
        print(f"Ошибка на этапе загрузки или чтения файла: {e}")
        return None

def parse_pricelist(df):
    print("Обработка данных...")
    df.rename(columns={df.columns[0]: 'id', df.columns[1]: 'name', df.columns[3]: 'currency', df.columns[4]: 'price'}, inplace=True)
    print("Колонки успешно переименованы.")
    categories, offers = [], []
    current_category_id = None
    used_currencies = {'RUR'}
    category_regex = re.compile(r'^\s*Раздел\s+(\d+)', re.IGNORECASE)
    for index, row in df.iterrows():
        name_candidate1 = str(row['name']).strip()
        name_candidate2 = str(row['id']).strip()
        text_to_check = name_candidate1 if name_candidate1 != 'nan' else name_candidate2
        if text_to_check == 'nan': continue
        match = category_regex.match(text_to_check)
        if match:
            category_id = match.group(1)
            category_name = re.sub(r'^\s*Раздел\s*\d+\s*[:.]?\s*', '', text_to_check, count=1).strip()
            categories.append({'id': category_id, 'name': category_name})
            current_category_id = category_id
        elif current_category_id:
            price_str = str(row['price']).replace(',', '.')
            price = pd.to_numeric(price_str, errors='coerce')
            product_id, product_name = row['id'], str(row['name']).strip()
            if pd.notna(price) and price > 0 and pd.notna(product_id) and product_name != 'nan':
                currency_from_file = str(row['currency']).strip().upper()
                currency_id = CURRENCY_MAP.get(currency_from_file, 'RUR')
                used_currencies.add(currency_id)
                product_id_str = str(product_id).split('.')[0]
                offers.append({
                    'id': product_id_str, 'name': product_name, 'price': price,
                    'currencyId': currency_id, 'categoryId': current_category_id,
                    'url': f"{SHOP_URL}/product/{product_id_str}",
                    'picture': PRODUCT_IMAGE_URL
                })
    print(f"Обработка завершена. Найдено категорий: {len(categories)}, товаров: {len(offers)}.")
    print(f"Используемые валюты в прайсе: {sorted(list(used_currencies))}")
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
        rate = '1' if currency_code == 'RUR' else 'CBRF'
        ET.SubElement(currencies_xml, 'currency', {'id': currency_code, 'rate': rate})
    categories_xml = ET.SubElement(shop, 'categories')
    for cat in categories:
        ET.SubElement(categories_xml, 'category', {'id': cat['id']}).text = cat['name']
    offers_xml = ET.SubElement(shop, 'offers')
    for offer in offers:
        offer_element = ET.SubElement(offers_xml, 'offer', {'id': offer['id'], 'available': 'true'})
        ET.SubElement(offer_element, 'url').text = offer['url']
        ET.SubElement(offer_element, 'price').text = str(int(round(offer['price'])))
        ET.SubElement(offer_element, 'currencyId').text = offer['currencyId']
        ET.SubElement(offer_element, 'categoryId').text = str(offer['categoryId'])
        ET.SubElement(offer_element, 'picture').text = offer['picture']
        ET.SubElement(offer_element, 'name').text = offer['name']
        ET.SubElement(offer_element, 'description').text = offer['name']
    xml_string = ET.tostring(yml_catalog, 'utf-8')
    dom = minidom.parseString(xml_string)
    pretty_xml = dom.toprettyxml(indent="  ", encoding="UTF-8")
    with open(OUTPUT_YML_FILE, 'wb') as f:
        f.write(pretty_xml)
    print(f"YML фид успешно сохранен в файл '{OUTPUT_YML_FILE}'.")

if __name__ == "__main__":
    dataframe = download_and_extract_pricelist(PRICE_URL)
    if dataframe is not None:
        categories_data, offers_data, currencies_data = parse_pricelist(dataframe)
        if categories_data and offers_data:
            generate_yml_feed(categories_data, offers_data, currencies_data)
        else:
            print("Не удалось извлечь данные для создания фида.")