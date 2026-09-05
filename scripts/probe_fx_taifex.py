#!/usr/bin/env python3
"""
一次性 probe:匯率(央行開放資料)+ 期貨三大法人未平倉(期交所 OpenAPI)。

用完即刪,結論寫進 data/README.md。容器內連不到這兩個網域,所以只能請
Hugo 在 Actions 上跑、我讀 log。

- 央行:https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Day
  (新台幣/美元銀行間收盤匯率,官方政府開放資料,免 token)
- 期交所 OpenAPI:https://openapi.taifex.com.tw/v1/...
  猜測端點名稱是 MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate
  (三大法人-區分各期貨契約),但沒有一手資料源可以確認,所以同時把
  swagger.json 的完整端點清單印出來,萬一猜錯名字,從清單裡挑對的。
"""

import json
import sys
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
TIMEOUT = 60

FX_URL = "https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Day"
TAIFEX_SWAGGER = "https://openapi.taifex.com.tw/swagger.json"
TAIFEX_GUESS = ("https://openapi.taifex.com.tw/v1/"
                "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate")


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read().decode("utf-8", "replace")
    return raw


def show(label, url):
    print("\n== %s ==\n%s" % (label, url))
    try:
        raw = fetch(url)
    except urllib.error.HTTPError as e:
        print("HTTP 錯誤 %s:%s" % (e.code, e.read()[:500]))
        return None
    except Exception as e:                  # noqa: BLE001
        print("失敗:%r" % (e,))
        return None

    print("回應長度:%d bytes" % len(raw))
    try:
        data = json.loads(raw)
    except ValueError:
        print("不是 JSON,前 500 字:")
        print(raw[:500])
        return None

    if isinstance(data, list):
        print("陣列,共 %d 筆" % len(data))
        if data:
            print("第一筆欄位:", list(data[0].keys()) if isinstance(data[0], dict) else data[0])
            print("前兩筆內容:")
            for row in data[:2]:
                print(" ", row)
    elif isinstance(data, dict):
        print("物件,頂層欄位:", list(data.keys()))
        print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])
    return data


def main():
    show("央行 新台幣/美元銀行間收盤匯率(FTDOpenData_Day)", FX_URL)

    swagger = show("期交所 OpenAPI swagger.json", TAIFEX_SWAGGER)
    if isinstance(swagger, dict) and "paths" in swagger:
        print("\n== swagger.json 裡的端點清單(找關鍵字:三大法人/未平倉/期貨) ==")
        for path, info in swagger["paths"].items():
            summary = ""
            if isinstance(info, dict):
                get_info = info.get("get") or {}
                summary = get_info.get("summary") or get_info.get("description") or ""
            print(" ", path, "-", summary)

    show("期交所三大法人期貨未平倉(猜測端點,可能 404)", TAIFEX_GUESS)

    print("\n完成。Claude Code 會直接讀這次 Actions run 的 log。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
