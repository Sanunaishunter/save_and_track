#!/usr/bin/env python3
"""
一次性 probe(用完即刪,結論寫進 data/README.md):MI_INDEX?date=&type=ALL
的回應裡,除了現有 twse_api.by_date() 在用的「每日收盤行情」個股表之外,
還有哪些 tables——要確認裡面有沒有大盤加權指數本身的開高低收、以及官方
公布的上漲/下跌/平盤家數,這樣「大盤 30 日追蹤表」才能有真正的指數
開高低收(不是現有 compute_market_grid.py 用 data/history 個股資料自算的
Turnover 代理值),不用再靠 FMTQIK(只回最近兩個交易日)。

用法:在 Actions runner 上跑,或本機能連 TWSE 的環境:
    python3 scripts/probe_market_index_history.py [YYYYMMDD]
不給日期就用 data/history 裡最新的一個交易日。

只印表格數量、每個表的欄位名稱、跟第一列樣本資料——不整包印出來
(4MB 太大),看得出表格結構就夠了。
"""

import datetime as dt
import json
import sys

import common
import twse_api


def probe_date(ymd):
    print("=" * 70)
    print("MI_INDEX date=%s" % ymd)
    print("=" * 70)

    last_err = None
    for tpl in twse_api.MI_INDEX_URLS:
        url = tpl % ymd
        try:
            payload = twse_api._get_json(url)
        except twse_api.TWSEError as e:
            last_err = e
            print("!! %s 失敗:%r" % (url, e))
            continue

        print("URL 成功:%s" % url)
        print("stat=%r" % payload.get("stat"))
        print("payload 頂層 keys: %s" % sorted(payload.keys()))

        tables = payload.get("tables") or []
        print("tables 數量: %d" % len(tables))
        for i, t in enumerate(tables):
            if not isinstance(t, dict):
                print("  [%d] 不是 dict,跳過: %r" % (i, type(t)))
                continue
            title = t.get("title") or t.get("subtitle") or t.get("name") or "(無標題欄位)"
            fields = t.get("fields") or []
            data = t.get("data") or []
            print("  [%d] title=%r" % (i, title))
            print("      fields=%r" % (fields,))
            print("      列數=%d" % len(data))
            if data:
                print("      第一列樣本=%r" % (data[0],))
            # 特別標記可能是「大盤指數本身」或「漲跌家數統計」的表,
            # 用欄位名稱裡有沒有這些關鍵字粗略篩一下,方便人眼掃描 log。
            joined = "".join(fields)
            hints = []
            if any(k in joined for k in ("加權指數", "發行量加權")):
                hints.append("可能是大盤指數表")
            if any(k in joined for k in ("上漲", "下跌", "持平", "漲跌家數")):
                hints.append("可能是漲跌家數統計表")
            if hints:
                print("      *** 疑似目標表: %s ***" % "、".join(hints))

        # 第一輪已經確認 table[0]/[6]/[7] 大概是什麼,這輪把三張表的完整內容
        # 印出來——要找到「發行量加權股價指數」在 table[0] 裡的確切列,
        # 跟 table[6]/[7] 的完整數字(筆數不多,17/5 列,全印出來沒問題),
        # 才能照這裡的真實欄位動手寫正式的計算腳本,不用再猜一次。
        print()
        print("---- 完整內容(第二輪細看用)----")
        for i in (0, 6, 7):
            if i >= len(tables):
                continue
            t = tables[i]
            if not isinstance(t, dict):
                continue
            print("  == table[%d] title=%r ==" % (i, t.get("title")))
            print("     fields=%r" % (t.get("fields") or [],))
            for row in t.get("data") or []:
                print("     %r" % (row,))
        return
    raise twse_api.TWSEError("MI_INDEX 兩條路徑都失敗:%s" % last_err)


def main():
    if len(sys.argv) > 1:
        ymd = sys.argv[1]
    else:
        dates = common.history_dates()
        if not dates:
            print("data/history 沒有任何資料,且沒有指定日期參數,無法決定要查哪天", file=sys.stderr)
            return 1
        ymd = dates[-1].replace("-", "")

    try:
        probe_date(ymd)
    except twse_api.TWSEError as e:
        print("!! probe 失敗:%r" % (e,), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
