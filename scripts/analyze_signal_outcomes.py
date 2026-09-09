#!/usr/bin/env python3
"""
訊號準度統計(2026-09-09 加入)。使用者要的是「全部訊號」的準度/幅度
統計,不是只看今天這一天——這支直接吃四份個股查詢資料裡完整的 30 天
序列,把 🔽量縮/🔔量縮轉買/🔻外資出貨/🔥連續增溫/🕐蓄勢 五種訊號在
歷史上每一次觸發都抓出來,算觸發後 1/3/5 個交易日的漲跌幅、最高漲幅、
最大跌幅——不是只等 9/9 一天的樣本,用既有 30 天資料就能先跑一輪。

判斷邏輯直接 import scripts/probe_signal_batch.py(跟 js/app.js 同步的
那份),不重複實作。四份清單之間有重疊代號(同一檔股票被抽進兩份不同
清單)時,用 rows 是否逐日相同判斷是不是真的同一份資料,是的話只算一次
避免重複計數。

用法:python scripts/analyze_signal_outcomes.py
不打 API、不寫回任何 data/ 檔案,純粹讀取既有 JSON、印出統計到 stdout。
"""

import json
import os
import statistics
import sys

import common
import probe_signal_batch as p

SOURCES = [
    ("FOMO個股查詢", "stock-lookup-latest.json"),
    ("爆量個股查詢", "stock-lookup-scan-latest.json"),
    ("暴跌FOMO個股查詢", "stock-lookup-crashfomo-latest.json"),
    ("9/8全掃", "stock-lookup-fullscan-latest.json"),
]

FORWARD_HORIZONS = (1, 3, 5)
ZONE_CONVERT_WINDOW = 5   # 蹲好之後幾天內出現轉買才算「有等到」


def load_unique_stocks():
    """回傳 {stock_id: {"name":..., "rows":[...], "panels":[...]}},跨清單
    同一檔代號可能出現在不只一份清單裡;不同清單的更新頻率不一樣
    (三份手動清單每天排程更新,9/8全掃是一次性快照,不會跟著變新),
    所以重複時不是「先看到誰就用誰」,是留 rows 最後一天日期最新的那份
    (日期打平、rows 長度當第二排序依據),記下出現過的分頁名稱方便追查。
    """
    stocks = {}
    for panel, fname in SOURCES:
        path = os.path.join(common.DATA_DIR, fname)
        d = common.read_json(path)
        if not d:
            print("  (略過 %s:讀不到 %s)" % (panel, fname), file=sys.stderr)
            continue
        for code, rec in (d.get("data") or {}).items():
            rows = rec.get("rows") or []
            if not rows:
                continue
            if code not in stocks:
                stocks[code] = {"name": rec.get("stock_name"), "rows": rows, "panels": [panel]}
            else:
                existing = stocks[code]
                existing["panels"].append(panel)
                existing_last = existing["rows"][-1].get("date") or ""
                new_last = rows[-1].get("date") or ""
                if (new_last, len(rows)) > (existing_last, len(existing["rows"])):
                    existing["rows"] = rows
    return stocks


def forward_stats(rows, i):
    """觸發日 index i 之後 1/3/5 個交易日的報酬、以及未來最多 5 天的
    最高/最低價相對觸發日收盤的漲跌幅。資料不夠的天數回傳 None,呼叫端
    自己看有沒有值再統計,不是每個訊號都湊得滿 5 天。"""
    base_close = rows[i].get("close")
    out = {"fwd": {}, "max_gain_pct": None, "max_loss_pct": None}
    if not base_close:
        return out

    for h in FORWARD_HORIZONS:
        j = i + h
        if j < len(rows) and rows[j].get("close") is not None:
            out["fwd"][h] = (rows[j]["close"] - base_close) / base_close * 100.0
        else:
            out["fwd"][h] = None

    highs, lows = [], []
    for k in range(i + 1, min(i + 1 + ZONE_CONVERT_WINDOW, len(rows))):
        if rows[k].get("high") is not None:
            highs.append(rows[k]["high"])
        if rows[k].get("low") is not None:
            lows.append(rows[k]["low"])
    if highs:
        out["max_gain_pct"] = (max(highs) - base_close) / base_close * 100.0
    if lows:
        out["max_loss_pct"] = (min(lows) - base_close) / base_close * 100.0
    return out


def collect_signal_instances(stocks):
    """回傳 {signal_name: [ {code, name, date, ...forward_stats, extra} ]}。"""
    buckets = {"SHRINK": [], "BREAKOUT": [], "SELLOFF": [], "WARMING": [], "ZONE": []}
    date_to_index = {}

    for code, info in stocks.items():
        rows = info["rows"]
        idx = {r["date"]: n for n, r in enumerate(rows)}
        date_to_index[code] = idx

        breakout = p.breakout_days(rows)
        shrink = p.shrink_days(rows)
        selloff = p.selloff_days(rows)
        warming = p.warming_days(rows)
        zone = p.zone_days(rows)

        for date, v in shrink.items():
            i = idx[date]
            fs = forward_stats(rows, i)
            buckets["SHRINK"].append(dict(code=code, name=info["name"], date=date, **fs))

        for date, v in breakout.items():
            i = idx[date]
            fs = forward_stats(rows, i)
            buckets["BREAKOUT"].append(dict(code=code, name=info["name"], date=date, **fs))

        for date, v in selloff.items():
            i = idx[date]
            fs = forward_stats(rows, i)
            buckets["SELLOFF"].append(dict(code=code, name=info["name"], date=date, **fs))

        for date, v in warming.items():
            i = idx[date]
            fs = forward_stats(rows, i)
            buckets["WARMING"].append(dict(code=code, name=info["name"], date=date, **fs))

        for date, v in zone.items():
            i = idx[date]
            fs = forward_stats(rows, i)
            # 蹲好之後 ZONE_CONVERT_WINDOW 天內,同一檔有沒有真的等到🔔轉買
            converted, convert_days = False, None
            for h in range(1, ZONE_CONVERT_WINDOW + 1):
                future_date = rows[i + h]["date"] if i + h < len(rows) else None
                if future_date and future_date in breakout:
                    converted, convert_days = True, h
                    break
            buckets["ZONE"].append(dict(
                code=code, name=info["name"], date=date, converted=converted,
                convert_days=convert_days, **fs))

    return buckets


def summarize(label, instances, bullish=True):
    n = len(instances)
    print("\n== %s(n=%d)==" % (label, n))
    if not n:
        print("  沒有樣本")
        return

    for h in FORWARD_HORIZONS:
        vals = [x["fwd"][h] for x in instances if x["fwd"].get(h) is not None]
        if not vals:
            print("  T+%d:樣本不足(還沒有足夠的未來交易日)" % h)
            continue
        wins = [v for v in vals if (v > 0) == bullish]
        hit_rate = len(wins) / len(vals) * 100.0
        avg = statistics.mean(vals)
        med = statistics.median(vals)
        print("  T+%d(n=%d):準度 %.1f%%(%s)、平均 %+.2f%%、中位數 %+.2f%%、"
              "最高 %+.2f%%、最低 %+.2f%%"
              % (h, len(vals), hit_rate, "漲" if bullish else "跌",
                 avg, med, max(vals), min(vals)))

    gains = [x["max_gain_pct"] for x in instances if x["max_gain_pct"] is not None]
    losses = [x["max_loss_pct"] for x in instances if x["max_loss_pct"] is not None]
    if gains:
        print("  未來 %d 天內最高點:平均 %+.2f%%、最大 %+.2f%%"
              % (ZONE_CONVERT_WINDOW, statistics.mean(gains), max(gains)))
    if losses:
        print("  未來 %d 天內最低點:平均 %+.2f%%、最深 %+.2f%%"
              % (ZONE_CONVERT_WINDOW, statistics.mean(losses), min(losses)))

    top = sorted(instances, key=lambda x: x["fwd"].get(1) if x["fwd"].get(1) is not None else -999,
                 reverse=bullish)[:5]
    print("  T+1 表現前 5(%s):" % ("最會漲" if bullish else "最會跌"))
    for x in top:
        f1 = x["fwd"].get(1)
        print("    %s %-8s %s  T+1=%s" % (
            x["code"], x["name"] or "", x["date"],
            ("%+.2f%%" % f1) if f1 is not None else "無資料"))


def summarize_zone(instances):
    n = len(instances)
    print("\n== ZONE 蓄勢區(n=%d)==" % n)
    if not n:
        print("  沒有樣本")
        return
    converted = [x for x in instances if x["converted"]]
    rate = len(converted) / n * 100.0
    print("  %d 天內轉成🔔轉買的比例:%.1f%%(%d/%d)" % (ZONE_CONVERT_WINDOW, rate, len(converted), n))
    if converted:
        days = [x["convert_days"] for x in converted]
        print("  轉買平均等了 %.1f 天(最快 %d 天、最慢 %d 天)"
              % (statistics.mean(days), min(days), max(days)))
    summarize("ZONE 訊號本身的價格走勢(不管有沒有真的轉買)", instances, bullish=True)


def main():
    print("== 訊號準度統計(用既有 30 天序列回測,不用等新資料)==")
    stocks = load_unique_stocks()
    print("去重後共 %d 檔股票(來自四份個股查詢清單)" % len(stocks))

    buckets = collect_signal_instances(stocks)

    summarize("🔽量縮(單日)", buckets["SHRINK"], bullish=True)
    summarize("🔔量縮轉買", buckets["BREAKOUT"], bullish=True)
    summarize("🔥連續增溫", buckets["WARMING"], bullish=True)
    summarize("🔻外資出貨(bullish=False 代表\"準度\"看的是有沒有繼續跌=真跌)",
              buckets["SELLOFF"], bullish=False)
    summarize_zone(buckets["ZONE"])

    print("\n⚠️ 樣本數還很小、時間窗只有 30 天,這是方向性參考不是嚴謹回測。"
          "T+3/T+5 的樣本會比 T+1 少很多——越晚觸發的訊號,能看的未來天數越少。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
