#!/usr/bin/env python3
"""
抓「定期定額」排行統計,寫進 data/dca-latest.json。獨立分頁(跟七步驟、
爆量/FOMO/產業流向/部位無關),資料來源見 scripts/twse_api.py::dca_rank。

月報表才更新一次,但抓取成本只是免費的一次呼叫,跟著每日 workflow
一起做,不用另外設計排程頻率。抓失敗時沿用既有檔案,不清空。
"""

import datetime as dt
import sys

import common
import twse_api

TAIPEI = dt.timezone(dt.timedelta(hours=8))


def today_str():
    return dt.datetime.now(TAIPEI).date().isoformat()


def main():
    try:
        rows = twse_api.dca_rank()
    except Exception as e:                     # noqa: BLE001 - 抓不到就沿用舊檔
        print("!! 定期定額統計抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)
        return 1

    common.write_json(common.DCA_FILE, {
        "fetched_date": today_str(),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "note": "TWSE ETFReport/ETFRank 沒有月份欄位,fetched_date 只是抓取當天,"
                "不代表資料所屬月份",
        "count": len(rows),
        "rows": rows,
    })
    print("定期定額排行:%d 筆" % len(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
