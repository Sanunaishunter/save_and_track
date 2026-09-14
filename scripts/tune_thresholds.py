#!/usr/bin/env python3
"""
門檻掃描工具(2026-09-14 加入)。純 CLI、不寫回任何 data/ 檔案、不打 API。

用途:回答「爆量門檻 vol_ratio 1.5 改成 2.0 / 2.5 / 3.0,之後 N 日的命中率會不會
變好」這種問題。直接用永久存檔(data/archive/prices)重新掃一遍歷史,不是讀
data/scans(那份只有 1.5 以上的),所以每個候選門檻都是同一份原始資料算出來的。

  python scripts/tune_thresholds.py --signal scan  --values 1.5,2,2.5,3 --horizon 10
  python scripts/tune_thresholds.py --signal crash --values 1.5,2,2.5,3 --horizon 5

規矩(跟記分板一樣):
  - 樣本 < 60 的列印「樣本不足」,不要拿來下結論
  - 一次只動一個參數;調完之後要用調整期之後的新資料再驗一次,不然就是過擬合
  - 這支工具只告訴你歷史上哪個門檻命中率高,不保證未來;命中率高但樣本數掉太多
    (訊號變得很稀少)也不一定比較好用
"""

import argparse
import sys

import common
import compute_scorecard as sc


def rescan(prices, dates, threshold, direction, min_volume=common.MIN_VOLUME_SHARES,
           ma_window=common.MA_WINDOW):
    """用指定 vol_ratio 門檻重掃整段存檔。direction +1 = 爆量(close>open),
    −1 = 暴跌(close<open)。回傳 instances(跟 compute_scorecard 同格式)。"""
    inst = []
    for pos in range(ma_window, len(dates)):
        today = prices.get(dates[pos]) or {}
        prior = [prices.get(dates[i]) or {} for i in range(pos - ma_window, pos)]
        for sid, cur in today.items():
            vols = [d[sid]["volume"] for d in prior if sid in d and d[sid].get("volume") is not None]
            if len(vols) < ma_window:
                continue
            ma = sum(vols) / float(len(vols))
            if ma <= 0 or cur.get("volume") is None or cur.get("close") is None or cur.get("open") is None:
                continue
            vr = cur["volume"] / ma
            if vr <= threshold or cur["volume"] < min_volume:
                continue
            if direction > 0 and not (cur["close"] > cur["open"]):
                continue
            if direction < 0 and not (cur["close"] < cur["open"]):
                continue
            inst.append({"signal": "scan" if direction > 0 else "crash", "date": dates[pos],
                         "stock_id": sid, "dir": direction, "vol_ratio": vr,
                         "foreign_consec": None, "margin_consec": None})
    return inst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal", choices=["scan", "crash"], default="scan")
    ap.add_argument("--values", default="1.5,2,2.5,3,4", help="要試的 vol_ratio 門檻,逗號分隔")
    ap.add_argument("--horizon", type=int, choices=list(sc.HORIZONS), default=10)
    args = ap.parse_args()

    prices, dates = common.load_archive_prices()
    if len(dates) < common.MA_WINDOW + args.horizon + 1:
        print("資料只有 %d 個交易日,MA20 + %d 日天期至少要 %d 天,先讓存檔多累積幾天。"
              % (len(dates), args.horizon, common.MA_WINDOW + args.horizon + 1))
        return 1
    index_days = sc.load_index_days()
    events = sc.load_events()
    direction = 1 if args.signal == "scan" else -1
    values = [float(v) for v in args.values.split(",") if v.strip()]

    print("== %s 門檻掃描,天期 %d 日,存檔 %s ~ %s(%d 天)==" %
          ("爆量" if direction > 0 else "暴跌", args.horizon, dates[0], dates[-1], len(dates)))
    print("  %-8s %6s %8s %8s %10s %10s  %s" % ("門檻", "訊號數", "到期n", "命中%", "平均超額%", "中位超額%", "判讀"))
    for v in values:
        inst = rescan(prices, dates, v, direction)
        signals = sc.build_scorecard(inst, prices, dates, index_days, events)
        s = signals.get(args.signal)
        if not s:
            print("  %-8s %6d  (沒有訊號)" % (v, 0))
            continue
        st = s["horizons"][str(args.horizon)]
        verdict = "樣本不足(<%d)" % common.SCORECARD_MIN_N if not st.get("enough") else "可比較"
        print("  %-8s %6d %8d %8s %10s %10s  %s" % (
            v, s["instances"], st["n"], st.get("hit_rate"), st.get("avg_excess"),
            st.get("median_excess"), verdict))
    print("\n提醒:只動這一個參數;命中率高但訊號數掉很多不一定比較好用;"
          "調完要用之後的新資料再驗一次。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
