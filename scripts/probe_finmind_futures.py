#!/usr/bin/env python3
"""
一次性 probe:FinMind 的期貨三大法人資料集(TaiwanFuturesInstitutionalInvestors),
確認能不能查到「外資期貨淨空單」、免費額度夠不夠用、欄位長怎樣、能不能查歷史區間
(這是跟 TAIFEX OpenAPI 互補的關鍵——TAIFEX 那支只回最新一天,FinMind 如果能查
歷史區間,歷史趨勢就不用等自己每天存)。

用完即刪,結論寫進 data/README.md。
"""

import sys

import finmind_api


def main():
    print("有沒有設定 FINMIND_TOKEN:", finmind_api.has_token())

    # 台指期貨的 FinMind data_id 慣例是 "TX",但沒有一手資料源確認,
    # 用 preflight() 直接打一次看回應,不要用猜的。
    candidates = [
        ("TaiwanFuturesInstitutionalInvestors", "TX"),
        ("TaiwanFuturesInstitutionalInvestors", None),
    ]

    for dataset, data_id in candidates:
        print("\n== dataset=%s data_id=%s ==" % (dataset, data_id))
        try:
            rows = finmind_api.request(
                dataset, data_id=data_id,
                start_date="2026-08-01", end_date="2026-09-05")
        except finmind_api.FinMindError as e:
            print("失敗:%r" % (e,))
            continue

        print("筆數:", len(rows))
        if rows:
            print("欄位:", sorted(rows[0].keys()))
            print("前三筆:")
            for r in rows[:3]:
                print(" ", r)
            print("最後一筆(看歷史查詢有沒有真的給到多天):")
            print(" ", rows[-1])
            dates = sorted(set(r.get("date") for r in rows if isinstance(r, dict)))
            print("涵蓋的日期數:", len(dates), "範圍:", dates[:1], "~", dates[-1:])

    return 0


if __name__ == "__main__":
    sys.exit(main())
