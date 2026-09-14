#!/usr/bin/env python3
"""
永久存檔(2026-09-14 加入):把全市場 OHLCV 跟大盤指數逐日「不裁掉」地存起來。

背景:data/history 只留 KEEP_DAYS(30)天,是給 MA20 用的滾動視窗,超出就刪。
訊號記分板/回測需要的是「從有資料那天起全部留著」,所以另存一份:

  data/archive/prices/YYYY-MM.json   按月分檔,壓縮 JSON,欄位同 common.COLUMNS
  data/archive/index.json            大盤指數/成交金額/漲跌家數逐日(一個檔案)

每天排程跑一次:把 data/history 裡還沒收進存檔的日子收進去、把
data/market-grid-latest.json 的 history 併進指數檔。冪等,重跑不會重複。

回補:
  python scripts/archive_prices.py --backfill-days 250
  從存檔最舊那天往前用 MI_INDEX(日期可定址、免額度)逐日補,每次呼叫間隔 3 秒,
  250 個交易日約 15 分鐘。回補寫的是存檔,不碰 data/history(那邊的 KEEP_DAYS
  裁切邏輯完全不變)。

資料來源都是 TWSE 既有在用的兩支(by_date / market_index_by_date),沒有新 API,
所以不用另外 probe。
"""

import argparse
import datetime as dt
import sys
import time

import common
import twse_api


def _load_month(ym):
    blob = common.read_json(common.archive_month_path(ym)) or {}
    if not blob:
        blob = {"month": ym, "columns": list(common.COLUMNS), "days": {}}
    blob.setdefault("columns", list(common.COLUMNS))
    blob.setdefault("days", {})
    return blob


def _save_month(ym, blob):
    blob["month"] = ym
    blob["day_count"] = len(blob["days"])
    common.write_json(common.archive_month_path(ym), blob, compact=True)


def archived_dates():
    out = set()
    for ym in common.archive_months():
        blob = common.read_json(common.archive_month_path(ym)) or {}
        out.update((blob.get("days") or {}).keys())
    return out


def put_day(date_iso, rows_as_lists, months_cache):
    """rows_as_lists 已是 COLUMNS 順序的陣列。回傳是否真的新增。"""
    ym = date_iso[:7]
    blob = months_cache.get(ym)
    if blob is None:
        blob = _load_month(ym)
        months_cache[ym] = blob
    if date_iso in blob["days"]:
        return False
    blob["days"][date_iso] = rows_as_lists
    return True


def rows_from_history_blob(blob):
    cols = blob.get("columns") or common.COLUMNS
    idx = {name: i for i, name in enumerate(cols)}
    out = []
    for row in blob.get("rows") or []:
        try:
            if not common.is_listed_common(row[idx["id"]], None):
                continue
            out.append([row[idx[c]] if c in idx and len(row) > idx[c] else None
                        for c in common.COLUMNS])
        except (IndexError, KeyError, TypeError):
            continue
    out.sort(key=lambda x: str(x[0]))
    return out


def rows_from_twse(mrows):
    out = []
    for r in mrows:
        if not common.is_listed_common(r["code"], None):
            continue
        out.append([r["code"], r["volume"], r["open"], r["high"], r["low"], r["close"],
                    r.get("transaction")])
    out.sort(key=lambda x: str(x[0]))
    return out


# ---------------------------------------------------------------- 大盤指數

INDEX_FIELDS = ("idx_close", "idx_change", "idx_change_pct", "turnover_amount",
                "advancing_count", "declining_count", "unchanged_count",
                "price_state", "volume_state", "grid_label", "breadth_ratio", "is_lajiban",
                "institutional_net")


def load_index_archive():
    blob = common.read_json(common.ARCHIVE_INDEX_FILE) or {}
    blob.setdefault("days", {})
    return blob


def merge_index_from_market_grid(index_blob):
    """把 market-grid-latest.json 的 history(30 天)併進來;同一天以九宮格檔為準
    (它有 grid_label 這些衍生欄位,存檔裡從 MI_INDEX 回補的日子沒有)。"""
    mg = common.read_json(common.MARKET_GRID_FILE) or {}
    added = 0
    for e in (mg.get("history") or []):
        ds = e.get("date")
        if not ds or e.get("idx_close") is None:
            continue
        entry = {k: e.get(k) for k in INDEX_FIELDS}
        old = index_blob["days"].get(ds)
        if old != entry:
            if old is None:
                added += 1
            merged = dict(old or {})
            merged.update({k: v for k, v in entry.items() if v is not None or k not in merged})
            index_blob["days"][ds] = merged
    return added


def backfill_index(index_blob, want_days, max_lookback, sleep_s):
    have = set(index_blob["days"].keys())
    if not have:
        return 0
    oldest = min(have)
    d = dt.date.fromisoformat(oldest)
    got = 0
    calls = 0
    for back in range(1, max_lookback + 1):
        if got >= want_days:
            break
        day = d - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        ds = day.isoformat()
        if ds in have:
            continue
        calls += 1
        try:
            snap = twse_api.market_index_by_date(day.strftime("%Y%m%d"))
        except twse_api.TWSEError as e:
            print("  指數 %s 失敗:%r" % (ds, e))
            time.sleep(sleep_s)
            continue
        if not snap:
            print("  指數 %s 無資料(休市)" % ds)
            time.sleep(sleep_s)
            continue
        index_blob["days"][ds] = {
            "idx_close": snap.get("idx_close"), "idx_change": snap.get("idx_change"),
            "idx_change_pct": snap.get("idx_change_pct"),
            "turnover_amount": snap.get("turnover_amount"),
            "advancing_count": snap.get("advancing"), "declining_count": snap.get("declining"),
            "unchanged_count": snap.get("unchanged"),
        }
        got += 1
        print("  指數 %s 補上(收 %s)" % (ds, snap.get("idx_close")))
        time.sleep(sleep_s)
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=0,
                    help="從存檔最舊那天往前再補幾個交易日(0 = 只收今天的)")
    ap.add_argument("--max-lookback", type=int, default=600,
                    help="往回掃描的日曆天上限")
    ap.add_argument("--sleep", type=float, default=3.0, help="每次 TWSE 呼叫間隔秒數")
    ap.add_argument("--no-index", action="store_true", help="不處理大盤指數")
    args = ap.parse_args()

    months_cache = {}
    have = archived_dates()

    # --- 1. 把 data/history 還沒收進存檔的日子收進去 ---
    added = 0
    for ds in common.history_dates():
        if ds in have:
            continue
        blob = common.read_json(common.history_path(ds))
        if not blob:
            continue
        rows = rows_from_history_blob(blob)
        if rows and put_day(ds, rows, months_cache):
            have.add(ds)
            added += 1
    print("== 價格存檔:從 data/history 收進 %d 天(存檔目前 %d 天)==" % (added, len(have)))

    # --- 2. 回補(MI_INDEX 逐日往回)---
    if args.backfill_days > 0 and have:
        oldest = min(have)
        d = dt.date.fromisoformat(oldest)
        got = 0
        print("== 價格回補:從 %s 往前補 %d 個交易日 ==" % (oldest, args.backfill_days))
        for back in range(1, args.max_lookback + 1):
            if got >= args.backfill_days:
                break
            day = d - dt.timedelta(days=back)
            if day.weekday() >= 5:
                continue
            ds = day.isoformat()
            if ds in have:
                continue
            try:
                actual, mrows = twse_api.by_date(day.strftime("%Y%m%d"))
            except twse_api.TWSEError as e:
                print("  %s 失敗:%r" % (ds, e))
                time.sleep(args.sleep)
                continue
            if not actual or not mrows:
                print("  %s 無資料(休市)" % ds)
                time.sleep(args.sleep)
                continue
            rows = rows_from_twse(mrows)
            if put_day(actual, rows, months_cache):
                have.add(actual)
                got += 1
                print("  %s 補上 %d 檔" % (actual, len(rows)))
            time.sleep(args.sleep)

    for ym, blob in months_cache.items():
        _save_month(ym, blob)

    # --- 3. 大盤指數 ---
    if not args.no_index:
        idx = load_index_archive()
        n = merge_index_from_market_grid(idx)
        print("== 指數存檔:從九宮格 history 併入 %d 天(目前 %d 天)==" % (n, len(idx["days"])))
        if args.backfill_days > 0:
            got = backfill_index(idx, args.backfill_days, args.max_lookback, args.sleep)
            print("== 指數回補:補上 %d 天 ==" % got)
        idx["note"] = ("大盤指數逐日永久存檔,不裁掉。從九宮格 history 併入的日子有 grid_label/"
                       "price_state 等衍生欄位;用 --backfill-days 從 MI_INDEX 回補的舊日子只有"
                       "官方原始欄位(收盤/漲跌/成交金額/漲跌家數),沒有九宮格分類。")
        idx["day_count"] = len(idx["days"])
        idx["generated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        common.write_json(common.ARCHIVE_INDEX_FILE, idx, compact=True)

    total = archived_dates()
    print("== 完成:價格存檔共 %d 個交易日(%s ~ %s)==" %
          (len(total), min(total) if total else "-", max(total) if total else "-"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
