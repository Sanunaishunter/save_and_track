#!/usr/bin/env python3
"""
一次性探測:確認各資料來源在免費/無 token 條件下實際能不能用、回傳長什麼樣。

因為開發環境的 proxy 擋掉對外連線,這支程式的用途是在 GitHub Actions 上跑一次,
把真實回應印出來,避免用猜的反覆改。跑完就可以刪掉。
"""

import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def get(url, headers=None, timeout=45):
    h = {"User-Agent": UA, "Accept": "application/json,*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return None, "EXC: %r" % (e,)


def show(name, url, headers=None):
    print("\n" + "=" * 70)
    print("[%s]" % name)
    print("URL: %s" % url[:160])
    status, body = get(url, headers)
    print("HTTP: %s   長度: %d" % (status, len(body or "")))
    if not body:
        return
    try:
        data = json.loads(body)
    except ValueError:
        print("非 JSON,前 300 字:\n%s" % body[:300])
        return

    if isinstance(data, list):
        print("型態: list,筆數 = %d" % len(data))
        if data:
            print("第一筆 keys: %s" % list(data[0].keys()))
            print("第一筆: %s" % json.dumps(data[0], ensure_ascii=False)[:400])
    elif isinstance(data, dict):
        print("型態: dict,keys = %s" % list(data.keys())[:20])
        for key in ("stat", "status", "msg", "date", "title"):
            if key in data:
                print("  %s = %s" % (key, str(data[key])[:200]))
        for key in ("data", "data1", "tables", "fields", "fields1"):
            v = data.get(key)
            if isinstance(v, list) and v:
                print("  %s: 筆數 = %d,第一筆 = %s"
                      % (key, len(v), json.dumps(v[0], ensure_ascii=False)[:400]))
        tables = data.get("tables")
        if isinstance(tables, list):
            for i, t in enumerate(tables):
                if isinstance(t, dict):
                    rows = t.get("data") or []
                    print("  tables[%d] title=%s fields=%s 筆數=%d"
                          % (i, str(t.get("title"))[:60], t.get("fields"), len(rows)))
                    if rows:
                        print("     第一筆 = %s" % json.dumps(rows[0], ensure_ascii=False)[:300])


def recent_weekday(days_back):
    d = (dt.datetime.utcnow() + dt.timedelta(hours=8)).date()
    n = 0
    while n < days_back:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return d


def main():
    d = recent_weekday(1)
    ymd = d.strftime("%Y%m%d")
    print("探測基準日(近一個平日):%s" % d.isoformat())

    # 1. TWSE OpenAPI:最新交易日全市場(免 token、免額度)
    show("TWSE OpenAPI STOCK_DAY_ALL",
         "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")

    # 2. TWSE 指定日期的全市場(回補基線用)—— 新版 rwd 路徑
    show("TWSE MI_INDEX (rwd, type=ALL, date=%s)" % ymd,
         "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
         "?date=%s&type=ALL&response=json" % ymd)

    # 3. 同上,舊版路徑(有些環境只有這條可用)
    show("TWSE MI_INDEX (legacy, type=ALL, date=%s)" % ymd,
         "https://www.twse.com.tw/exchangeReport/MI_INDEX"
         "?response=json&date=%s&type=ALL" % ymd)

    # 4. FinMind 逐檔 + 日期區間:確認免費版能不能用(能的話可當備援)
    tok = (os.environ.get("FINMIND_TOKEN") or "").strip()
    hdr = {"Authorization": "Bearer " + tok} if tok else None
    print("\n(FinMind token %s)" % ("有設定" if tok else "未設定,走未註冊模式"))
    start = (d - dt.timedelta(days=40)).isoformat()
    show("FinMind TaiwanStockPrice data_id=2330 區間",
         "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice"
         "&data_id=2330&start_date=%s&end_date=%s" % (start, d.isoformat()), hdr)

    # 5. 再確認一次全市場查詢確實被擋(留紀錄)
    show("FinMind TaiwanStockPrice 全市場(預期被擋)",
         "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice"
         "&start_date=%s&end_date=%s" % (d.isoformat(), d.isoformat()), hdr)

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
