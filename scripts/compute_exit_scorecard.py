#!/usr/bin/env python3
"""
出場記分板(2026-09-18 加入)。每天跟訊號記分板一起跑,純讀檔不打 API。

起因:進場訊號有記分板(39,000+ 筆、兩組基準)驗證過,結論是「一年樣本下沒有
一個量價訊號有方向優勢」;但出場規則(獲利 4.5%、固定停損、ATR 停損、最大回撤)
只在 2026-09-15 用 backtest_exit_rules.py 一次性跑過,沒有每天累積的驗證管道。
使用者 2026-09-17 說「跟著散戶一起抬轎,然後有紀律地下車」——下車那半邊需要
跟進場同等級的數字,這支就是那條管道。

做法:模擬器直接 import scripts/backtest_exit_rules.py 的 atr_at_entry() /
simulate_fixed_stop() / simulate_atr_stop()(照抄驗證過的版本,不重打),再加
獲利目標、最大回撤、目標+停損組合三種。每一條規則都跟「同一筆樣本、抱到天期
收盤」配對比較(paired),value_add = 規則報酬 − 抱到底報酬——同一檔同一天配對,
加權指數/中位股哪個當基準的問題在這裡不存在,基準偏誤會互相抵消。

模擬假設(跟 CLAUDE.md 第 5 節「假設成交價存 exit_result、不處理跳空」一致):
  - 進場 = 訊號日收盤價,方向 = SIGNAL_DEFS 的 dir(看空全部鏡射)。
  - 獲利目標:目標價 = 進場 × (1 + dir×t%),之後每天看最高價(看空看最低價)
    碰到就用目標價出場。
  - 最大回撤:期間峰值(多看最高、空看最低)逐日更新,回落 d% 就用回撤價出場。
  - 目標+停損:同一天兩個都碰到時停損贏(跟前端 evalExitPlan 的 alert 順序一致)。
  - 沒觸發就抱到天期(5/10/20 日)收盤。app 的 trail 模式(先漲到門檻才啟動、
    用量/MA5 出場)太依賴逐日量,這裡沒模擬。
輸出 data/exit-scorecard-latest.json,前端「出場記分板」分頁讀這支。
"""

import datetime as dt
import statistics
import sys

import common
import compute_scorecard as sc
import backtest_exit_rules as ber

# 規則清單(門檻都是 app 目前用的預設/教科書值,這裡只驗證、不調參)
STOP_PCT = 8.0          # 固定停損 %(backtest_exit_rules 預設)
ATR_MULT = 2.5          # ATR 停損倍數(app 的 trail 附帶 ATR 停損同一個數字)
TARGET_PCT = 4.5        # 獲利目標 %(app「+ 追蹤」預設 exit_plan target_pct)
DRAWDOWN_PCT = 5.0      # 最大回撤 %(app 的 max_drawdown_pct 沒預設值,取常見經驗值)

RULE_DEFS = [
    ("hold", "抱到天期收盤(基準)"),
    ("profit_target", "獲利目標 %.1f%%" % TARGET_PCT),
    ("fixed_stop", "固定停損 %.1f%%" % STOP_PCT),
    ("profit_and_stop", "目標 %.1f%% + 停損 %.1f%%" % (TARGET_PCT, STOP_PCT)),
    ("atr_stop", "ATR 停損 %.1f×" % ATR_MULT),
    ("max_drawdown", "最大回撤 %.1f%%" % DRAWDOWN_PCT),
]


def _hold_return(prices, dates, pos, sid, dir_, c0, horizon):
    if pos + horizon >= len(dates):
        return None
    c1 = (prices.get(dates[pos + horizon]) or {}).get(sid, {}).get("close")
    if not c1:
        return None
    return dir_ * (c1 - c0) / c0 * 100.0


def simulate_profit_target(prices, dates, pos, sid, dir_, c0, target_pct, horizon, stop_pct=None):
    """獲利目標(可選同時掛固定停損;同日兩者都碰到時停損贏)。回傳 (報酬, 觸發天數或 None)。"""
    target_price = c0 * (1 + dir_ * target_pct / 100.0)
    stop_price = c0 * (1 - dir_ * stop_pct / 100.0) if stop_pct else None
    limit = min(pos + horizon, len(dates) - 1)
    for j in range(pos + 1, limit + 1):
        row = (prices.get(dates[j]) or {}).get(sid)
        if not row or row.get("high") is None or row.get("low") is None:
            continue
        if stop_price is not None:
            stopped = (row["low"] <= stop_price) if dir_ > 0 else (row["high"] >= stop_price)
            if stopped:
                return dir_ * (stop_price - c0) / c0 * 100.0, j - pos
        reached = (row["high"] >= target_price) if dir_ > 0 else (row["low"] <= target_price)
        if reached:
            return dir_ * (target_price - c0) / c0 * 100.0, j - pos
    r = _hold_return(prices, dates, pos, sid, dir_, c0, horizon)
    return (r, None) if r is not None else (None, None)


def simulate_max_drawdown(prices, dates, pos, sid, dir_, c0, dd_pct, horizon):
    """期間峰值回落 dd% 出場(峰值從進場價開始、逐日用最高/最低價更新)。"""
    peak = c0
    limit = min(pos + horizon, len(dates) - 1)
    for j in range(pos + 1, limit + 1):
        row = (prices.get(dates[j]) or {}).get(sid)
        if not row or row.get("high") is None or row.get("low") is None:
            continue
        peak = max(peak, row["high"]) if dir_ > 0 else min(peak, row["low"])
        exit_price = peak * (1 - dir_ * dd_pct / 100.0)
        breached = (row["low"] <= exit_price) if dir_ > 0 else (row["high"] >= exit_price)
        if breached:
            return dir_ * (exit_price - c0) / c0 * 100.0, j - pos
    r = _hold_return(prices, dates, pos, sid, dir_, c0, horizon)
    return (r, None) if r is not None else (None, None)


def run(prices, dates, instances, horizons):
    pos_of = {d: i for i, d in enumerate(dates)}
    out = {}   # sig -> h -> rule -> list of (hold_ret, rule_ret, trigger_day or None)
    meta = {}  # sig -> instances / first / last
    for it in instances:
        sig, d, sid, dir_ = it["signal"], it["date"], it["stock_id"], it["dir"]
        m = meta.setdefault(sig, {"instances": 0, "first_date": None, "last_date": None})
        m["instances"] += 1
        m["first_date"] = d if m["first_date"] is None or d < m["first_date"] else m["first_date"]
        m["last_date"] = d if m["last_date"] is None or d > m["last_date"] else m["last_date"]
        pos = pos_of.get(d)
        if pos is None:
            continue
        row0 = (prices.get(d) or {}).get(sid)
        c0 = row0.get("close") if row0 else None
        if not c0:
            continue
        atr = ber.atr_at_entry(prices, dates, pos, sid)
        for h in horizons:
            hold = _hold_return(prices, dates, pos, sid, dir_, c0, h)
            if hold is None:
                continue
            results = {
                "hold": (hold, None),
                "profit_target": simulate_profit_target(prices, dates, pos, sid, dir_, c0, TARGET_PCT, h),
                "fixed_stop": ber.simulate_fixed_stop(prices, dates, pos, sid, dir_, c0, STOP_PCT, h),
                "profit_and_stop": simulate_profit_target(prices, dates, pos, sid, dir_, c0, TARGET_PCT, h, STOP_PCT),
                "max_drawdown": simulate_max_drawdown(prices, dates, pos, sid, dir_, c0, DRAWDOWN_PCT, h),
            }
            if atr is not None and atr > 0:
                results["atr_stop"] = ber.simulate_atr_stop(prices, dates, pos, sid, dir_, c0, atr, ATR_MULT, h)
            for rule, (ret, trig) in results.items():
                if ret is None:
                    continue
                out.setdefault(sig, {}).setdefault(h, {}).setdefault(rule, []).append((hold, ret, trig))
    return out, meta


def summarize_rule(samples, horizon):
    n = len(samples)
    if n == 0:
        return {"n": 0, "enough": False}
    hold = [s[0] for s in samples]
    rule = [s[1] for s in samples]
    va = [r - hd for hd, r, _ in samples]
    trig = [s[2] for s in samples if s[2] is not None]
    days = [s[2] if s[2] is not None else horizon for s in samples]
    return {
        "n": n,
        "enough": n >= common.SCORECARD_MIN_N,
        "trigger_rate": round(len(trig) / n * 100, 1),
        "avg_hold_days": round(statistics.fmean(days), 1),
        "avg_rule": round(statistics.fmean(rule), 2),
        "median_rule": round(statistics.median(rule), 2),
        "hit_rate_rule": round(sum(1 for x in rule if x > 0) / n * 100, 1),
        "avg_hold": round(statistics.fmean(hold), 2),
        "hit_rate_hold": round(sum(1 for x in hold if x > 0) / n * 100, 1),
        "avg_value_add": round(statistics.fmean(va), 2),
        "median_value_add": round(statistics.median(va), 2),
        "beat_hold_rate": round(sum(1 for x in va if x > 0) / n * 100, 1),
        "worst_rule": round(min(rule), 2),
        "worst_hold": round(min(hold), 2),
    }


def build(prices, dates, instances):
    horizons = list(sc.HORIZONS)
    raw, meta = run(prices, dates, instances, horizons)
    signals = {}
    for sig, m in meta.items():
        sdef = sc.SIGNAL_DEFS[sig]
        rules = {}
        for rule, label in RULE_DEFS:
            rules[rule] = {"label": label,
                           "horizons": {str(h): summarize_rule(raw.get(sig, {}).get(h, {}).get(rule, []), h)
                                        for h in horizons}}
        signals[sig] = {"label": sdef["label"], "direction": sdef["dir_label"], "dir": sdef["dir"],
                        "instances": m["instances"], "first_date": m["first_date"], "last_date": m["last_date"],
                        "rules": rules}
    return signals


def main():
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    instances = sc.load_signal_instances()
    signals = build(prices, dates, instances)
    result = {
        "date": dates[-1],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "params": {
            "horizons": list(sc.HORIZONS), "min_n": common.SCORECARD_MIN_N,
            "rules": [{"key": k, "label": lb} for k, lb in RULE_DEFS],
            "stop_pct": STOP_PCT, "atr_mult": ATR_MULT, "target_pct": TARGET_PCT, "drawdown_pct": DRAWDOWN_PCT,
            "definition": ("進場 = 訊號日收盤,方向照訊號 dir;每條規則跟同一筆樣本「抱到天期收盤」配對,"
                           "value_add = 規則報酬 − 抱到底報酬(同檔同日配對,基準偏誤互相抵消);"
                           "觸發用當日最高/最低價、成交在規則價、不處理跳空;同日目標+停損都碰到時停損贏"),
        },
        "coverage": {"price_days": len(dates), "price_from": dates[0], "price_to": dates[-1],
                     "instances": len(instances)},
        "signals": signals,
    }
    common.write_json(common.EXIT_SCORECARD_FILE, result)
    print("== 出場記分板 %s:價格 %d 天、訊號 %d 筆 ==" % (dates[-1], len(dates), len(instances)))
    for sig, s in signals.items():
        for rule, _ in RULE_DEFS:
            st = s["rules"][rule]["horizons"]["10"]
            if st["n"]:
                print("  %-9s %-20s 10d n=%-5d 觸發%5.1f%% 規則avg%+6.2f%% 抱到底%+6.2f%% value_add%+5.2f%% 贏過抱到底%5.1f%%"
                      % (sig, s["rules"][rule]["label"], st["n"], st["trigger_rate"], st["avg_rule"],
                         st["avg_hold"], st["avg_value_add"], st["beat_hold_rate"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
