#!/usr/bin/env python3
"""
計算爆量清單。

  vol_ratio = 當日成交量 / MA20
  MA20      = 前 20 個交易日的均量,shift(1) — 不含當日
  爆量條件  = vol_ratio > 1.5 且 close > open

輸出 data/scan-latest.json(前端讀這支)與 data/scans/YYYY-MM-DD.json(存查)。

用法:
  python scripts/compute_scan.py
      跑最新一天(daily-scan.yml 用這個,讀 data/history)
  python scripts/compute_scan.py --backfill-archive [--force]
      一次性:用 data/archive/prices(現有存檔,不打 API)回補所有歷史日期的
      data/scans/*.json,公式與每日模式完全一字不改(compute_for_date() 兩邊
      共用同一份邏輯)。已經存在的日期預設跳過,--force 才會覆蓋重算。
      2026-09-18 加入,做法照抄 scripts/compute_thin_scan.py。
"""

import argparse
import datetime as dt
import os
import sys

import common


def load_day(date_str):
    """回傳 {stock_id: {volume, open, high, low, close}}。"""
    blob = common.read_json(common.history_path(date_str))
    if not blob:
        return {}
    cols = blob.get("columns") or common.COLUMNS
    idx = {name: i for i, name in enumerate(cols)}
    out = {}
    for row in blob.get("rows") or []:
        try:
            out[row[idx["id"]]] = {
                "volume": row[idx["volume"]],
                "open": row[idx["open"]],
                "high": row[idx["high"]],
                "low": row[idx["low"]],
                "close": row[idx["close"]],
            }
        except (IndexError, KeyError, TypeError):
            continue
    return out


def _without_timestamp(blob):
    """比較兩次掃描結果時忽略產生時間。"""
    out = dict(blob)
    out.pop("generated_at", None)
    return out


def _ma_state_of(sid, cur, prior_days):
    closes = [cur["close"]]
    for d in reversed(prior_days[-19:]):
        c = d.get(sid, {}).get("close")
        closes.append(c)
    st = common.ma_state(closes)
    return st["state"] if st else None


def compute_for_date(prices_by_date, dates, pos, names):
    """跟每日模式完全對稱的核心邏輯,資料來源换成呼叫端準備好的
    {date: {sid: row}} 字典,同時相容即時模式(data/history)跟回補模式
    (data/archive/prices)。做法照抄 scripts/compute_thin_scan.py 的
    compute_for_date()。"""
    target = dates[pos]
    prior = dates[max(0, pos - common.MA_WINDOW):pos]
    if len(prior) < common.MA_WINDOW:
        return None
    today = prices_by_date.get(target) or {}
    if not today:
        return None
    prior_days = [prices_by_date.get(d) or {} for d in prior]
    prev_day = prior_days[-1] if prior_days else {}

    rows = []
    evaluated = 0
    for sid, cur in today.items():
        vols = [d[sid]["volume"] for d in prior_days if sid in d]
        if len(vols) < common.MA_WINDOW:
            continue                              # 新股／停牌太久,基線不足就不評估
        ma20 = sum(vols) / float(len(vols))
        if ma20 <= 0:
            continue
        evaluated += 1

        vol_ratio = cur["volume"] / ma20
        if vol_ratio <= common.VOL_RATIO_THRESHOLD:
            continue
        if cur["volume"] < common.MIN_VOLUME_SHARES:
            continue                              # 薄股票量再怎麼放大還是薄,擋在源頭
        if not (cur["close"] > cur["open"]):
            continue

        prev_close = prev_day.get(sid, {}).get("close")
        if prev_close:
            change_pct = (cur["close"] - prev_close) / prev_close * 100.0
        else:
            change_pct = None

        rows.append({
            "stock_id": sid,
            "stock_name": names.get(sid, ""),
            "vol_ratio": round(vol_ratio, 2),
            "change_pct": None if change_pct is None else round(change_pct, 2),
            "close": cur["close"],
            "volume": cur["volume"],
            "ma20_volume": int(ma20),
            # 2026-09-14:價格均線狀態(bull/bear/mixed,跟前端 priceMaState 同定義),
            # 給「合流」判讀跟記分板分桶用;基線不足 20 天是 None
            "ma_state": _ma_state_of(sid, cur, prior_days),
        })

    rows.sort(key=lambda r: r["vol_ratio"], reverse=True)

    return {
        "date": target,
        "market": "twse-listed-common",
        "params": {
            "ma_window": common.MA_WINDOW,
            "ma_shift": 1,
            "vol_ratio_threshold": common.VOL_RATIO_THRESHOLD,
            "min_volume_shares": common.MIN_VOLUME_SHARES,
            "condition": "vol_ratio > %s 且 close > open 且成交量 >= %d 股(%d 張)"
                         % (common.VOL_RATIO_THRESHOLD, common.MIN_VOLUME_SHARES, common.MIN_VOLUME_LOTS),
        },
        "universe": len(today),
        "evaluated": evaluated,
        "count": len(rows),
        "rows": rows,
    }


def _load_history_window():
    """讀 data/history(滾動 30 天),回傳 ({date: {sid: row}}, dates_new_to_old_filtered)。"""
    dates = common.history_dates()
    out = {}
    for d in dates:
        day = load_day(d)
        if day:
            out[d] = day
    return out, [d for d in dates if d in out]


def run_today():
    prices_by_date, dates = _load_history_window()
    if not dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    target = dates[-1]
    prior = dates[:-1][-common.MA_WINDOW:]      # 不含當日的前 20 個交易日

    print("== 計算 %s 的爆量清單 ==" % target)
    print("  基線交易日:%d 天(需要 %d 天)" % (len(prior), common.MA_WINDOW))

    if len(prior) < common.MA_WINDOW:
        print("錯誤:基線不足 %d 個交易日,目前只有 %d 天。"
              "請先用 --backfill-days %d 回補。"
              % (common.MA_WINDOW, len(prior), common.KEEP_DAYS), file=sys.stderr)
        return 1

    names = common.read_json(common.NAMES_FILE, {}) or {}
    result = compute_for_date(prices_by_date, dates, len(dates) - 1, names)
    if result is None:
        print("錯誤:%s 沒有資料" % target, file=sys.stderr)
        return 1
    result["generated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 休市日重跑會算出跟上次一模一樣的結果,只有 generated_at 不同。
    # 若實質內容沒變就不重寫,避免每天堆積無意義的 commit。
    prev = common.read_json(common.LATEST_FILE)
    if prev and _without_timestamp(prev) == _without_timestamp(result):
        print("  結果與上次相同(%s),不重寫檔案" % target)
        return 0

    common.write_json(common.LATEST_FILE, result)
    common.write_json(common.history_path(target).replace("history", "scans"), result)

    print("  掃描 %d 檔,基線足夠 %d 檔,爆量 %d 檔" % (result["universe"], result["evaluated"], result["count"]))
    for r in result["rows"][:10]:
        print("    %s %s  vol_ratio=%.2f  漲跌 %s%%"
              % (r["stock_id"], r["stock_name"], r["vol_ratio"], r["change_pct"]))
    return 0


def run_backfill(force):
    """一次性用 data/archive/prices 回補所有歷史日期的 data/scans/*.json,
    不打 API。做法照抄 scripts/compute_thin_scan.py 的 run_backfill()。"""
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    names = common.read_json(common.NAMES_FILE, {}) or {}
    written = skipped = empty = 0
    for pos in range(common.MA_WINDOW, len(dates)):
        target = dates[pos]
        path = os.path.join(common.SCANS_DIR, target + ".json")
        if not force and common.read_json(path) is not None:
            skipped += 1
            continue
        result = compute_for_date(prices, dates, pos, names)
        if result is None:
            empty += 1
            continue
        result["generated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        common.write_json(path, result)
        written += 1
        if written % 50 == 0:
            print("  已寫入 %d 天…" % written)

    print("== 爆量掃描回補完成:寫入 %d 天、跳過已存在 %d 天、無資料 %d 天(價格範圍 %s ~ %s) =="
          % (written, skipped, empty, dates[0], dates[-1]))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-archive", action="store_true",
                     help="一次性用 data/archive/prices 回補所有歷史日期(不打 API)")
    ap.add_argument("--force", action="store_true", help="回補時覆蓋已存在的檔案")
    args = ap.parse_args()
    if args.backfill_archive:
        return run_backfill(args.force)
    return run_today()


if __name__ == "__main__":
    sys.exit(main())
