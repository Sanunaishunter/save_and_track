#!/usr/bin/env python3
"""
抓「籌碼/風險」新分頁要用的五份資料,寫進 data/risk-latest.json:
大盤成交資訊、注意股、融資融券餘額、停資停券預告、除權除息預告。

跟七步驟、爆量/FOMO/產業流向/部位/持倉/Kelly/定期定額/題材分類都無關,單純
是使用者想看這幾份 TWSE 公開資料而加的獨立分頁,不影響任何既有邏輯。

exchangeReport/TWT84U(股價升降幅度)探測過但沒有採用 —— 原本想拿「官方
漲跌停旗標」,但實測 Today/PreviousDay 兩組欄位在跨日時的對應關係無法
從單次探測完全驗證(PreviousDayLimitUp 用 ±10% 反推對不起來,可能牽涉
盤中基準價重設的規則,沒把握就不能拿來用),而且單次回應近 10MB
(34,128 筆,含所有權證/ETF/牛熊證)。改成用現有 quotes-latest.json 的
close/prev_close,套用公開的漲跌幅度 ±10% + 檔位捨入規則自己算,一樣能
判斷當日是否鎖漲跌停,且完全不用多打一次 API —— 用 3518 的真實案例
(8/31 收盤 28.55、9/1 收盤 31.4)手算驗證過,算出的漲停價跟實際收盤價
一致。這個計算放在前端(js/app.js),不需要另外的資料檔。

抓失敗的個別資料來源沿用既有檔案的對應欄位,不清空;全部都失敗才回傳
失敗(exit 1)。
"""

import datetime as dt
import sys

import common
import twse_api

TAIPEI = dt.timezone(dt.timedelta(hours=8))
SOURCES = 5


def today_str():
    return dt.datetime.now(TAIPEI).date().isoformat()


def _filter_common(rows):
    return [r for r in rows if common.is_listed_common(r.get("code"), None)]


def main():
    prev = common.read_json(common.RISK_FILE) or {}
    out = dict(prev)
    errors = []

    try:
        out["market"] = twse_api.market_summary()
    except Exception as e:                     # noqa: BLE001 - 抓不到就沿用舊檔
        errors.append("大盤成交資訊:%r" % (e,))
        print("!! 大盤成交資訊抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    try:
        out["attention"] = twse_api.attention_stocks()
    except Exception as e:                     # noqa: BLE001
        errors.append("注意股:%r" % (e,))
        print("!! 注意股抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    try:
        margin = twse_api.margin_balance()
        out["margin"] = {c: v for c, v in margin.items() if common.is_listed_common(c, None)}
    except Exception as e:                     # noqa: BLE001
        errors.append("融資融券:%r" % (e,))
        print("!! 融資融券抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    try:
        out["suspension"] = _filter_common(twse_api.margin_suspension())
    except Exception as e:                     # noqa: BLE001
        errors.append("停資停券預告:%r" % (e,))
        print("!! 停資停券預告抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    try:
        out["exdividend"] = _filter_common(twse_api.exdividend_calendar())
    except Exception as e:                     # noqa: BLE001
        errors.append("除權除息預告:%r" % (e,))
        print("!! 除權除息預告抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    out["date"] = today_str()
    out["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    common.write_json(common.RISK_FILE, out, compact=True)
    print("已寫入 %s(市場 %d 筆、注意股 %d 檔、融資融券 %d 檔、"
          "停資停券 %d 檔、除權息 %d 檔)"
          % (common.RISK_FILE, len(out.get("market") or []), len(out.get("attention") or []),
             len(out.get("margin") or {}), len(out.get("suspension") or []),
             len(out.get("exdividend") or [])))

    return 1 if len(errors) == SOURCES else 0


if __name__ == "__main__":
    raise SystemExit(main())
