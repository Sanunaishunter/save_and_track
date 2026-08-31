#!/usr/bin/env python3
"""
計算爆量清單。

  vol_ratio = 當日成交量 / MA20
  MA20      = 前 20 個交易日的均量,shift(1) — 不含當日
  爆量條件  = vol_ratio > 1.5 且 close > open

輸出 data/scan-latest.json(前端讀這支)與 data/scans/YYYY-MM-DD.json(存查)。
"""

import datetime as dt
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


def main():
    dates = common.history_dates()
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

    today = load_day(target)
    if not today:
        print("錯誤:%s 沒有資料" % target, file=sys.stderr)
        return 1

    prior_days = [load_day(d) for d in prior]
    prev_day = prior_days[-1] if prior_days else {}
    names = common.read_json(common.NAMES_FILE, {}) or {}

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
        })

    rows.sort(key=lambda r: r["vol_ratio"], reverse=True)

    result = {
        "date": target,
        "generated_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "market": "twse-listed-common",
        "params": {
            "ma_window": common.MA_WINDOW,
            "ma_shift": 1,
            "vol_ratio_threshold": common.VOL_RATIO_THRESHOLD,
            "condition": "vol_ratio > %s 且 close > open" % common.VOL_RATIO_THRESHOLD,
        },
        "universe": len(today),
        "evaluated": evaluated,
        "count": len(rows),
        "rows": rows,
    }

    # 休市日重跑會算出跟上次一模一樣的結果,只有 generated_at 不同。
    # 若實質內容沒變就不重寫,避免每天堆積無意義的 commit。
    prev = common.read_json(common.LATEST_FILE)
    if prev and _without_timestamp(prev) == _without_timestamp(result):
        print("  結果與上次相同(%s),不重寫檔案" % target)
        return 0

    common.write_json(common.LATEST_FILE, result)
    common.write_json(common.history_path(target).replace("history", "scans"), result)

    print("  掃描 %d 檔,基線足夠 %d 檔,爆量 %d 檔" % (len(today), evaluated, len(rows)))
    for r in rows[:10]:
        print("    %s %s  vol_ratio=%.2f  漲跌 %s%%"
              % (r["stock_id"], r["stock_name"], r["vol_ratio"], r["change_pct"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
