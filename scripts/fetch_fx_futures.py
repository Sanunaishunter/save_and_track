#!/usr/bin/env python3
"""
匯率(央行開放資料)+ 台指期貨(TX)三大法人未平倉(FinMind):
data/fx-futures-latest.json。獨立分頁區塊,跟籌碼/風險其他部分、大盤
九宮格、題材分類都無關,放進「籌碼/風險」分頁。

探測過程見已刪除的 probe_fx_taifex.py / probe_finmind_futures.py,結論:
  - 央行 FTDOpenData_Day 一次回應就是全部歷史(西元日期字串),不用自己
    存,每天重新抓、切最近 KEEP_DAYS 筆即可
  - TAIFEX OpenAPI 的三大法人未平倉端點名字雖然是對的
    (MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate),
    但只回最新一個交易日,沒有歷史查詢
  - FinMind 的 TaiwanFuturesInstitutionalInvestors **免費額度就能查、
    有歷史區間**(實測查一個月拿到 25 個交易日),直接取代 TAIFEX 那支,
    不用自己每天存歷史檔。跟 fetch_stock_meta.py 一樣的坑:一定要帶
    data_id(這裡是 "TX",台指期貨),不帶會回 400「Your level is free」

只留「外資」这一類算净部位(多單未平倉 - 空單未平倉),是最多人看的期貨
籌碼指標;自營商/投信原始資料也一併存起來,以防之後要用。

抓失敗的個別來源沿用既有檔案的對應欄位,不清空;兩個都失敗才回傳失敗。
"""

import datetime as dt
import sys

import cbc_api
import common
import finmind_api

FUTURES_ID = "TX"
KEEP_DAYS = 30
TAIPEI = dt.timezone(dt.timedelta(hours=8))


def today_str():
    return dt.datetime.now(TAIPEI).date().isoformat()


def main():
    prev = common.read_json(common.FX_FUTURES_FILE) or {}
    out = dict(prev)
    errors = []

    try:
        fx_history = cbc_api.usd_twd_history(KEEP_DAYS)
        out["fx"] = {
            "date": fx_history[0]["date"] if fx_history else None,
            "rate": fx_history[0]["rate"] if fx_history else None,
            "prev_rate": fx_history[1]["rate"] if len(fx_history) > 1 else None,
            "history": fx_history,
        }
        print("匯率:%d 筆,最新 %s = %s" % (
            len(fx_history),
            fx_history[0]["date"] if fx_history else "—",
            fx_history[0]["rate"] if fx_history else "—"))
    except cbc_api.CBCError as e:
        errors.append("匯率:%r" % (e,))
        print("!! 匯率抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    try:
        start_date = (dt.date.today() - dt.timedelta(days=KEEP_DAYS * 2)).isoformat()
        rows = finmind_api.request(
            "TaiwanFuturesInstitutionalInvestors",
            data_id=FUTURES_ID, start_date=start_date)

        by_date = {}
        for r in rows:
            d = r.get("date")
            if not d:
                continue
            by_date.setdefault(d, {})[r.get("institutional_investors")] = r

        dates = sorted(by_date.keys(), reverse=True)[:KEEP_DAYS]
        history = []
        for d in dates:
            foreign = by_date[d].get("外資") or {}
            trust = by_date[d].get("投信") or {}
            dealer = by_date[d].get("自營商") or {}
            history.append({
                "date": d,
                "foreign_long_oi": foreign.get("long_open_interest_balance_volume"),
                "foreign_short_oi": foreign.get("short_open_interest_balance_volume"),
                "trust_long_oi": trust.get("long_open_interest_balance_volume"),
                "trust_short_oi": trust.get("short_open_interest_balance_volume"),
                "dealer_long_oi": dealer.get("long_open_interest_balance_volume"),
                "dealer_short_oi": dealer.get("short_open_interest_balance_volume"),
            })
        history.sort(key=lambda x: x["date"], reverse=True)

        latest = history[0] if history else {}
        out["futures"] = {
            "futures_id": FUTURES_ID,
            "date": latest.get("date"),
            "foreign_long_oi": latest.get("foreign_long_oi"),
            "foreign_short_oi": latest.get("foreign_short_oi"),
            "history": history,
        }
        print("期貨三大法人(%s):%d 個交易日" % (FUTURES_ID, len(history)))
        if latest:
            print("  外資多單未平倉 %s / 空單未平倉 %s" % (
                latest.get("foreign_long_oi"), latest.get("foreign_short_oi")))
    except finmind_api.FinMindError as e:
        errors.append("期貨三大法人:%r" % (e,))
        print("!! 期貨三大法人抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    out["date"] = today_str()
    out["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    common.write_json(common.FX_FUTURES_FILE, out, compact=True)
    print("已寫入 %s" % common.FX_FUTURES_FILE)
    return 1 if len(errors) == 2 else 0


if __name__ == "__main__":
    raise SystemExit(main())
