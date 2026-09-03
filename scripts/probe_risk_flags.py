#!/usr/bin/env python3
"""
一次性探測(用完即刪):新分頁「籌碼/風險」要用的六個 TWSE 端點。

全部要做成同一個新分頁,獨立於既有的爆量掃描/FOMO(不動它們的邏輯),
所以先把六個端點的真實回應一次探完,才知道能不能對齊、要怎麼存。

  1. exchangeReport/TWT84U   上市個股股價升降幅度(漲跌停旗標)
  2. announcement/notice     集中市場當日公布注意股票
  3. exchangeReport/MI_MARGN 集中市場融資融券餘額
  4. exchangeReport/BFI84U   集中市場停資停券預告表
  5. exchangeReport/TWT48U_ALL 上市股票除權除息預告表
  6. exchangeReport/FMTQIK   集中市場每日市場成交資訊(大盤)
"""

import json
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def get(url, timeout=60):
    h = {"User-Agent": UA, "Accept": "application/json,*/*"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return None, "EXC: %r" % (e,)


def show(name, url, limit=3):
    print("\n" + "=" * 70)
    print("[%s]" % name)
    print("URL: %s" % url)
    status, body = get(url)
    print("HTTP: %s  長度: %d" % (status, len(body or "")))
    if not body:
        return
    try:
        data = json.loads(body)
    except ValueError:
        print("非 JSON,前 300 字:\n%s" % body[:300])
        return
    rows = data if isinstance(data, list) else (data.get("data") if isinstance(data, dict) else None)
    if not isinstance(rows, list):
        print("型態: %s" % type(data).__name__)
        if isinstance(data, dict):
            print("keys = %s" % list(data.keys())[:20])
            for k in ("stat", "status", "msg", "date", "title"):
                if k in data:
                    print("  %s = %s" % (k, str(data[k])[:200]))
        return
    print("筆數 = %d" % len(rows))
    if rows:
        print("欄位 = %s" % (sorted(rows[0].keys()) if isinstance(rows[0], dict) else type(rows[0]).__name__))
        for r in rows[:limit]:
            print("範例 = %s" % json.dumps(r, ensure_ascii=False)[:500])
        # 找看看有沒有代碼欄位是 3518(柏騰,今天聊漲停的那檔),順便驗證漲跌停判斷用得上
        for r in rows:
            if isinstance(r, dict) and any(str(v).strip() == "3518" for v in r.values()):
                print("命中 3518:%s" % json.dumps(r, ensure_ascii=False)[:500])
                break


def main():
    show("exchangeReport/TWT84U 上市個股股價升降幅度",
         "https://openapi.twse.com.tw/v1/exchangeReport/TWT84U", limit=5)
    show("announcement/notice 集中市場當日公布注意股票",
         "https://openapi.twse.com.tw/v1/announcement/notice", limit=5)
    show("exchangeReport/MI_MARGN 集中市場融資融券餘額",
         "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN", limit=3)
    show("exchangeReport/BFI84U 集中市場停資停券預告表",
         "https://openapi.twse.com.tw/v1/exchangeReport/BFI84U", limit=5)
    show("exchangeReport/TWT48U_ALL 上市股票除權除息預告表",
         "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL", limit=5)
    show("exchangeReport/FMTQIK 集中市場每日市場成交資訊",
         "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK", limit=3)

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
