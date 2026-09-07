#!/usr/bin/env python3
"""
個股查詢:手動維護的股票代號清單(repo 根目錄的 stock_lookup.json,
跟 FOMO 用的 watchlist.json 同一種維護方式 —— 想深入看哪一檔,直接把
代號加進清單,下次排程或手動觸發 Actions 之後就有資料)。

每檔股票組一張最近 N 個交易日的逐日大表格:開高低收量 + 融資融券餘額
(含日增減) + 外資/投信買賣超。

開高低收量直接用 data/history(TWSE,免費,爆量/暴跌掃描也在用),
不再打 FinMind —— 一來這份資料本來就有,二來 FinMind TaiwanStockPrice
的開高低欄位名稱這個專案還沒探測驗證過(只驗證過 close/Trading_Volume,
FOMO 只需要這兩個),與其照文件猜欄位名稱,不如沿用已經在用、已經驗證
過的 TWSE 資料。

融資融券、外資投信這兩組只有 FinMind 有(TWSE 的 MI_MARGN 只給最新一天,
T86 雖然可以指定日期但還沒接歷史歸檔),而且這兩組欄位名稱已經在
compute_fomo.py 驗證過,直接沿用同一個 fm.request() 呼叫方式。

輸出 data/stock-lookup-latest.json,只留「最新」一份,不像爆量掃描
那樣另外存每日存查 —— 回頭看「某天的查詢清單長怎樣」沒有意義,
清單只會隨手動維護慢慢變動,不需要每日版本。

表格天數受 data/history 的保留天數(KEEP_DAYS,目前 30 天)限制,
融資融券/外資投信抓的日曆天window比這個寬,合併後只留 data/history
涵蓋到的交易日,確保每一列的開高低收量欄位都不是空的。
"""

import datetime as dt
import os
import sys
import time

import common
import finmind_api as fm
from compute_scan import load_day

STOCK_LOOKUP_FILE = os.path.join(common.ROOT, "stock_lookup.json")
LOOKUP_LATEST = os.path.join(common.DATA_DIR, "stock-lookup-latest.json")

DATASETS = ["TaiwanStockMarginPurchaseShortSale", "TaiwanStockInstitutionalInvestorsBuySell"]
LOOKBACK_CALENDAR_DAYS = 60  # data/history 只保留 30 個交易日,60 個日曆天當緩衝綽綽有餘


def taipei_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date()


def load_codes():
    codes = common.read_json(STOCK_LOOKUP_FILE)
    if not isinstance(codes, list) or not codes:
        raise SystemExit("錯誤:找不到 stock_lookup.json 或格式不是非空陣列")
    out = []
    for c in codes:
        c = str(c).strip()
        if c and c not in out:
            out.append(c)
    return out


def _num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _by_date(rows):
    return sorted([r for r in rows if r.get("date")], key=lambda r: r["date"])


def fetch_margin_and_inst(stock_id, start_date, end_date):
    margin = fm.request("TaiwanStockMarginPurchaseShortSale", stock_id, start_date, end_date)
    time.sleep(0.25)
    inst = fm.request("TaiwanStockInstitutionalInvestorsBuySell", stock_id, start_date, end_date)
    time.sleep(0.25)
    return margin, inst


def build_rows(stock_id, history_dates, margin_rows, inst_rows):
    """把 data/history(開高低收量)跟 FinMind(融資融券、法人)依日期合併。"""
    margins = {r["date"]: r for r in _by_date(margin_rows)}

    foreign_by_date, trust_by_date = {}, {}
    for r in inst_rows:
        d = r.get("date")
        name = str(r.get("name") or "")
        buy, sell = _num(r.get("buy")), _num(r.get("sell"))
        if not d or buy is None or sell is None:
            continue
        net = buy - sell
        if name == "Foreign_Investor":
            foreign_by_date[d] = net
        elif name == "Investment_Trust":
            trust_by_date[d] = net

    rows = []
    prev_margin = prev_short = None
    # margins/foreign/trust 的日曆天視窗比 history_dates 寬,但只要 prev_margin
    # 用「排序後遇到的上一筆」而不是「history 前一天」,增減量還是對的,
    # 不會因為 history 只留 30 天而在窗口第一天誤判成 None。
    all_margin_days = sorted(margins.keys())
    margin_before = {}
    running_m, running_s = None, None
    for d in all_margin_days:
        margin_before[d] = (running_m, running_s)
        mb = _num(margins[d].get("MarginPurchaseTodayBalance"))
        sb = _num(margins[d].get("ShortSaleTodayBalance"))
        if mb is not None:
            running_m = mb
        if sb is not None:
            running_s = sb

    for d in history_dates:
        cur = load_day(d).get(stock_id)
        m = margins.get(d, {})
        margin_bal = _num(m.get("MarginPurchaseTodayBalance"))
        short_bal = _num(m.get("ShortSaleTodayBalance"))
        prev_margin, prev_short = margin_before.get(d, (None, None))

        rows.append({
            "date": d,
            "open": cur.get("open") if cur else None,
            "high": cur.get("high") if cur else None,
            "low": cur.get("low") if cur else None,
            "close": cur.get("close") if cur else None,
            "volume": cur.get("volume") if cur else None,
            "margin_balance": margin_bal,
            "margin_change": (None if margin_bal is None or prev_margin is None
                              else margin_bal - prev_margin),
            "short_balance": short_bal,
            "short_change": (None if short_bal is None or prev_short is None
                             else short_bal - prev_short),
            "foreign_net": foreign_by_date.get(d),
            "trust_net": trust_by_date.get(d),
        })

    return rows


def main():
    codes = load_codes()
    history_dates = common.history_dates()
    if not history_dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    names = common.read_json(common.NAMES_FILE, {}) or {}

    end = taipei_today()
    start = end - dt.timedelta(days=LOOKBACK_CALENDAR_DAYS)
    start_s, end_s = start.isoformat(), end.isoformat()

    print("== 個股查詢:抓取融資融券 + 三大法人 ==")
    print("  清單:%s" % "、".join(codes))
    est = len(codes) * len(DATASETS)
    cap = 600 if fm.has_token() else 300
    print("  預估 API 呼叫:%d 次(上限 %d 次/小時)" % (est, cap))
    print("  區間:%s ~ %s,data/history 涵蓋 %d 個交易日(%s ~ %s)"
          % (start_s, end_s, len(history_dates), history_dates[0], history_dates[-1]))

    print("\n== 檢查資料源可用性 ==")
    report = fm.preflight(DATASETS, codes[0], start_s, end_s)
    blocked = []
    for ds in DATASETS:
        r = report[ds]
        if r["ok"]:
            print("  ✓ %-45s %d 筆  欄位=%s" % (ds, r["rows"], r["fields"]))
        else:
            print("  ✗ %-45s %s" % (ds, r["error"]))
            blocked.append(r["error"])
    if blocked:
        # FOMO/暴跌FOMO 排在這步前面,同一小時內把免費額度用光是正常會發生的事
        # (三支合計常態性超過 300 次/小時的上限),不是這支腳本本身壞了。
        # 額度用完就靜靜跳過、保留上一份資料,不要讓這種每天都可能發生的情況
        # 把整個 daily-scan job 標成失敗;其他原因(真的欄位跑掉之類)才視為
        # 需要人工處理的錯誤。
        if all("402" in b for b in blocked):
            print("\n額度用完(HTTP 402),今天先跳過個股查詢,保留上一份資料。"
                  "考慮設定 FINMIND_TOKEN 把額度從 300 次/小時提高到 600 次。")
            return 0
        print("\n錯誤:以下 dataset 取不到:\n  %s" % "\n  ".join(blocked), file=sys.stderr)
        return 1

    data = {}
    failures = []
    for i, sid in enumerate(codes, 1):
        try:
            margin, inst = fetch_margin_and_inst(sid, start_s, end_s)
        except fm.FinMindError as e:
            print("  [%d/%d] %s 抓取失敗:%s" % (i, len(codes), sid, e))
            failures.append({"stock_id": sid, "error": str(e)})
            continue
        rows = build_rows(sid, history_dates, margin, inst)
        data[sid] = {"stock_name": names.get(sid, ""), "rows": rows}
        print("  [%d/%d] %s %-6s %d 列" % (i, len(codes), sid, names.get(sid, ""), len(rows)))

    if not data:
        print("錯誤:一檔都沒算出來", file=sys.stderr)
        return 1

    result = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "history_range": {"from": history_dates[0], "to": history_dates[-1]},
        "codes": codes,
        "failures": failures,
        "data": data,
    }
    common.write_json(LOOKUP_LATEST, result)

    print("\n== 完成:%d 檔、失敗 %d ==" % (len(data), len(failures)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
