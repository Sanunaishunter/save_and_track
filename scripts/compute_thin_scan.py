#!/usr/bin/env python3
"""
薄股測試(2026-09-17 加入)。

爆量掃描的公式一字不改(vol_ratio = 量/MA20(shift1) > 1.5、close > open),差別
只在鎖定「量 < 300 張」這群——現行爆量掃描的 MIN_VOLUME_LOTS=300 下限會把這群
整批濾掉(common.py 說明:避免薄股票的雜訊爆量浪費 FinMind 額度)。

起因:使用者拿 6957 裕慶-KY 的真實線圖追出來,這檔股票的量在 9/16(390 張,
第一次進爆量掃描名單)之前——包含 9/10(119張)、9/11(162張),還有更早的
2025-08-19、08-28 等好幾次——vol_ratio 其實早就超過 1.5,只是每次量都不到
300 張,現行系統整批看不到。全市場回測過(284 天、~4000 筆樣本,N 遠超過
記分板 60 的門檻):量 < 300 張這群平均命中率比現有爆量掃描(量>=300張)那群
更低、超額報酬更負(5 日 33.4% vs 38.1%、平均超額 -1.40% vs -0.62%,天期拉長
差距更大)——不是新發現的獨立優勢,是「爆量看多容易輸」這個已經驗證過的故事
的加強版。使用者的決定(2026-09-17):不是要拿這個當進場勝率保證,是「跟著
散戶一起抬轎、有紀律地下車」——照樣做成正式訊號、進記分板算勝率,讓使用者
自己盯著數字判斷要不要跟、跟多重,不是系統幫他下結論說這穩賺。

輸出 data/thin-scan-latest.json(前端「薄股測試」分頁讀這支)與
data/thin-scans/YYYY-MM-DD.json(存查,訊號記分板/訊號反用讀這個目錄)。

用法:
  python scripts/compute_thin_scan.py
      跑最新一天(daily-scan.yml 用這個,讀 data/history)
  python scripts/compute_thin_scan.py --backfill-archive [--force]
      一次性:用 data/archive/prices(現有存檔,不打 API)回補所有歷史日期的
      data/thin-scans/*.json,讓記分板立刻有樣本可看,不用從今天等好幾週。
      已經存在的日期預設跳過,--force 才會覆蓋重算。
"""

import argparse
import datetime as dt
import os
import sys

import common

MA_WINDOW = common.MA_WINDOW  # 20


def _ma_state_of(sid, cur, prior_days):
    closes = [cur["close"]]
    for d in reversed(prior_days[-19:]):
        c = d.get(sid, {}).get("close")
        closes.append(c)
    st = common.ma_state(closes)
    return st["state"] if st else None


def compute_for_date(prices_by_date, dates, pos, names):
    """跟 compute_scan.py 的邏輯完全對稱,只是額外鎖定「量 < 300 張」這群、
    資料來源换成呼叫端準備好的 {date: {sid: row}} 字典(相容即時模式跟回補模式)。"""
    target = dates[pos]
    prior = dates[max(0, pos - MA_WINDOW):pos]
    if len(prior) < MA_WINDOW:
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
        if len(vols) < MA_WINDOW:
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
        lots = cur["volume"] / 1000.0
        if lots < common.THIN_SCAN_MIN_VOLUME_LOTS or lots >= common.MIN_VOLUME_LOTS:
            continue                              # 只要「量 < 300 張」這群,>=300 已經在爆量掃描裡

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
            "ma_state": _ma_state_of(sid, cur, prior_days),
        })

    rows.sort(key=lambda r: r["vol_ratio"], reverse=True)

    return {
        "date": target,
        "market": "twse-listed-common",
        "params": {
            "ma_window": MA_WINDOW,
            "ma_shift": 1,
            "vol_ratio_threshold": common.VOL_RATIO_THRESHOLD,
            "min_volume_lots": common.THIN_SCAN_MIN_VOLUME_LOTS,
            "max_volume_lots_exclusive": common.MIN_VOLUME_LOTS,
            "condition": ("vol_ratio > %s 且 close > open 且 %d 張 <= 成交量 < %d 張"
                          "(跟爆量掃描同公式,鎖定爆量掃描量下限濾掉的薄股票)"
                          % (common.VOL_RATIO_THRESHOLD, common.THIN_SCAN_MIN_VOLUME_LOTS,
                             common.MIN_VOLUME_LOTS)),
        },
        "universe": len(today),
        "evaluated": evaluated,
        "count": len(rows),
        "rows": rows,
    }


def _without_timestamp(blob):
    out = dict(blob)
    out.pop("generated_at", None)
    return out


def _load_history_window():
    """跟 compute_scan.py 一樣讀 data/history(滾動 30 天),回傳
    ({date: {sid: row}}, dates_new_to_old_filtered)。"""
    dates = common.history_dates()
    out = {}
    for d in dates:
        blob = common.read_json(common.history_path(d))
        if not blob:
            continue
        cols = blob.get("columns") or common.COLUMNS
        idx = {name: i for i, name in enumerate(cols)}
        day = {}
        for row in blob.get("rows") or []:
            try:
                day[row[idx["id"]]] = {
                    "volume": row[idx["volume"]], "open": row[idx["open"]],
                    "high": row[idx["high"]], "low": row[idx["low"]], "close": row[idx["close"]],
                }
            except (IndexError, KeyError, TypeError):
                continue
        if day:
            out[d] = day
    return out, [d for d in dates if d in out]


def run_today():
    prices_by_date, dates = _load_history_window()
    if not dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1
    if len(dates) < MA_WINDOW + 1:
        print("錯誤:基線不足 %d 個交易日,目前只有 %d 天。" % (MA_WINDOW + 1, len(dates)), file=sys.stderr)
        return 1

    names = common.read_json(common.NAMES_FILE, {}) or {}
    result = compute_for_date(prices_by_date, dates, len(dates) - 1, names)
    if result is None:
        print("錯誤:今天沒有資料可以算", file=sys.stderr)
        return 1
    result["generated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    prev = common.read_json(common.THIN_SCAN_LATEST_FILE)
    if prev and _without_timestamp(prev) == _without_timestamp(result):
        print("  結果與上次相同(%s),不重寫檔案" % result["date"])
        return 0

    common.write_json(common.THIN_SCAN_LATEST_FILE, result)
    common.write_json(os.path.join(common.THIN_SCANS_DIR, result["date"] + ".json"), result)

    print("== 薄股測試 %s:掃描 %d 檔,基線足夠 %d 檔,符合 %d 檔 ==" %
          (result["date"], result["universe"], result["evaluated"], result["count"]))
    for r in result["rows"][:10]:
        print("    %s %s  vol_ratio=%.2f  量=%.1f張  漲跌 %s%%"
              % (r["stock_id"], r["stock_name"], r["vol_ratio"], r["volume"] / 1000.0, r["change_pct"]))
    return 0


def run_backfill(force):
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    names = common.read_json(common.NAMES_FILE, {}) or {}
    written = skipped = empty = 0
    for pos in range(MA_WINDOW, len(dates)):
        target = dates[pos]
        path = os.path.join(common.THIN_SCANS_DIR, target + ".json")
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

    print("== 薄股測試回補完成:寫入 %d 天、跳過已存在 %d 天、無資料 %d 天(價格範圍 %s ~ %s) =="
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
