#!/usr/bin/env python3
"""
個股暴跌 FOMO 掃描:compute_fomo.py 的鏡射版本,判斷一檔股票的下跌是
「真跌」(法人出貨主導,大機率續跌)還是「虛跌」(融資斷頭式恐慌錯殺,
法人趁機承接,可能是抄底機會)。

抓資料、算指標的底層邏輯(FinMind 四組資料、百分比計算)直接沿用
compute_fomo.py,不重複實作 —— 差別只在:
  1. 觀察名單預設抓「暴跌掃描」(data/crash-latest.json)而不是爆量掃描
  2. 計分換成 fomo_score.score_stock_crash(),不是 score_stock()

真跌/虛跌的判斷邏輯是真漲/虛漲的鏡射,但方向不是單純把號誌反過來,
細節見 fomo_score.py 裡 judge_real_crash()/judge_fake_crash() 的說明,
以及跟 Hugo 討論後的結論(真跌 = 外資連續賣超為必要條件 + 融資還沒
大減 + 券資比低 + PBR 還沒跌到便宜;虛跌 = 融資斷頭式大減 + 外資
中性偏買 + PBR 明顯偏低 + 量縮)。

輸出:
  data/crash-fomo-latest.json     前端讀這支
  data/crash-fomo/YYYY-MM-DD.json 當日存底

注意:跟 compute_fomo.py 一樣,不動 data/history/ 與 data/scan-latest.json、
data/crash-latest.json,各功能獨立。
"""

import argparse
import datetime as dt
import os
import sys
import time

import common
import compute_fomo as cf
import finmind_api as fm
import fomo_score
import twse_api

CRASH_LATEST = common.CRASH_LATEST_FILE      # 暴跌掃描的輸出
CRASH_FOMO_DIR = os.path.join(common.DATA_DIR, "crash-fomo")
CRASH_FOMO_LATEST = os.path.join(common.DATA_DIR, "crash-fomo-latest.json")


def load_from_crash(top):
    """
    以暴跌掃描的結果當觀察名單,取 vol_ratio 前 top 名。額度考量跟
    compute_fomo.load_from_scan() 一樣:每檔要打 4 次 FinMind。
    """
    crash = common.read_json(CRASH_LATEST)
    if not crash or not isinstance(crash.get("rows"), list) or not crash["rows"]:
        return None, {}, None

    rows = crash["rows"][:top] if top > 0 else crash["rows"]
    codes = cf._dedup([r.get("stock_id") for r in rows])
    extra = {}
    for r in rows:
        sid = str(r.get("stock_id") or "")
        if sid:
            extra[sid] = {"name": r.get("stock_name") or "",
                          "vol_ratio": r.get("vol_ratio")}
    return codes, extra, crash.get("date")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="只跑前 N 檔(本機小批測試用)")
    ap.add_argument("--skip-preflight", action="store_true")
    ap.add_argument("--source", choices=["crash", "watchlist"], default="crash",
                    help="名單來源:crash = 暴跌掃描結果(預設),watchlist = 手動名單")
    ap.add_argument("--top", type=int, default=60,
                    help="從暴跌清單取前幾名(依 vol_ratio),0 = 全部")
    args = ap.parse_args()

    crash_date = None
    if args.source == "crash":
        watchlist, extra, crash_date = load_from_crash(args.top)
        if not watchlist:
            print("警告:讀不到暴跌掃描結果,改用 watchlist.json")
            watchlist, extra, crash_date = cf.load_watchlist()
    else:
        watchlist, extra, crash_date = cf.load_watchlist()

    if args.limit > 0:
        watchlist = watchlist[:args.limit]

    end = cf.taipei_today()
    start = end - dt.timedelta(days=cf.LOOKBACK_CALENDAR_DAYS)
    start_s, end_s = start.isoformat(), end.isoformat()

    print("== 暴跌 FOMO 掃描 ==")
    print("  名單來源:%s%s" % (
        "暴跌掃描" if args.source == "crash" else "watchlist.json",
        ("(%s,取前 %d 名)" % (crash_date, args.top)) if crash_date and args.source == "crash" else ""))
    print("  觀察名單:%d 檔" % len(watchlist))
    per_stock = len(cf.DATASETS)
    est = len(watchlist) * per_stock
    if not args.skip_preflight:
        est += len(cf.DATASETS)
    cap = 600 if fm.has_token() else 300
    note = ""
    if est > cap:
        note = "  ⚠ 會超過額度,後面的股票會抓不到"
    elif est > cap * 0.8:
        note = "  ⚠ 已用掉 %d%% 額度,同一小時內別重跑" % round(100.0 * est / cap)
    print("  預估 API 呼叫:%d 次(上限 %d 次/小時)%s" % (est, cap, note))
    print("  區間:%s ~ %s" % (start_s, end_s))

    if not args.skip_preflight:
        print("\n== 檢查資料源可用性 ==")
        report = fm.preflight(cf.DATASETS, watchlist[0], start_s, end_s)
        blocked = []
        for ds in cf.DATASETS:
            r = report[ds]
            if r["ok"]:
                print("  ✓ %-45s %d 筆  欄位=%s" % (ds, r["rows"], r["fields"]))
            else:
                print("  ✗ %-45s %s" % (ds, r["error"]))
                blocked.append(ds)
        if blocked:
            print("\n錯誤:以下 dataset 取不到,可能需要付費等級或欄位有變:\n  %s"
                  % "\n  ".join(blocked), file=sys.stderr)
            return 1

    names = common.read_json(common.NAMES_FILE, {}) or {}

    print("\n== 逐檔抓取與計分 ==")
    rows = []
    failures = []
    data_date = None
    started = time.time()
    for i, sid in enumerate(watchlist, 1):
        try:
            price, margin, inst, per = cf.fetch_stock(sid, start_s, end_s)
        except fm.FinMindError as e:
            print("  [%d/%d] %s 抓取失敗:%s" % (i, len(watchlist), sid, e))
            failures.append({"stock_id": sid, "error": str(e)})
            continue

        seen = cf._by_date(price)
        if seen and (data_date is None or seen[-1]["date"] > data_date):
            data_date = seen[-1]["date"]

        m = cf.extract_metrics(price, margin, inst, per)
        info = extra.get(sid) or {}
        if info.get("vol_ratio") is not None:
            m["vol_ratio"] = info["vol_ratio"]
        row = fomo_score.score_stock_crash(sid, info.get("name") or names.get(sid, ""), m)
        rows.append(row)
        print("  [%d/%d] %s %-6s 恐慌分數=%3d 真跌=%-5s 虛跌=%-5s%s"
              % (i, len(watchlist), sid, row["stock_name"], row["crash_score"],
                 row["is_real_crash"], row["is_fake_crash"],
                 ("  缺:" + "/".join(row["missing"])) if row["missing"] else ""))

    if not rows:
        print("錯誤:一檔都沒算出來", file=sys.stderr)
        return 1

    rows.sort(key=lambda r: r["crash_score"], reverse=True)

    if data_date is None:
        print("錯誤:抓不到任何交易日資料", file=sys.stderr)
        return 1

    market_totals = None
    try:
        ymd = data_date.replace("-", "")
        t86_date, _per_stock, market_totals = twse_api.institutional_by_date(
            ymd, keep=lambda c: common.is_listed_common(c, None))
        if market_totals:
            print("\n== 全市場法人買賣超總額(%s,上市普通股)==" % t86_date)
            print("   外資買超 %s 股 / 賣超 %s 股"
                  % (format(int(market_totals["foreign_buy"]), ","),
                     format(int(market_totals["foreign_sell"]), ",")))
    except twse_api.TWSEError as e:
        print("\n警告:取不到全市場法人資料(%s),佔全市場的百分比將略過" % e)
        market_totals = None

    cf._add_percentages(rows, market_totals)

    result = {
        "date": data_date,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "finmind",
        "thresholds": fomo_score.THRESHOLDS,
        "source_list": args.source,
        "crash_date": crash_date,
        "market_totals": (None if not market_totals else {
            k: int(v) for k, v in market_totals.items()
        }),
        "watchlist_count": len(watchlist),
        "scored_count": len(rows),
        "failures": failures,
        "rows": rows,
    }

    prev = common.read_json(CRASH_FOMO_LATEST)
    if prev and cf._strip_ts(prev) == cf._strip_ts(result):
        print("\n  結果與上次相同(%s),不重寫檔案" % data_date)
        return 0

    common.write_json(CRASH_FOMO_LATEST, result)
    common.write_json(os.path.join(CRASH_FOMO_DIR, data_date + ".json"), result)

    elapsed = time.time() - started
    real = sum(1 for r in rows if r["is_real_crash"])
    fake = sum(1 for r in rows if r["is_fake_crash"])
    print("\n== 完成:%d 檔、真跌 %d、虛跌 %d、失敗 %d、耗時 %.1f 秒 =="
          % (len(rows), real, fake, len(failures), elapsed))
    print("   資料日期:%s" % data_date)
    for r in rows[:5]:
        print("   %s %s 恐慌分數=%d" % (r["stock_id"], r["stock_name"], r["crash_score"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
