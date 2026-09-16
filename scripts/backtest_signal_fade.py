#!/usr/bin/env python3
"""
訊號「反著用」驗證工具(2026-09-16 加入,原名 backtest_scan_fade.py,通用化後改名)。
純 CLI、不寫回任何 data/ 檔案、不打 API。

訊號記分板 compute_scorecard.py 算出爆量(scan,dir=+1看多)5 日命中率 29.6%、
遠低於亂猜的 50%——比骰子還慘代表訊號其實有資訊量,只是方向可能押反了。這支
工具直接沿用 compute_scorecard.py 已經驗證過的訊號載入/報酬計算/分桶邏輯
(load_signal_instances/forward_returns/regime_label/summarize,原封不動
import,不重寫一份),把某個訊號的 dir 反過來重新算 hit_rate/預期報酬,並依
大盤狀態(regime)分桶,確認反轉是全期間都成立還是只集中在特定盤勢。

**方向換算,不分訊號原本是看多還是看空都通用**:excess(個股報酬−指數同期
報酬)本身沒有乘方向;某個策略(看多或看空)的預期報酬 = 該策略方向(+1/−1)
× avg_excess。所以「反著做」的預期報酬永遠是「原本策略預期報酬」的正負號
相反——不是重新抓資料算出來的,是同一批 excess 樣本換一個方向解讀。hit_rate
則是真的用相反方向重新呼叫 summarize() 算出來的(不是用 100%−原命中率去猜,
因為 excess 剛好等於 0 的樣本兩邊都不算命中)。

用法:python scripts/backtest_signal_fade.py [scan|crash|fomo_real|fomo_fake|crashfomo_real|crashfomo_fake]
不帶參數預設 scan。
"""

import sys

import common
import compute_scorecard as sc


def fade_summary(samples, original_dir, horizon_label):
    """samples: list of (raw, excess)。original_dir 是這個訊號原本設計的方向
    (SIGNAL_DEFS 裡的 dir),反著做就是 -original_dir,兩邊都用同一批樣本重算。"""
    orig_stat = sc.summarize(samples, original_dir)
    fade_stat = sc.summarize(samples, -original_dir)
    avg_excess = orig_stat.get("avg_excess")
    orig_pnl = None if avg_excess is None else round(original_dir * avg_excess, 2)
    fade_pnl = None if orig_pnl is None else round(-orig_pnl, 2)
    return {
        "horizon": horizon_label,
        "n": orig_stat["n"],
        "enough": orig_stat["enough"],
        "orig_hit": orig_stat.get("hit_rate"),
        "orig_pnl": orig_pnl,
        "fade_hit": fade_stat.get("hit_rate"),
        "fade_pnl": fade_pnl,
    }


def main():
    sig = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if sig not in sc.SIGNAL_DEFS:
        print("不認得的訊號 %r,可用:%s" % (sig, ", ".join(sc.SIGNAL_DEFS.keys())), file=sys.stderr)
        return 1
    sdef = sc.SIGNAL_DEFS[sig]
    original_dir = sdef["dir"]
    orig_label = sdef["dir_label"]
    fade_label = "看空" if orig_label == "看多" else "看多"

    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    index_days = sc.load_index_days()
    instances = [it for it in sc.load_signal_instances() if it["signal"] == sig]
    if not instances:
        print("沒有任何%s(%s)訊號可以測" % (sdef["label"], sig), file=sys.stderr)
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

    print("== %s(%s)訊號反著用(原本%s → 反著做%s)回測 ==" % (sdef["label"], sig, orig_label, fade_label))
    print("訊號筆數 %d,價格 %s ~ %s(%d 天)\n" % (len(instances), dates[0], dates[-1], len(dates)))

    print("-- 全樣本,按天期 --")
    for h in sc.HORIZONS:
        s = fade_summary(by_h[h], original_dir, "%d日" % h)
        if s["n"] == 0:
            continue
        flag = "" if s["enough"] else "(N<60,樣本不足,不能下結論)"
        print("  %-4s n=%-4d | 原本(%s)命中 %5s%% 預期報酬 %6s%% "
              "| 反著做(%s)命中 %5s%% 預期報酬 %6s%% %s" % (
                  s["horizon"], s["n"], orig_label, s["orig_hit"], s["orig_pnl"],
                  fade_label, s["fade_hit"], s["fade_pnl"], flag))

    print("\n-- 按訊號當天大盤狀態(regime)分桶,5 日天期 --")
    for reg, by_h_reg in sorted(by_regime_h.items(), key=lambda kv: -len(kv[1][5])):
        s = fade_summary(by_h_reg[5], original_dir, reg)
        if s["n"] == 0:
            continue
        flag = "" if s["enough"] else "(N<60)"
        print("  %-10s n=%-4d | %s命中 %5s%% 預期報酬 %6s%% | %s命中 %5s%% 預期報酬 %6s%% %s" % (
            reg, s["n"], orig_label, s["orig_hit"], s["orig_pnl"],
            fade_label, s["fade_hit"], s["fade_pnl"], flag))

    print("\n※ 沒有算券商借券費/融券券源夠不夠/逐日盯市風險,純粹是「訊號方向對不對」"
          "的統計驗證,不是可以直接下單的策略。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
