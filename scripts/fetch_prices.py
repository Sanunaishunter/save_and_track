#!/usr/bin/env python3
"""
抓取上市全市場每日 OHLCV,存成 data/history/YYYY-MM-DD.json(append-only)。

用法:
  python scripts/fetch_prices.py                    # 抓最新交易日(每日排程用)
  python scripts/fetch_prices.py --backfill-days 25 # 回補基線(第一次用)

FinMind 的 TaiwanStockPrice 不帶 data_id 時會回傳「該日全市場」,
所以回補 25 個交易日約 25~35 次呼叫,不是逐檔 1700+ 次。
"""

import argparse
import datetime as dt
import sys
import time

import common
import finmind_api


def taipei_today():
    # runner 是 UTC,台北 = UTC+8
    return (dt.datetime.utcnow() + dt.timedelta(hours=8)).date()


def refresh_names():
    """更新代碼→名稱對照,順便記錄市場別以便篩掉上櫃。"""
    rows = finmind_api.stock_info()
    names = {}
    for r in rows:
        sid = str(r.get("stock_id") or "")
        if not common.is_listed_common(sid, r.get("type")):
            continue
        nm = (r.get("stock_name") or "").strip()
        if nm:
            names[sid] = nm
    if not names:
        raise finmind_api.FinMindError("TaiwanStockInfo 沒有回傳任何上市普通股")
    common.write_json(common.NAMES_FILE, names)
    print("  股票名稱對照:%d 檔上市普通股" % len(names))
    return names


def fetch_day(date_str, names):
    """
    抓單一日期。回傳 (實際日期, 筆數);當天沒有資料(休市)回傳 (None, 0)。
    """
    rows = finmind_api.daily_prices(date_str)
    if not rows:
        return None, 0

    # FinMind 只會回傳該日的資料,但仍以回傳的 date 為準,不用我們請求的日期,
    # 避免休市日拿到別天的資料卻標成今天。
    out = []
    actual = None
    for r in rows:
        sid = str(r.get("stock_id") or "")
        if sid not in names:            # 只留上市普通股
            continue
        rdate = r.get("date")
        if rdate != date_str:
            continue
        actual = rdate
        try:
            out.append([
                sid,
                int(r.get("Trading_Volume") or 0),
                float(r.get("open") or 0),
                float(r.get("max") or 0),
                float(r.get("min") or 0),
                float(r.get("close") or 0),
            ])
        except (TypeError, ValueError):
            continue

    if not out:
        return None, 0

    out.sort(key=lambda x: x[0])
    common.write_json(common.history_path(actual), {
        "date": actual,
        "source": "finmind:TaiwanStockPrice",
        "market": "twse-listed-common",
        "columns": common.COLUMNS,
        "count": len(out),
        "rows": out,
    }, compact=True)
    return actual, len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=0,
                    help="往回補幾個交易日(0 = 只抓最新交易日)")
    ap.add_argument("--max-lookback", type=int, default=60,
                    help="往回掃描的日曆天上限,避免連假無限往回找")
    args = ap.parse_args()

    print("== 更新股票名稱對照 ==")
    names = refresh_names()

    want = max(1, args.backfill_days)
    have = set(common.history_dates())
    today = taipei_today()

    print("== 抓取價格(目標 %d 個交易日,已有 %d 天)==" % (want, len(have)))
    got = 0
    calls = 1                       # 已經用掉一次 TaiwanStockInfo
    started = time.time()

    for back in range(args.max_lookback):
        if got >= want:
            break
        d = today - dt.timedelta(days=back)
        if d.weekday() >= 5:        # 週末直接跳過,省呼叫
            continue
        ds = d.isoformat()
        if ds in have:
            got += 1
            print("  %s 已存在,跳過" % ds)
            continue

        calls += 1
        actual, n = fetch_day(ds, names)
        if actual:
            got += 1
            print("  %s 取得 %d 檔" % (actual, n))
        else:
            print("  %s 無資料(休市或尚未結算)" % ds)
        time.sleep(0.6)             # 對 API 客氣一點

    elapsed = time.time() - started
    print("== 完成:%d 個交易日、%d 次 API 呼叫、耗時 %.1f 秒 ==" % (got, calls, elapsed))

    if got == 0:
        print("錯誤:一天資料都沒抓到", file=sys.stderr)
        return 1

    # 只保留 MA20 需要的滾動視窗,避免 repo 無限長大
    all_dates = common.history_dates()
    if len(all_dates) > common.KEEP_DAYS:
        import os
        for ds in all_dates[:-common.KEEP_DAYS]:
            os.remove(common.history_path(ds))
            print("  清掉超出視窗的 %s" % ds)

    return 0


if __name__ == "__main__":
    sys.exit(main())
