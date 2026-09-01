#!/usr/bin/env python3
"""
一次性探測(用完即刪):確認法人資料的實際內容。

1. FinMind 的法人類別字串到底長什麼樣(投信是 Investment_Trust 還是別的?)
2. TWSE 全市場法人買賣超端點的格式,用來算「佔全市場外資買超 P%」的分母

開發環境的 proxy 擋掉對外連線,只能在 Actions 上實跑。
"""

import datetime as dt
import json
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json,*/*"})
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


def recent_weekday(n):
    d = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date()
    c = 0
    while c < n:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5:
            c += 1
    return d


def main():
    d = recent_weekday(1)
    ymd = d.strftime("%Y%m%d")
    iso = d.isoformat()
    print("探測基準日:%s\n" % iso)

    # ---------- 1. FinMind:法人類別的實際字串 ----------
    print("=" * 70)
    print("[1] FinMind 法人類別字串(2330,近一個月)")
    start = (d - dt.timedelta(days=20)).isoformat()
    url = ("https://api.finmindtrade.com/api/v4/data?"
           "dataset=TaiwanStockInstitutionalInvestorsBuySell"
           "&data_id=2330&start_date=%s&end_date=%s" % (start, iso))
    status, body = get(url)
    print("HTTP: %s" % status)
    try:
        rows = json.loads(body).get("data") or []
    except ValueError:
        rows = []
        print(body[:300])
    if rows:
        names = {}
        for r in rows:
            names.setdefault(r.get("name"), 0)
            names[r.get("name")] += 1
        print("共 %d 筆,出現的 name 值:" % len(rows))
        for k, v in sorted(names.items(), key=lambda x: -x[1]):
            print("   %-28s 出現 %d 次" % (repr(k), v))
        last = max(r["date"] for r in rows)
        print("最後一天(%s)的每一筆:" % last)
        for r in rows:
            if r["date"] == last:
                print("   %s" % json.dumps(r, ensure_ascii=False))

    # ---------- 2. TWSE T86:全市場個股法人買賣超 ----------
    print("\n" + "=" * 70)
    print("[2] TWSE T86 全市場個股法人買賣超(算分母用)")
    for tpl in [
        "https://www.twse.com.tw/rwd/zh/fund/T86?date=%s&selectType=ALL&response=json",
        "https://www.twse.com.tw/fund/T86?response=json&date=%s&selectType=ALL",
    ]:
        u = tpl % ymd
        print("\nURL: %s" % u[:110])
        status, body = get(u)
        print("HTTP: %s  長度: %d" % (status, len(body or "")))
        try:
            p = json.loads(body)
        except ValueError:
            print("非 JSON:%s" % (body or "")[:200])
            continue
        print("keys=%s stat=%s date=%s" % (list(p.keys())[:10], p.get("stat"), p.get("date")))
        fields = p.get("fields") or []
        data = p.get("data") or []
        print("fields=%s" % fields)
        print("筆數=%d" % len(data))
        if data:
            print("第一筆=%s" % json.dumps(data[0], ensure_ascii=False)[:400])
        break

    # ---------- 3. TWSE BFI82U:三大法人買賣金額合計 ----------
    print("\n" + "=" * 70)
    print("[3] TWSE BFI82U 三大法人買賣金額統計(另一種分母)")
    u = ("https://www.twse.com.tw/rwd/zh/fund/BFI82U?"
         "dayDate=%s&type=day&response=json" % ymd)
    print("URL: %s" % u[:110])
    status, body = get(u)
    print("HTTP: %s  長度: %d" % (status, len(body or "")))
    try:
        p = json.loads(body)
        print("keys=%s stat=%s" % (list(p.keys())[:10], p.get("stat")))
        print("fields=%s" % (p.get("fields") or []))
        for row in (p.get("data") or []):
            print("   %s" % json.dumps(row, ensure_ascii=False))
    except ValueError:
        print("非 JSON:%s" % (body or "")[:300])

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
