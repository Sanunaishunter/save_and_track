#!/usr/bin/env python3
"""
個股 FOMO 掃描:讀 watchlist.json,抓 FinMind 四組資料,計分後輸出靜態 JSON。

輸出:
  data/fomo-latest.json        前端讀這支
  data/fomo/YYYY-MM-DD.json    當日存底

注意:data/history/ 與 data/scan-latest.json 是「爆量掃描」在用的,
不要寫進去,兩個功能各自獨立。
"""

import argparse
import datetime as dt
import os
import sys
import time

import common
import finmind_api as fm
import fomo_score

WATCHLIST_FILE = os.path.join(common.ROOT, "watchlist.json")
FOMO_DIR = os.path.join(common.DATA_DIR, "fomo")
FOMO_LATEST = os.path.join(common.DATA_DIR, "fomo-latest.json")

DATASETS = [
    "TaiwanStockPrice",
    "TaiwanStockMarginPurchaseShortSale",
    "TaiwanStockInstitutionalInvestorsBuySell",
    "TaiwanStockPER",
]

LOOKBACK_TRADING_DAYS = 15      # 算 5 日增幅需要的最小視窗,取 15 天當緩衝
LOOKBACK_CALENDAR_DAYS = 40     # 15 個交易日大約需要的日曆天


def taipei_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date()


def load_watchlist():
    wl = common.read_json(WATCHLIST_FILE)
    if not isinstance(wl, list) or not wl:
        raise SystemExit("錯誤:找不到 watchlist.json 或格式不是非空陣列")
    out = []
    for s in wl:
        s = str(s).strip()
        if s and s not in out:
            out.append(s)
    return out


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


def _by_date(rows):
    return sorted([r for r in rows if r.get("date")], key=lambda r: r["date"])


def extract_metrics(price_rows, margin_rows, inst_rows, per_rows):
    """把四組原始資料整理成計分需要的指標;取不到的一律 None,不用 0 頂替。"""
    m = {
        "close": None, "volume": None, "prev_volume": None,
        "margin_change_5d_pct": None, "short_margin_ratio": None,
        "foreign_net": None, "foreign_consecutive_buy_days": None, "pbr": None,
    }

    # --- 價量 ---
    prices = _by_date(price_rows)
    if prices:
        m["close"] = _num(prices[-1].get("close"))
        m["volume"] = _num(prices[-1].get("Trading_Volume"))
    if len(prices) >= 2:
        m["prev_volume"] = _num(prices[-2].get("Trading_Volume"))

    # --- 融資融券 ---
    margins = _by_date(margin_rows)
    if margins:
        today = margins[-1]
        mb = _num(today.get("MarginPurchaseTodayBalance"))
        sb = _num(today.get("ShortSaleTodayBalance"))
        if mb is not None and mb > 0:
            if sb is not None:
                m["short_margin_ratio"] = sb / mb * 100.0
            # 5 個交易日前的融資餘額
            if len(margins) >= 6:
                prev = _num(margins[-6].get("MarginPurchaseTodayBalance"))
                if prev is not None and prev > 0:
                    m["margin_change_5d_pct"] = (mb - prev) / prev * 100.0

    # --- 外資買賣超 ---
    foreign = {}
    for r in inst_rows:
        name = str(r.get("name") or "")
        # FinMind 的外資是 Foreign_Investor;Foreign_Dealer_Self 是外資自營,不計入
        if name != "Foreign_Investor":
            continue
        d = r.get("date")
        buy, sell = _num(r.get("buy")), _num(r.get("sell"))
        if d and buy is not None and sell is not None:
            foreign[d] = buy - sell
    if foreign:
        days = sorted(foreign.keys())
        m["foreign_net"] = foreign[days[-1]]
        streak = 0
        for d in reversed(days):
            if foreign[d] > 0:
                streak += 1
            else:
                break
        m["foreign_consecutive_buy_days"] = streak

    # --- PBR ---
    pers = _by_date(per_rows)
    for r in reversed(pers):
        p = _num(r.get("PBR"))
        if p is not None and p > 0:
            m["pbr"] = p
            break

    return m


def fetch_stock(stock_id, start_date, end_date):
    price = fm.request("TaiwanStockPrice", stock_id, start_date, end_date)
    time.sleep(0.25)
    margin = fm.request("TaiwanStockMarginPurchaseShortSale", stock_id, start_date, end_date)
    time.sleep(0.25)
    inst = fm.request("TaiwanStockInstitutionalInvestorsBuySell", stock_id, start_date, end_date)
    time.sleep(0.25)
    per = fm.request("TaiwanStockPER", stock_id, start_date, end_date)
    time.sleep(0.25)
    return price, margin, inst, per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="只跑前 N 檔(本機小批測試用)")
    ap.add_argument("--skip-preflight", action="store_true")
    args = ap.parse_args()

    watchlist = load_watchlist()
    if args.limit > 0:
        watchlist = watchlist[:args.limit]

    end = taipei_today()
    start = end - dt.timedelta(days=LOOKBACK_CALENDAR_DAYS)
    start_s, end_s = start.isoformat(), end.isoformat()

    print("== FOMO 掃描 ==")
    print("  觀察名單:%d 檔" % len(watchlist))
    print("  區間:%s ~ %s" % (start_s, end_s))
    print("  FinMind token:%s" % ("已設定" if fm.has_token() else "未設定(未註冊模式)"))

    # 先確認四個 dataset 在目前等級下真的拿得到,不要跑到一半才炸
    if not args.skip_preflight:
        print("\n== 檢查資料源可用性 ==")
        report = fm.preflight(DATASETS, watchlist[0], start_s, end_s)
        blocked = []
        for ds in DATASETS:
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
    data_date = None          # 以實際抓到的最後一個交易日為準,不用「今天」
    started = time.time()
    for i, sid in enumerate(watchlist, 1):
        try:
            price, margin, inst, per = fetch_stock(sid, start_s, end_s)
        except fm.FinMindError as e:
            print("  [%d/%d] %s 抓取失敗:%s" % (i, len(watchlist), sid, e))
            failures.append({"stock_id": sid, "error": str(e)})
            continue

        seen = _by_date(price)
        if seen and (data_date is None or seen[-1]["date"] > data_date):
            data_date = seen[-1]["date"]

        m = extract_metrics(price, margin, inst, per)
        row = fomo_score.score_stock(sid, names.get(sid, ""), m)
        rows.append(row)
        print("  [%d/%d] %s %-6s FOMO=%3d 真漲=%-5s 虛漲=%-5s%s"
              % (i, len(watchlist), sid, row["stock_name"], row["fomo_score"],
                 row["is_real_rally"], row["is_fake_rally"],
                 ("  缺:" + "/".join(row["missing"])) if row["missing"] else ""))

    if not rows:
        print("錯誤:一檔都沒算出來", file=sys.stderr)
        return 1

    rows.sort(key=lambda r: r["fomo_score"], reverse=True)

    if data_date is None:
        print("錯誤:抓不到任何交易日資料", file=sys.stderr)
        return 1

    result = {
        "date": data_date,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "finmind",
        "thresholds": fomo_score.THRESHOLDS,
        "watchlist_count": len(watchlist),
        "scored_count": len(rows),
        "failures": failures,
        "rows": rows,
    }

    prev = common.read_json(FOMO_LATEST)
    if prev and _strip_ts(prev) == _strip_ts(result):
        print("\n  結果與上次相同(%s),不重寫檔案" % data_date)
        return 0

    common.write_json(FOMO_LATEST, result)
    common.write_json(os.path.join(FOMO_DIR, data_date + ".json"), result)

    elapsed = time.time() - started
    real = sum(1 for r in rows if r["is_real_rally"])
    fake = sum(1 for r in rows if r["is_fake_rally"])
    print("\n== 完成:%d 檔、真漲 %d、虛漲 %d、失敗 %d、耗時 %.1f 秒 =="
          % (len(rows), real, fake, len(failures), elapsed))
    print("   資料日期:%s" % data_date)
    for r in rows[:5]:
        print("   %s %s FOMO=%d" % (r["stock_id"], r["stock_name"], r["fomo_score"]))
    return 0


def _strip_ts(blob):
    out = dict(blob)
    out.pop("generated_at", None)
    return out


if __name__ == "__main__":
    sys.exit(main())
