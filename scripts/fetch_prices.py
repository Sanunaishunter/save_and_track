#!/usr/bin/env python3
"""
抓取上市全市場每日 OHLCV,存成 data/history/YYYY-MM-DD.json。

用法:
  python scripts/fetch_prices.py                    # 每日增量:抓最新交易日
  python scripts/fetch_prices.py --backfill-days 25 # 回補基線(第一次用)

資料來源全部是 TWSE,免 token、免額度:
  - 增量用 OpenAPI STOCK_DAY_ALL(最新交易日)
  - 回補用 MI_INDEX?date=(可指定過去日期)
"""

import argparse
import datetime as dt
import os
import sys
import time

import common
import twse_api


def taipei_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date()


def keep_listed(rows):
    """只留上市普通股(四位數、開頭非 0),排除 ETF、權證、特別股。"""
    return [r for r in rows if common.is_listed_common(r["code"], None)]


def save_day(date_iso, rows, source):
    out = [[r["code"], r["volume"], r["open"], r["high"], r["low"], r["close"]]
           for r in rows]
    out.sort(key=lambda x: x[0])
    common.write_json(common.history_path(date_iso), {
        "date": date_iso,
        "source": source,
        "market": "twse-listed-common",
        "columns": common.COLUMNS,
        "count": len(out),
        "rows": out,
    }, compact=True)
    return len(out)


def merge_names(rows, names):
    for r in rows:
        if r["name"]:
            names[r["code"]] = r["name"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=0,
                    help="往回補幾個交易日(0 = 只抓最新交易日)")
    ap.add_argument("--max-lookback", type=int, default=60,
                    help="往回掃描的日曆天上限,避免連假無限往回找")
    args = ap.parse_args()

    names = common.read_json(common.NAMES_FILE, {}) or {}
    have = set(common.history_dates())
    started = time.time()
    calls = 0
    fetched = 0

    # --- 最新交易日:用 OpenAPI,一次呼叫拿整個市場 ---
    print("== 抓取最新交易日(STOCK_DAY_ALL)==")
    calls += 1
    date_iso, rows = twse_api.latest_all()
    rows = keep_listed(rows)
    merge_names(rows, names)
    if date_iso in have:
        print("  %s 已存在,跳過(全市場 %d 檔)" % (date_iso, len(rows)))
    else:
        n = save_day(date_iso, rows, "twse:STOCK_DAY_ALL")
        have.add(date_iso)
        fetched += 1
        print("  %s 取得 %d 檔上市普通股" % (date_iso, n))

    # --- 回補:用 MI_INDEX 逐日往回抓 ---
    want = args.backfill_days
    if want > 0:
        print("== 回補基線(目標 %d 個交易日,已有 %d 天)==" % (want, len(have)))
        got = len(have)
        d = dt.date.fromisoformat(date_iso)
        for back in range(1, args.max_lookback + 1):
            if got >= want:
                break
            day = d - dt.timedelta(days=back)
            if day.weekday() >= 5:
                continue
            ds = day.isoformat()
            if ds in have:
                print("  %s 已存在,跳過" % ds)
                continue

            calls += 1
            actual, mrows = twse_api.by_date(day.strftime("%Y%m%d"))
            if not actual or not mrows:
                print("  %s 無資料(休市)" % ds)
                time.sleep(3)
                continue

            mrows = keep_listed(mrows)
            merge_names(mrows, names)
            n = save_day(actual, mrows, "twse:MI_INDEX")
            have.add(actual)
            got += 1
            fetched += 1
            print("  %s 取得 %d 檔" % (actual, n))
            time.sleep(3)          # MI_INDEX 回應約 4MB,對 TWSE 客氣一點

    common.write_json(common.NAMES_FILE, names)

    # --- 只保留 MA20 需要的滾動視窗 ---
    all_dates = common.history_dates()
    for ds in all_dates[:-common.KEEP_DAYS]:
        os.remove(common.history_path(ds))
        print("  清掉超出視窗的 %s" % ds)

    elapsed = time.time() - started
    print("== 完成:新增 %d 天、共 %d 個交易日、%d 次 API 呼叫、耗時 %.1f 秒 =="
          % (fetched, len(common.history_dates()), calls, elapsed))
    print("   股票名稱對照:%d 檔" % len(names))

    if not common.history_dates():
        print("錯誤:一天資料都沒有", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
