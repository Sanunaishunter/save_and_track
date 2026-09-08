#!/usr/bin/env python3
"""
一次性測試(2026-09-08):把個股查詢的三個標記(🔽量縮 / 🔔量縮轉買 /
🔻外資出貨)套用到 FOMO + 暴跌FOMO 候選名單裡隨機抽的 N 檔,看批次規模
可不可行、輸出格式好不好用。用完即刪(如果決定做成正式排程,會另外
寫一支真正的 compute_*.py,不是沿用這支)。

不寫回任何 data/ 檔案,純粹印出來給 Hugo 在 Actions log 看結果。

開高低收量用 data/history(免費,TWSE),外資投信買賣超用 FinMind
TaiwanStockInstitutionalInvestorsBuySell——三個標記都用不到融資融券,
所以只打這一種 dataset,一檔 1 次呼叫,不是個股查詢原本的 2 次。

三個判斷邏輯是 js/app.js 的 computeLookupShrinkDays / computeLookupBreakouts /
computeLookupSelloffDays 原封不動搬過來的 Python 版,常數要跟前端保持一致
(PEAK_WINDOW/LOOKBACK/MIN_SHRINK/SHRINK_RATIO/SURGE_MULT/SELLOFF_DROP_PCT),
改一邊要記得改另一邊,不然前端表格跟這支批次腳本會對不起來。
"""

import argparse
import datetime as dt
import os
import random
import sys
import time

import common
import finmind_api as fm
from fetch_stock_lookup import build_rows

# ---------------------------------------------------------------- 三個標記的判斷邏輯
# 跟 js/app.js 的常數必須一致,見上面的檔案說明。

PEAK_WINDOW = 10
LOOKBACK = 5
MIN_SHRINK = 3
SHRINK_RATIO = 0.6
SURGE_MULT = 1.2
SELLOFF_DROP_PCT = -4


def vol_ratios(rows):
    vols = [r["volume"] for r in rows]
    out = []
    for i, v in enumerate(vols):
        frm = i - PEAK_WINDOW
        if frm < 0 or v is None:
            out.append(None)
            continue
        seg = vols[frm:i]
        if any(x is None for x in seg):
            out.append(None)
            continue
        peak = max(seg)
        out.append(v / peak if peak else None)
    return out


def shrink_days(rows):
    ratios = vol_ratios(rows)
    out = {}
    for i, ratio in enumerate(ratios):
        if ratio is not None and ratio < SHRINK_RATIO:
            out[rows[i]["date"]] = {"ratio": ratio}
    return out


def breakout_days(rows):
    vols = [r["volume"] for r in rows]
    ratios = vol_ratios(rows)
    out = {}
    for i in range(LOOKBACK, len(rows)):
        lo = i - LOOKBACK
        shrink_count = 0
        window_vols = []
        ok = True
        for j in range(lo, i):
            if ratios[j] is None:
                ok = False
                break
            window_vols.append(vols[j])
            if ratios[j] < SHRINK_RATIO:
                shrink_count += 1
        if not ok or shrink_count < MIN_SHRINK:
            continue

        r = rows[i]
        fn, tn = r.get("foreign_net"), r.get("trust_net")
        if fn is None or tn is None or not (fn > 0 and tn > 0) or vols[i] is None:
            continue

        avg_window = sum(window_vols) / len(window_vols)
        if not avg_window:
            continue
        surge = vols[i] / avg_window
        if surge < SURGE_MULT:
            continue

        out[r["date"]] = {"shrink_count": shrink_count, "surge_mult": surge}
    return out


def selloff_days(rows):
    out = {}
    for r in rows:
        o, c, fn = r.get("open"), r.get("close"), r.get("foreign_net")
        if o is None or c is None or fn is None or fn >= 0:
            continue
        chg = (c - o) / o * 100.0
        if chg <= SELLOFF_DROP_PCT:
            out[r["date"]] = {"chg_pct": chg, "foreign_net": fn}
    return out


# ---------------------------------------------------------------- 候選池:FOMO + 暴跌FOMO

def taipei_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date()


def load_candidate_pool():
    """FOMO + 暴跌FOMO 目前的候選名單合併,{code: name}。"""
    pool = {}
    for fname in ("fomo-latest.json", "crash-fomo-latest.json"):
        data = common.read_json(os.path.join(common.DATA_DIR, fname)) or {}
        for row in data.get("rows") or []:
            sid = str(row.get("stock_id") or "").strip()
            if sid:
                pool[sid] = row.get("stock_name") or ""
    return pool


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--seed", type=str, default="")   # 空字串 = 不指定,每次不同
    args = ap.parse_args()
    seed = int(args.seed) if args.seed.strip() else None

    pool = load_candidate_pool()
    if not pool:
        print("錯誤:fomo-latest.json / crash-fomo-latest.json 都是空的,"
              "抽不出候選名單", file=sys.stderr)
        return 1

    codes_all = sorted(pool.keys())
    rng = random.Random(seed)
    codes = rng.sample(codes_all, min(args.limit, len(codes_all)))

    history_dates = common.history_dates()
    if not history_dates:
        print("錯誤:data/history 沒有任何資料", file=sys.stderr)
        return 1

    end = taipei_today()
    start = end - dt.timedelta(days=60)
    start_s, end_s = start.isoformat(), end.isoformat()

    print("== 量縮系列標記批次測試 ==")
    print("  候選池(FOMO+暴跌FOMO 去重):%d 檔,隨機抽 %d 檔:%s"
          % (len(codes_all), len(codes), "、".join(codes)))
    cap = 600 if fm.has_token() else 300
    print("  預估 API 呼叫:%d 次(上限 %d 次/小時,只打 1 種 dataset)" % (len(codes), cap))

    shrink_hits = []    # [(code, name, date, ratio)]
    breakout_hits = []  # [(code, name, date, shrink_count, surge_mult)]
    selloff_hits = []   # [(code, name, date, chg_pct, foreign_net)]
    failures = []

    print("\n== 逐檔抓取(僅 TaiwanStockInstitutionalInvestorsBuySell)==")
    for i, sid in enumerate(codes, 1):
        name = pool.get(sid, "")
        try:
            inst = fm.request("TaiwanStockInstitutionalInvestorsBuySell", sid, start_s, end_s)
        except fm.FinMindError as e:
            print("  [%d/%d] %s %-6s 抓取失敗:%s" % (i, len(codes), sid, name, e))
            failures.append({"stock_id": sid, "error": str(e)})
            continue
        time.sleep(0.25)

        rows = build_rows(sid, history_dates, [], inst)

        s = shrink_days(rows)
        b = breakout_days(rows)
        so = selloff_days(rows)
        for d, v in s.items():
            shrink_hits.append((sid, name, d, v["ratio"]))
        for d, v in b.items():
            breakout_hits.append((sid, name, d, v["shrink_count"], v["surge_mult"]))
        for d, v in so.items():
            selloff_hits.append((sid, name, d, v["chg_pct"], v["foreign_net"]))

        print("  [%d/%d] %s %-6s %d 列  量縮 %d 天、量縮轉買 %d 天、外資出貨 %d 天"
              % (i, len(codes), sid, name, len(rows), len(s), len(b), len(so)))

    print("\n== 🔻外資出貨(跌幅 <= %s%%、外資賣超)共 %d 筆 ==" % (SELLOFF_DROP_PCT, len(selloff_hits)))
    for sid, name, d, chg, fn in sorted(selloff_hits, key=lambda x: x[2]):
        print("  %s %-6s %s  跌幅 %.2f%%  外資賣超 %s 股" % (sid, name, d, chg, format(int(abs(fn)), ",")))

    print("\n== 🔽量縮(量/近期高點 < %s)共 %d 筆 ==" % (SHRINK_RATIO, len(shrink_hits)))
    for sid, name, d, ratio in sorted(shrink_hits, key=lambda x: x[2]):
        print("  %s %-6s %s  比值 %.2f" % (sid, name, d, ratio))

    print("\n== 🔔量縮轉買(量縮後外資投信同步買超+量增)共 %d 筆 ==" % len(breakout_hits))
    for sid, name, d, cnt, surge in sorted(breakout_hits, key=lambda x: x[2]):
        print("  %s %-6s %s  量縮 %d/5 天  量增 %.2f 倍" % (sid, name, d, cnt, surge))

    if failures:
        print("\n== 抓取失敗 %d 檔 ==" % len(failures))
        for f in failures:
            print("  %s: %s" % (f["stock_id"], f["error"]))

    print("\n完成。Claude Code 會直接讀這次 Actions run 的 log。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
