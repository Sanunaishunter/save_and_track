#!/usr/bin/env python3
"""
8012 產業/市值 Tick 聚合。

把上市普通股依「產業別 × 市值級距」分組,比較各組每日成交筆數
(tick 活躍度代理指標),看哪一組今天暴增/暴減。

純觀察型,不產生任何進出場訊號,也不跟爆量掃描/FOMO 的邏輯耦合。

輸出:
  data/tick-latest.json          最新交易日的交叉表 + 每組 30 天原始序列
  data/tick/YYYY-MM-DD.json      同上,存查
  data/tick-members-latest.json  各組凍結成員的逐日筆數(前端展開用)
  data/tick-sample-members.json  凍結的抽樣名單(長期狀態,不是每日產出)
"""

import argparse
import datetime as dt
import sys

import common
import tick_flow
import tick_indicators


def load_ticks(date_str):
    """回傳 ({stock_id: 成交筆數}, {stock_id: 收盤價})。只留上市普通股。"""
    blob = common.read_json(common.history_path(date_str))
    if not blob:
        return {}, {}
    cols = blob.get("columns") or common.COLUMNS
    idx = {name: i for i, name in enumerate(cols)}
    if "transaction" not in idx:
        return {}, {}

    ticks, closes = {}, {}
    for row in blob.get("rows") or []:
        try:
            sid = row[idx["id"]]
            tx = row[idx["transaction"]]
            close = row[idx["close"]]
        except (IndexError, KeyError, TypeError):
            continue
        if not common.is_listed_common(sid, None):
            continue
        if tx is not None:
            ticks[sid] = tx
        if close is not None:
            closes[sid] = close
    return ticks, closes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refreeze", action="store_true",
                    help="丟掉既有凍結名單重新抽樣(會讓序列不可比,平常別用)")
    args = ap.parse_args()

    all_dates = common.history_dates()
    if not all_dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    # vals 是「新到舊」,vals[0] = 今天
    dates = list(reversed(all_dates))[:tick_indicators.DISPLAY_DAYS]
    target = dates[0]

    per_code_counts = {}
    closes = {}
    for d in dates:
        ticks, day_closes = load_ticks(d)
        if d == target:
            closes = day_closes
        for code, tx in ticks.items():
            per_code_counts.setdefault(code, {})[d] = tx

    have_today = sum(1 for c in per_code_counts if target in per_code_counts[c])
    print("== 產業/市值 Tick 聚合 %s ==" % target)
    print("  序列天數:%d(顯示上限 %d)" % (len(dates), tick_indicators.DISPLAY_DAYS))
    print("  當日有成交筆數的股票:%d 檔" % have_today)
    if not have_today:
        print("錯誤:%s 沒有任何成交筆數,無法聚合" % target, file=sys.stderr)
        return 1

    meta = common.read_json(common.META_FILE) or {}
    meta_stocks = meta.get("stocks") or {}
    if not meta_stocks:
        print("錯誤:找不到 data/stock_meta.json,請先跑 fetch_stock_meta.py",
              file=sys.stderr)
        return 1

    candidates = tick_flow.build_candidates(meta_stocks, closes)
    pool = sum(len(v) for v in candidates.values())
    print("  候選:%d 檔、%d 個產業(有產業別 + 有股數 + 當日有收盤價)"
          % (pool, len(candidates)))

    frozen_blob = {} if args.refreeze else (common.read_json(common.TICK_SAMPLE_FILE) or {})
    frozen = dict(frozen_blob.get("groups") or {})
    before = len(frozen)
    frozen, added = tick_flow.freeze_samples(frozen, candidates)
    if added:
        print("  新凍結 %d 組(原有 %d 組,合計 %d 組)" % (added, before, len(frozen)))
    else:
        print("  凍結名單沿用既有 %d 組" % len(frozen))

    rows = tick_flow.build_snapshot(frozen, per_code_counts, dates)
    reporting_total = sum(r["reporting_count"] for r in rows)
    under = sum(1 for r in rows if r["reporting_count"] < r["sample_count"])
    low_n = sum(1 for r in rows if r["low_n_flag"])
    print("  聚合 %d 組:當日實報成員合計 %d、實報不足額 %d 組、樣本數低 %d 組"
          % (len(rows), reporting_total, under, low_n))

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    snapshot = {
        "date": target,
        "generated_at": now,
        "window_start_date": dates[-1],
        "days": dates,
        "params": {
            "sample_target_per_group": tick_flow.SAMPLE_TARGET_PER_GROUP,
            "low_n_threshold": tick_flow.LOW_N_THRESHOLD,
            "windows": list(tick_indicators.WINDOWS),
            "ma_window": tick_indicators.MA21_WINDOW,
            "display_days": tick_indicators.DISPLAY_DAYS,
        },
        "group_count": len(rows),
        "rows": rows,
    }
    common.write_json(common.TICK_LATEST_FILE, snapshot, compact=True)
    common.write_json(common.TICK_DIR + "/" + target + ".json", snapshot, compact=True)

    names = common.read_json(common.NAMES_FILE, {}) or {}
    members_out = {}
    for key, entry in frozen.items():
        caps = entry.get("frozen_caps_yi") or []
        members = []
        for i, code in enumerate(entry["members"]):
            counts = per_code_counts.get(code) or {}
            members.append({
                "code": code,
                "name": names.get(code) or (meta_stocks.get(code) or {}).get("name") or "",
                "frozen_cap_yi": caps[i] if i < len(caps) else None,
                "ticks": [counts.get(d) for d in dates],
            })
        members_out[key] = members

    common.write_json(common.TICK_MEMBERS_FILE, {
        "date": target,
        "generated_at": now,
        "days": dates,
        "groups": members_out,
    }, compact=True)

    common.write_json(common.TICK_SAMPLE_FILE, {
        "generated_at": now,
        "note": "抽樣一旦凍結就不再重算;要重抽請用 compute_tick_flow.py --refreeze",
        "group_count": len(frozen),
        "groups": frozen,
    })

    print("已寫入 %s" % common.TICK_LATEST_FILE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
