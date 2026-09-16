#!/usr/bin/env python3
"""
爆量訊號「反著用」驗證工具(2026-09-16 加入)。純 CLI、不寫回任何 data/ 檔案、不打 API。

訊號記分板 compute_scorecard.py 算出爆量(scan,dir=+1,看多延續)5 日命中率
29.6%、平均超額 −2.24%,遠低於亂猜的 50%——比骰子還慘代表訊號其實有資訊量,
只是方向可能押反了。這支工具直接沿用 compute_scorecard.py 已經驗證過的訊號
載入/報酬計算/分桶邏輯(load_signal_instances/forward_returns/regime_label/
summarize,原封不動 import,不重寫一份),只多算一件事:把 scan 的 dir 從
+1 改成 -1(訊號出現後放空,不是買進)重新算 hit_rate/超額報酬,看能不能把
「跑輸大盤」的訊號變成「跑贏大盤」的訊號,並依大盤狀態(regime)分桶,確認
這個反轉是全期間都成立,還是只集中在弱勢盤。

avg_excess/avg_raw 本身沒有乘方向(是原始的「個股 − 指數」報酬平均),所以
方向反過來時,「放空的預期報酬」= -avg_excess,不是重新抓一次資料算出來的
數字——但 hit_rate 是重新用 direction=-1 呼叫 summarize() 真的算出來的,兩者
一起看才不會誤判。

用法:python scripts/backtest_scan_fade.py
"""

import sys

import common
import compute_scorecard as sc


def fade_summary(samples, horizon_label):
    """samples: list of (raw, excess),direction=+1(原本看多)跟 -1(反著做/放空)
    都用同一批樣本重算,方便對照。"""
    long_stat = sc.summarize(samples, 1)
    short_stat = sc.summarize(samples, -1)
    avg_excess = long_stat.get("avg_excess")
    return {
        "horizon": horizon_label,
        "n": long_stat["n"],
        "enough": long_stat["enough"],
        "long_hit": long_stat.get("hit_rate"),
        "long_avg_excess": avg_excess,
        "short_hit": short_stat.get("hit_rate"),
        "short_avg_pnl": None if avg_excess is None else round(-avg_excess, 2),
    }


def main():
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    index_days = sc.load_index_days()
    instances = [it for it in sc.load_signal_instances() if it["signal"] == "scan"]
    if not instances:
        print("沒有任何爆量(scan)訊號可以測", file=sys.stderr)
        return 1

    pos_of = {d: i for i, d in enumerate(dates)}
    by_h = {h: [] for h in sc.HORIZONS}
    by_regime_h = {}
    for it in instances:
        pos = pos_of.get(it["date"])
        if pos is None:
            continue
        fr = sc.forward_returns(prices, dates, index_days, pos, it["stock_id"])
        if not fr:
            continue
        reg = sc.regime_label(index_days.get(it["date"]))
        for h, sample in fr.items():
            by_h[h].append(sample)
            by_regime_h.setdefault(reg, {h: [] for h in sc.HORIZONS})[h].append(sample)

    print("== 爆量(scan)訊號反著用(放空)回測 ==")
    print("訊號筆數 %d,價格 %s ~ %s(%d 天)\n" % (len(instances), dates[0], dates[-1], len(dates)))

    print("-- 全樣本,按天期 --")
    for h in sc.HORIZONS:
        s = fade_summary(by_h[h], "%d日" % h)
        if s["n"] == 0:
            continue
        flag = "" if s["enough"] else "(N<60,樣本不足,不能下結論)"
        print("  %-4s n=%-4d | 原本(看多)命中 %5s%% 平均超額 %6s%% "
              "| 反著做(放空)命中 %5s%% 平均預期報酬 %6s%% %s" % (
                  s["horizon"], s["n"], s["long_hit"], s["long_avg_excess"],
                  s["short_hit"], s["short_avg_pnl"], flag))

    print("\n-- 按訊號當天大盤狀態(regime)分桶,5 日天期 --")
    for reg, by_h_reg in sorted(by_regime_h.items(), key=lambda kv: -len(kv[1][5])):
        s = fade_summary(by_h_reg[5], reg)
        if s["n"] == 0:
            continue
        flag = "" if s["enough"] else "(N<60)"
        print("  %-10s n=%-4d | 看多命中 %5s%% 超額 %6s%% | 放空命中 %5s%% 預期報酬 %6s%% %s" % (
            reg, s["n"], s["long_hit"], s["long_avg_excess"], s["short_hit"], s["short_avg_pnl"], flag))

    print("\n※ 沒有算券商借券費、券源夠不夠、逐日盯市風險,純粹是「訊號方向對不對」"
          "的統計驗證,不是可以直接下單的策略。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
