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
import twse_api

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
        "trust_net": None, "trust_amount": None,
        "foreign_streak_days": None, "foreign_streak_direction": None,
        "foreign_streak_shares": None, "foreign_streak_amount": None,
        "foreign_pct_of_volume": None, "foreign_pct_of_market": None,
        "trust_pct_of_volume": None, "trust_pct_of_market": None,
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

    # --- 法人買賣超 ---
    # 探測確認 FinMind 的 name 只有這五種:Foreign_Investor、Investment_Trust、
    # Foreign_Dealer_Self、Dealer_self、Dealer_Hedging。
    # 外資取 Foreign_Investor(不含外資自營商),與 TWSE T86 的定義一致。
    close_by_date = {r["date"]: _num(r.get("close")) for r in prices if r.get("date")}

    def net_by_date(target_name):
        out = {}
        for r in inst_rows:
            if str(r.get("name") or "") != target_name:
                continue
            d = r.get("date")
            buy, sell = _num(r.get("buy")), _num(r.get("sell"))
            if d and buy is not None and sell is not None:
                out[d] = buy - sell
        return out

    foreign = net_by_date("Foreign_Investor")
    trust = net_by_date("Investment_Trust")

    if foreign:
        days = sorted(foreign.keys())
        latest = foreign[days[-1]]
        m["foreign_net"] = latest

        # 真漲門檻只看「連續買超」天數
        buy_streak = 0
        for d in reversed(days):
            if foreign[d] > 0:
                buy_streak += 1
            else:
                break
        m["foreign_consecutive_buy_days"] = buy_streak

        # 標記文字要連買也要連賣,所以另外算帶方向的連續天數
        if latest != 0:
            want_positive = latest > 0
            streak_days, streak_shares, streak_amount = 0, 0.0, 0.0
            for d in reversed(days):
                v = foreign[d]
                if v == 0 or (v > 0) != want_positive:
                    break
                streak_days += 1
                streak_shares += v
                c = close_by_date.get(d)
                if c:
                    streak_amount += v * c
            m["foreign_streak_days"] = streak_days
            m["foreign_streak_direction"] = "buy" if want_positive else "sell"
            m["foreign_streak_shares"] = streak_shares
            m["foreign_streak_amount"] = streak_amount if streak_amount else None

    if trust:
        tdays = sorted(trust.keys())
        m["trust_net"] = trust[tdays[-1]]
        c = close_by_date.get(tdays[-1])
        if c:
            m["trust_amount"] = trust[tdays[-1]] * c

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

    # 全市場法人買賣超,用來算「佔全市場外資/投信買超 P%」的分母。
    # 分母用「買超個股加總」而非市場買賣差額 —— 差額可能是負數
    # (實測 2026-08-31 外資淨賣超 143 億),當分母算出的百分比沒有意義。
    market_totals = None
    try:
        ymd = data_date.replace("-", "")
        t86_date, _per_stock, market_totals = twse_api.institutional_by_date(
            ymd, keep=lambda c: common.is_listed_common(c, None))
        if market_totals:
            print("\n== 全市場法人買超總額(%s,上市普通股)==" % t86_date)
            print("   外資買超 %s 股 / 賣超 %s 股"
                  % (format(int(market_totals["foreign_buy"]), ","),
                     format(int(market_totals["foreign_sell"]), ",")))
            print("   投信買超 %s 股 / 賣超 %s 股"
                  % (format(int(market_totals["trust_buy"]), ","),
                     format(int(market_totals["trust_sell"]), ",")))
    except twse_api.TWSEError as e:
        print("\n警告:取不到全市場法人資料(%s),佔全市場的百分比將略過" % e)
        market_totals = None

    _add_percentages(rows, market_totals)

    result = {
        "date": data_date,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "finmind",
        "thresholds": fomo_score.THRESHOLDS,
        "market_totals": (None if not market_totals else {
            k: int(v) for k, v in market_totals.items()
        }),
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


def _pct(part, whole):
    if part is None or not whole:
        return None
    return abs(part) / float(whole) * 100.0


def _add_percentages(rows, totals):
    """補上兩種佔比,並用完整資訊重新產生標記文字。"""
    for r in rows:
        m = dict(r["metrics"])
        vol = m.get("volume")
        fn, tn = m.get("foreign_net"), m.get("trust_net")

        m["foreign_pct_of_volume"] = _pct(fn, vol)
        m["trust_pct_of_volume"] = _pct(tn, vol)

        if totals:
            if fn is not None:
                key = "foreign_buy" if fn > 0 else "foreign_sell"
                m["foreign_pct_of_market"] = _pct(fn, totals.get(key))
            if tn is not None:
                key = "trust_buy" if tn > 0 else "trust_sell"
                m["trust_pct_of_market"] = _pct(tn, totals.get(key))

        r["metrics"]["foreign_pct_of_volume"] = _round(m["foreign_pct_of_volume"])
        r["metrics"]["trust_pct_of_volume"] = _round(m["trust_pct_of_volume"])
        r["metrics"]["foreign_pct_of_market"] = _round(m.get("foreign_pct_of_market"))
        r["metrics"]["trust_pct_of_market"] = _round(m.get("trust_pct_of_market"))

        r["foreign_note"] = fomo_score.foreign_annotation(m)
        r["trust_note"] = fomo_score.trust_annotation(m)


def _round(v, n=2):
    return None if v is None else round(v, n)


def _strip_ts(blob):
    out = dict(blob)
    out.pop("generated_at", None)
    return out


if __name__ == "__main__":
    sys.exit(main())
