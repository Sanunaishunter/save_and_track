#!/usr/bin/env python3
"""
一次性 probe:TWSE 個股逐月成交資訊(STOCK_DAY),看能不能查到比
data/history(KEEP_DAYS=30)更早的價格,例如「個股查詢」清單裡某檔
股票更久以前的高點。

用完即刪,結論寫進 data/README.md。容器內連不到 www.twse.com.tw,
所以只能請 Hugo 在 Actions 上跑、我讀 log。

- 猜測端點(舊版個股日成交資訊,按股票代號 + 當月任一天查整月):
  https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=YYYYMMDD&stockNo=XXXX
  新版路徑(仿照 twse_api.py 裡 MI_INDEX/T86 的 /rwd/zh/ 對照組):
  https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=YYYYMMDD&stockNo=XXXX&response=json

以 2313(華通)測近 6 個月,順便找找有沒有出現過 280 這個價位。
"""

import json
import sys
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
TIMEOUT = 60

STOCK_NO = "2313"
# 每個月第一天(月初休市也沒關係,STOCK_DAY 是按月查整月,不是查那一天)
MONTHS = ["20260301", "20260401", "20260501", "20260601",
          "20260701", "20260801", "20260901"]

URL_TPLS = [
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=%s&stockNo=%s",
    "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=%s&stockNo=%s&response=json",
]


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


def probe_one(url):
    print("URL:", url)
    try:
        raw = fetch(url)
    except urllib.error.HTTPError as e:
        print("  HTTP 錯誤 %s:%s" % (e.code, e.read()[:300]))
        return None
    except Exception as e:                  # noqa: BLE001
        print("  失敗:%r" % (e,))
        return None

    print("  回應長度:%d bytes" % len(raw))
    try:
        data = json.loads(raw)
    except ValueError:
        print("  不是 JSON,前 300 字:", raw[:300])
        return None

    if not isinstance(data, dict):
        print("  頂層不是物件:", type(data))
        return None

    print("  頂層欄位:", list(data.keys()))
    stat = data.get("stat")
    print("  stat:", stat)
    fields = data.get("fields")
    rows = data.get("data")
    print("  fields:", fields)
    if rows:
        print("  共 %d 筆,第一筆:%r" % (len(rows), rows[0]))
        print("  最後一筆:%r" % (rows[-1],))
    else:
        print("  data 是空的或不存在")
    return data


def main():
    print("== 找哪一條路徑能用(用 2026-09 月測) ==")
    working_tpl = None
    for tpl in URL_TPLS:
        data = probe_one(tpl % ("20260901", STOCK_NO))
        if data and data.get("stat") == "OK" and data.get("data"):
            working_tpl = tpl
            print("  → 這條可用")
            break
        print("  → 這條不行,換下一條")

    if not working_tpl:
        print("\n兩條路徑都拿不到 2026-09 的資料,後面月份不測了。")
        return 1

    print("\n== 用可行路徑掃 2026-03 ~ 2026-09,找每月最高/最低收盤 ==")
    idx_cache = None
    for ymd in MONTHS:
        data = probe_one(working_tpl % (ymd, STOCK_NO))
        if not data or data.get("stat") != "OK":
            print("  (這個月休市/沒資料/失敗,跳過)")
            continue
        fields = data.get("fields") or []
        rows = data.get("data") or []
        if not rows:
            continue
        if idx_cache is None:
            idx_cache = {name: i for i, name in enumerate(fields)}
            print("  欄位索引:", idx_cache)
        try:
            ci = idx_cache.get("收盤價")
            hi = idx_cache.get("最高價")
            lo = idx_cache.get("最低價")
            di = idx_cache.get("日期")
            closes = [(r[di], r[ci], r[hi], r[lo]) for r in rows]
        except (KeyError, IndexError, TypeError) as e:
            print("  解析失敗:%r" % (e,))
            continue
        highest = max(closes, key=lambda t: float(str(t[2]).replace(",", "") or 0))
        print("  %s 這個月最高價那天:日期=%s 收=%s 高=%s 低=%s" %
              (ymd[:6], highest[0], highest[1], highest[2], highest[3]))

    print("\n完成。Claude Code 會直接讀這次 Actions run 的 log。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
