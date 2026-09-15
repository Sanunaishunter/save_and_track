#!/usr/bin/env python3
"""
出場規則回測工具(2026-09-15 加入)。純 CLI、不寫回任何 data/ 檔案、不打 API。

起因:使用者問「教科書等級的固定停損 %、ATR 2.5 倍停損,會不會反而被抓短線的人
(『獨眼龍』)坑」。這支工具直接拿永久存檔(data/archive/prices)+ 既有訊號存查
(data/scans、data/crashes,跟記分板同一份)重算:如果訊號當天進場,套用「固定
停損 %」或「ATR 移動停損」,跟「完全不停損、抱到天期滿」比起來,實際報酬是變
好還是變差——用同一批樣本配對比較(paired),不是兩批不同樣本各自的平均數。

跟記分板/tune_thresholds.py 同一套規矩:
  - 樣本 < 60(common.SCORECARD_MIN_N)一律標「樣本不足」,不下結論
  - 一次只回答一個問題,不要把「調參數調到最好看」跟「驗證」搞混
  - 這裡的 ATR/固定停損模擬是「教科書標準用法」(從進場當天開始追蹤,沒有
    app.js 兵棋推演那個「先漲到啟動門檻才開始追」的前提),跟站上「移動停利」
    分頁看到的數字不是同一套,不要拿來對答案

模擬假設(跟 CLAUDE.md「假設成交價存 exit_result,不處理跳空」一致):
  - 固定停損:停損價 = 進場收盤價 × (1 − dir×stop_pct);之後每天檢查當天最低價
    (看空則檢查最高價)有沒有跌破(反彈突破),第一次觸發當天用停損價出場,
    不處理跳空穿越。
  - ATR 移動停損:進場當天用前 14 個交易日算 ATR(跟 js/app.js 的 atrValue() /
    TR = max(高−低, |高−前收|, |低−前收|) 同一個定義);期間峰值(多看最高、
    空看最低)逐日更新,停損價 = 峰值 − dir×2.5×ATR,一樣逐日檢查觸發。
  - 沒觸發就抱到天期(5/10/20 日)收盤,回傳 = dir×(收盤−進場)/進場×100。

用法:
  python scripts/backtest_exit_rules.py                         # 預設全部訊號、8% 固定停損、2.5×ATR
  python scripts/backtest_exit_rules.py --signal scan --stop-pct 6 --atr-mult 2
"""

import argparse
import statistics
import sys

import common
import compute_scorecard as sc

ATR_WINDOW = 14


def atr_at_entry(prices, dates, pos, sid, window=ATR_WINDOW):
    """進場當天(pos)往前算 ATR,跟 js/app.js atrValue() 同一個定義:
    day k=0 是進場前一天,prevClose 用再前一天的收盤。缺任何一天就回傳 None。"""
    if pos - window - 1 < 0:
        return None
    trs = []
    for k in range(window):
        day_row = (prices.get(dates[pos - 1 - k]) or {}).get(sid)
        prev_row = (prices.get(dates[pos - 2 - k]) or {}).get(sid)
        if not day_row or not prev_row:
            return None
        h, l, prev_close = day_row.get("high"), day_row.get("low"), prev_row.get("close")
        if h is None or l is None or prev_close is None:
            return None
        trs.append(max(h - l, abs(h - prev_close), abs(l - prev_close)))
    return sum(trs) / len(trs)


def simulate_fixed_stop(prices, dates, pos, sid, dir_, c0, stop_pct, horizon):
    stop_price = c0 * (1 - dir_ * stop_pct / 100.0)
    limit = min(pos + horizon, len(dates) - 1)
    for j in range(pos + 1, limit + 1):
        row = (prices.get(dates[j]) or {}).get(sid)
        if not row:
            continue
        breached = (row.get("low") is not None and row["low"] <= stop_price) if dir_ > 0 \
            else (row.get("high") is not None and row["high"] >= stop_price)
        if breached:
            return dir_ * (stop_price - c0) / c0 * 100.0, j - pos
    if pos + horizon >= len(dates):
        return None, None
    c1 = (prices.get(dates[pos + horizon]) or {}).get(sid, {}).get("close")
    if not c1:
        return None, None
    return dir_ * (c1 - c0) / c0 * 100.0, None


def simulate_atr_stop(prices, dates, pos, sid, dir_, c0, atr, atr_mult, horizon):
    peak = c0
    limit = min(pos + horizon, len(dates) - 1)
    for j in range(pos + 1, limit + 1):
        row = (prices.get(dates[j]) or {}).get(sid)
        if not row or row.get("high") is None or row.get("low") is None:
            continue
        peak = max(peak, row["high"]) if dir_ > 0 else min(peak, row["low"])
        stop_price = peak - dir_ * atr_mult * atr
        breached = (row["low"] <= stop_price) if dir_ > 0 else (row["high"] >= stop_price)
        if breached:
            return dir_ * (stop_price - c0) / c0 * 100.0, j - pos
    if pos + horizon >= len(dates):
        return None, None
    c1 = (prices.get(dates[pos + horizon]) or {}).get(sid, {}).get("close")
    if not c1:
        return None, None
    return dir_ * (c1 - c0) / c0 * 100.0, None


def run(prices, dates, instances, stop_pct, atr_mult, horizons):
    pos_of = {d: i for i, d in enumerate(dates)}
    out = {}  # signal -> horizon -> rule -> list of (paired_no_stop, rule_return, triggered)
    for it in instances:
        sig, d, sid, dir_ = it["signal"], it["date"], it["stock_id"], it["dir"]
        pos = pos_of.get(d)
        if pos is None:
            continue
        row0 = (prices.get(d) or {}).get(sid)
        c0 = row0.get("close") if row0 else None
        if not c0:
            continue
        atr = atr_at_entry(prices, dates, pos, sid)
        for h in horizons:
            if pos + h >= len(dates):
                continue
            c1 = (prices.get(dates[pos + h]) or {}).get(sid, {}).get("close")
            if not c1:
                continue
            no_stop = dir_ * (c1 - c0) / c0 * 100.0

            fixed_ret, fixed_trig = simulate_fixed_stop(prices, dates, pos, sid, dir_, c0, stop_pct, h)
            bucket = out.setdefault(sig, {}).setdefault(h, {}).setdefault("fixed_stop", [])
            if fixed_ret is not None:
                bucket.append((no_stop, fixed_ret, fixed_trig is not None))

            if atr is not None and atr > 0:
                atr_ret, atr_trig = simulate_atr_stop(prices, dates, pos, sid, dir_, c0, atr, atr_mult, h)
                bucket2 = out.setdefault(sig, {}).setdefault(h, {}).setdefault("atr_stop", [])
                if atr_ret is not None:
                    bucket2.append((no_stop, atr_ret, atr_trig is not None))
    return out


def summarize_rule(samples):
    n = len(samples)
    if n == 0:
        return None
    no_stop = [s[0] for s in samples]
    rule = [s[1] for s in samples]
    trig_n = sum(1 for s in samples if s[2])
    value_add = [r - ns for ns, r, _ in samples]
    return {
        "n": n,
        "enough": n >= common.SCORECARD_MIN_N,
        "trigger_rate_pct": round(trig_n / n * 100, 1),
        "avg_no_stop": round(statistics.fmean(no_stop), 2),
        "avg_rule": round(statistics.fmean(rule), 2),
        "hit_rate_no_stop_pct": round(sum(1 for x in no_stop if x > 0) / n * 100, 1),
        "hit_rate_rule_pct": round(sum(1 for x in rule if x > 0) / n * 100, 1),
        "avg_value_add": round(statistics.fmean(value_add), 2),
        "median_value_add": round(statistics.median(value_add), 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal", default="all",
                     choices=["all", "scan", "crash", "fomo_real", "fomo_fake", "crashfomo_real", "crashfomo_fake"])
    ap.add_argument("--stop-pct", type=float, default=8.0, help="固定停損 %(對進場收盤價)")
    ap.add_argument("--atr-mult", type=float, default=2.5, help="ATR 停損倍數")
    args = ap.parse_args()

    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料", file=sys.stderr)
        return 1

    instances = sc.load_signal_instances()
    if args.signal != "all":
        instances = [it for it in instances if it["signal"] == args.signal]

    horizons = list(sc.HORIZONS)
    result = run(prices, dates, instances, args.stop_pct, args.atr_mult, horizons)

    print("== 出場規則回測:固定停損 %.1f%%、ATR 停損 %.1f×ATR14,存檔 %s ~ %s(%d 天)==" %
          (args.stop_pct, args.atr_mult, dates[0], dates[-1], len(dates)))
    print("(數字是「報酬 %」,dir 已經算進去;不停損=抱到天期收盤;value_add = 停損規則 − 不停損,配對同一批樣本)\n")

    for sig in sorted(result.keys()):
        label = sc.SIGNAL_DEFS[sig]["label"]
        print("--- %s(%s) ---" % (sig, label))
        for h in horizons:
            for rule_key, rule_label in (("fixed_stop", "固定停損%.1f%%" % args.stop_pct),
                                          ("atr_stop", "ATR停損%.1f×" % args.atr_mult)):
                samples = result.get(sig, {}).get(h, {}).get(rule_key, [])
                st = summarize_rule(samples)
                if not st:
                    print("  %2d日 %-14s (沒有可用樣本)" % (h, rule_label))
                    continue
                verdict = "樣本不足(<%d)" % common.SCORECARD_MIN_N if not st["enough"] else \
                    ("停損比較好" if st["avg_value_add"] > 0 else "不停損比較好")
                print("  %2d日 %-14s n=%-4d 觸發率%5.1f%%  不停損avg%+6.2f%%(命中%4.1f%%)  "
                      "停損avg%+6.2f%%(命中%4.1f%%)  value_add %+5.2f%%(中位%+5.2f%%)  %s" % (
                          h, rule_label, st["n"], st["trigger_rate_pct"],
                          st["avg_no_stop"], st["hit_rate_no_stop_pct"],
                          st["avg_rule"], st["hit_rate_rule_pct"],
                          st["avg_value_add"], st["median_value_add"], verdict))
        print()

    print("提醒:value_add > 0 代表「這個天期、這批樣本」套用停損規則比完全不停損的平均報酬高"
          "(可能是躲過了更大跌幅),< 0 代表停損規則平均反而更差(可能是被洗出去、錯過了反彈)。"
          "樣本不足的格子不要下結論;訊號存查(data/scans 等)才 2 週多,10/20 日天期樣本會持續偏少,"
          "要等之後每天多存一天再回頭看。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
