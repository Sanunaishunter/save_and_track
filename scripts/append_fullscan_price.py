#!/usr/bin/env python3
"""
幫 9/8全掃(data/stock-lookup-fullscan-latest.json)補上後續交易日的
開高低收量,不用重打 FinMind——這份快照本來就是一次性的(不在
daily-scan.yml 排程裡),但開高低收量在 data/history 免費、每天都有,
用來讓使用者在同一張表格裡直接看到「訊號觸發那天之後,價格實際走了
多少」,不用另外跑腳本比對。

只補開高低收量,融資融券/外資投信留 null(那組只有 FinMind 有,
要有就得再手動觸發一次 scan-full-candidates.yml,不是這支的目的)——
表格既有的「—」顯示已經處理 null,不用改前端。

用法:python scripts/append_fullscan_price.py
只在本機跑,不打任何 API,純粹合併 data/history 既有資料。
"""

import os
import sys

import common
from compute_scan import load_day

FULLSCAN_LATEST = os.path.join(common.DATA_DIR, "stock-lookup-fullscan-latest.json")


def main():
    d = common.read_json(FULLSCAN_LATEST)
    if not d:
        print("錯誤:讀不到 %s,先跑過 scan-full-candidates.yml 產生初始快照"
              % FULLSCAN_LATEST, file=sys.stderr)
        return 1

    history_dates = common.history_dates()
    existing_to = d.get("history_range", {}).get("to")
    new_dates = [dt for dt in history_dates if not existing_to or dt > existing_to]
    if not new_dates:
        print("沒有比 %s 更新的交易日,不需要補" % existing_to)
        return 0

    print("補上交易日:%s" % "、".join(new_dates))
    day_cache = {dt: load_day(dt) for dt in new_dates}

    appended = 0
    missing = []
    for code, rec in d.get("data", {}).items():
        rows = rec.get("rows") or []
        existing_dates = set(r["date"] for r in rows)
        for dt in new_dates:
            if dt in existing_dates:
                continue
            cur = day_cache[dt].get(code)
            if not cur:
                missing.append((code, dt))
                continue
            rows.append({
                "date": dt,
                "open": cur.get("open"), "high": cur.get("high"),
                "low": cur.get("low"), "close": cur.get("close"),
                "volume": cur.get("volume"),
                "margin_balance": None, "margin_change": None,
                "short_balance": None, "short_change": None,
                "foreign_net": None, "trust_net": None,
            })
            appended += 1
        rec["rows"] = sorted(rows, key=lambda r: r["date"])

    d["history_range"]["to"] = max(history_dates[-1], existing_to or "")
    common.write_json(FULLSCAN_LATEST, d)

    print("補了 %d 筆(開高低收量,融資融券/外資投信留空)" % appended)
    if missing:
        print("%d 筆代號在新交易日的 data/history 裡查無資料(可能停牌):%s"
              % (len(missing), missing[:10]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
