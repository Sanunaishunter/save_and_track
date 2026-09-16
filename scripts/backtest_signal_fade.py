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

用法:python scripts/backtest_signal_fade.py [訊號] [排除跟哪個訊號重疊]
第一個參數不帶預設 scan;第二個參數是選填的訊號名稱,同一天同一檔股票如果
兩個訊號都有觸發就從第一個訊號的樣本裡拿掉,拿來拆「這個訊號的優勢是不是
其實是另一個訊號的優勢」。例如 fomo_real 的候選股票本來就是從 scan(爆量)
前 60 名再篩出來的(見 load_signal_instances()),`python backtest_signal_fade.py
fomo_real scan` 就是把跟 scan 同一天同一檔重複的樣本拿掉,只看 fomo_real
「多篩了外資/融資連買 ≥3 天」這個額外條件、扣掉純爆量效果之後,還剩不剩優勢。
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
    exclude_sig = sys.argv[2] if len(sys.argv) > 2 else None
    if sig not in sc.SIGNAL_DEFS:
        print("不認得的訊號 %r,可用:%s" % (sig, ", ".join(sc.SIGNAL_DEFS.keys())), file=sys.stderr)
        return 1
    if exclude_sig is not None and exclude_sig not in sc.SIGNAL_DEFS:
        print("不認得要排除重疊的訊號 %r,可用:%s" % (exclude_sig, ", ".join(sc.SIGNAL_DEFS.keys())), file=sys.stderr)
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
    all_instances = sc.load_signal_instances()
    instances = [it for it in all_instances if it["signal"] == sig]
    if not instances:
        print("沒有任何%s(%s)訊號可以測" % (sdef["label"], sig), file=sys.stderr)
        return 1

    overlap_note = ""
    if exclude_sig:
        other_keys = {(it["date"], it["stock_id"]) for it in all_instances if it["signal"] == exclude_sig}
        before = len(instances)
        instances = [it for it in instances if (it["date"], it["stock_id"]) not in other_keys]
        removed = before - len(instances)
        overlap_note = "(排除跟 %s 同一天同一檔重疊的樣本:%d/%d 筆被拿掉,剩 %d 筆獨立樣本)" % (
            exclude_sig, removed, before, len(instances))
        if not instances:
            print("排除重疊後沒有任何獨立樣本可以測(%s 完全被 %s 涵蓋)" % (sig, exclude_sig), file=sys.stderr)
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
    print("訊號筆數 %d,價格 %s ~ %s(%d 天)%s\n" % (len(instances), dates[0], dates[-1], len(dates), overlap_note))

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
