#!/usr/bin/env python3
"""
抓「產業別 + 發行股數」,寫進 data/stock_meta.json。

8012 的分組是 產業 × 市值級距,兩個欄位分別來自:
  - 產業別:FinMind TaiwanStockInfo.industry_category
    (SH2 那邊的 research.db::stock_info.industry 就是這個原樣落地,
     未做任何分類合併 —— 所以這裡也不合併)
  - 發行股數:TWSE OpenAPI t187ap03_L「已發行普通股數或TDR原股發行股數」
    市值 = 發行股數 × 收盤價,即 SH2 沒有付費 market_value 時的免費 fallback

這份資料變動很慢(產業別幾乎不動、股數只在增減資時變),抓失敗時
沿用既有檔案,不清空 —— 分層一旦凍結也不會因此漂移。
"""

import argparse
import datetime as dt
import sys

import common
import finmind_api
import twse_api

# SH2 research.db::stock_info 實際存在的 44 種產業。
# 只拿來比對差異、印出來看,不做任何過濾或改名。
SH2_INDUSTRIES = set("""ETF 光電業 其他 其他電子業 其他電子類 創新板股票 化學工業 化學生技醫療
半導體業 塑膠工業 存託憑證 居家生活類 建材營造 數位雲端 數位雲端類 文化創意業 橡膠工業
水泥工業 汽車工業 油電燃氣業 玻璃陶瓷 生技醫療業 紡織纖維 綠能環保 綠能環保類 航運業
觀光餐旅 貿易百貨 資訊服務業 農業科技業 通信網路業 造紙工業 運動休閒 運動休閒類 金融保險
金融業 鋼鐵工業 電器電纜 電子工業 電子通路業 電子零組件業 電機機械 電腦及週邊設備業
食品工業""".split())


def fetch_industries():
    """{code: industry}。只留上市普通股。"""
    rows = finmind_api.request("TaiwanStockInfo")
    out = {}
    for r in rows:
        code = str(r.get("stock_id") or "").strip()
        ind = (r.get("industry_category") or "").strip()
        if not code or not ind:
            continue
        if not common.is_listed_common(code, None):
            continue
        out[code] = ind
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只印出結果,不寫檔")
    args = ap.parse_args()

    prev = common.read_json(common.META_FILE) or {}
    stocks = dict(prev.get("stocks") or {})

    errors = []

    # --- 產業別 ---
    industries = {}
    try:
        industries = fetch_industries()
        print("FinMind TaiwanStockInfo:上市普通股 %d 檔" % len(industries))
    except Exception as e:                    # noqa: BLE001 - 抓不到就沿用舊檔
        errors.append("產業別:%r" % (e,))
        print("!! 產業別抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    # --- 發行股數 ---
    company = {}
    try:
        company = twse_api.company_info()
        print("TWSE t187ap03_L:%d 筆公司基本資料" % len(company))
    except Exception as e:                    # noqa: BLE001
        errors.append("發行股數:%r" % (e,))
        print("!! 發行股數抓取失敗,沿用既有資料:%r" % (e,), file=sys.stderr)

    for code, ind in industries.items():
        stocks.setdefault(code, {})["industry"] = ind
    for code, info in company.items():
        if not common.is_listed_common(code, None):
            continue
        rec = stocks.setdefault(code, {})
        if info.get("shares"):
            rec["shares"] = info["shares"]
        if info.get("name") and not rec.get("name"):
            rec["name"] = info["name"]

    if industries:
        seen = set(industries.values())
        extra = sorted(seen - SH2_INDUSTRIES)
        missing = sorted(SH2_INDUSTRIES - seen)
        print("產業別 %d 種;SH2 那 44 種沒有的 %d 種:%s"
              % (len(seen), len(extra), "、".join(extra) or "無"))
        print("SH2 有但這次沒出現的:%s" % ("、".join(missing) or "無"))

    with_ind = sum(1 for v in stocks.values() if v.get("industry"))
    with_sh = sum(1 for v in stocks.values() if v.get("shares"))
    print("合計 %d 檔:有產業別 %d、有股數 %d" % (len(stocks), with_ind, with_sh))

    if args.dry_run:
        return 1 if errors else 0

    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "industry": "FinMind TaiwanStockInfo.industry_category",
            "shares": "TWSE OpenAPI t187ap03_L 已發行普通股數或TDR原股發行股數",
        },
        "count": len(stocks),
        "stocks": stocks,
    }
    common.write_json(common.META_FILE, out)
    print("已寫入 %s" % common.META_FILE)

    # 兩個來源都掛掉才算失敗;只掛一個時舊資料還在,不擋後面的聚合。
    if len(errors) == 2:
        print("兩個來源都失敗", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
