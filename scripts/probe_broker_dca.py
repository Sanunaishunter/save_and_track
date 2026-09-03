#!/usr/bin/env python3
"""
一次性探測(用完即刪):券商基本資料 + 定期定額統計,兩個新分頁要用的資料源。

candidates:
  - 券商基本資料:opendata/t187ap18(標題完全對上)vs brokerService/brokerList
    (證券商總公司基本資料,名字很像但可能是不同資料集,兩個都探)
  - 定期定額統計:ETFReport/ETFRank(月報表);brokerService/secRegData
    是相關但不同的東西(開辦業務的券商名單,不是統計數字),順便探測對照
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


def main():
    # ---------- 券商基本資料:兩個候選都探 ----------
    show("TWSE opendata/t187ap18 證券商基本資料",
         "https://openapi.twse.com.tw/v1/opendata/t187ap18")
    show("TWSE brokerService/brokerList 證券商總公司基本資料",
         "https://openapi.twse.com.tw/v1/brokerService/brokerList")

    # ---------- 定期定額統計 ----------
    show("TWSE ETFReport/ETFRank 定期定額交易戶數統計排行月報表",
         "https://openapi.twse.com.tw/v1/ETFReport/ETFRank")
    show("TWSE brokerService/secRegData 開辦定期定額業務證券商名單(對照用,非統計)",
         "https://openapi.twse.com.tw/v1/brokerService/secRegData")

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
