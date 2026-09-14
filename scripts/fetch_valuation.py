#!/usr/bin/env python3
"""
全市場本益比 / 股價淨值比 / 殖利率(2026-09-14 加入)。

資料源:TWSE OpenAPI BWIBBU_ALL(免費、免 token、一次呼叫拿全市場,跟已經在用的
STOCK_DAY_ALL 是同一個 openapi 家族)。文件上的欄位是 Date / Code / Name /
PEratio / DividendYield / PBratio。

**這支還沒有經過 probe 驗證**(容器連不到 TWSE)。所以寫法是防禦性的:
  - 第一次跑會把回應第一筆的欄位名印在 log 裡,對不上時整支軟失敗
    (exit 0、沿用舊檔),不會讓 daily-scan 整個 job 紅
  - 欄位名用不分大小寫的模糊比對(PEratio / PEr / pe_ratio 都吃)
  - 值是 "-" 或空字串(虧損股沒有 PE)→ None,不當成 0
第一次在 Actions 跑完請看 log,確認「欄位:…」那行跟預期一致;不一致就把這裡改掉。

輸出:
  data/valuation-latest.json              {date, count, data:{code:{pe,pb,yield,name}}}
  data/archive/valuation/YYYY-MM.json     逐日永久存檔 {days:{date:{code:[pe,pb,yield]}}},
                                          給記分板之後做「高 PE 的爆量是不是更常虛漲」用
"""

import datetime as dt
import os
import sys

import common
import twse_api

BWIBBU_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"


def _pick(row, *cands):
    """不分大小寫、忽略底線地找欄位。"""
    norm = {str(k).lower().replace("_", ""): v for k, v in row.items()}
    for c in cands:
        v = norm.get(c.lower().replace("_", ""))
        if v is not None:
            return v
    return None


def parse_rows(data):
    """回傳 (date_iso or None, {code:{pe,pb,yield,name}})。欄位對不上時 dict 是空的。"""
    if not isinstance(data, list) or not data:
        return None, {}
    first = data[0]
    date_iso = twse_api._roc_to_iso(_pick(first, "Date")) if _pick(first, "Date") else None
    out = {}
    for r in data:
        code = str(_pick(r, "Code", "StockCode", "stock_id") or "").strip()
        if not common.is_listed_common(code, None):
            continue
        pe = twse_api._num(_pick(r, "PEratio", "PEr", "PE", "pe_ratio"))
        pb = twse_api._num(_pick(r, "PBratio", "PBr", "PB", "pb_ratio"))
        dy = twse_api._num(_pick(r, "DividendYield", "Yield", "dividend_yield"))
        if pe is None and pb is None and dy is None:
            continue
        out[code] = {"pe": pe, "pb": pb, "yield": dy,
                     "name": str(_pick(r, "Name", "StockName") or "").strip()}
    return date_iso, out


def main():
    try:
        data = twse_api._get_json(BWIBBU_ALL_URL)
    except Exception as e:                                   # noqa: BLE001
        print("!! BWIBBU_ALL 抓取失敗,沿用舊檔:%r" % (e,), file=sys.stderr)
        return 0
    if isinstance(data, list) and data:
        print("欄位:%s" % ", ".join(str(k) for k in data[0].keys()))
        print("第一筆:%s" % (data[0],))
    date_iso, rows = parse_rows(data)
    if not rows:
        print("!! BWIBBU_ALL 欄位對不上預期(PEratio/PBratio/DividendYield/Code),"
              "沒有寫任何檔案。請看上面印出的欄位名,改 scripts/fetch_valuation.py。",
              file=sys.stderr)
        return 0
    if not date_iso:
        date_iso = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).date().isoformat()
        print("  回應沒有日期欄位,用台北今天 %s 當日期" % date_iso)

    n_pe = sum(1 for v in rows.values() if v["pe"] is not None)
    n_pb = sum(1 for v in rows.values() if v["pb"] is not None)
    common.write_json(common.VALUATION_FILE, {
        "date": date_iso,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "twse:BWIBBU_ALL",
        "count": len(rows),
        "note": "本益比/淨值比/殖利率是 TWSE 用最近四季 EPS 與最新淨值算的;虧損股沒有本益比(null)。",
        "data": rows,
    })

    ym = date_iso[:7]
    path = os.path.join(common.ARCHIVE_VALUATION_DIR, ym + ".json")
    blob = common.read_json(path) or {"month": ym, "columns": ["pe", "pb", "yield"], "days": {}}
    blob.setdefault("days", {})
    blob["days"][date_iso] = {c: [v["pe"], v["pb"], v["yield"]] for c, v in sorted(rows.items())}
    blob["day_count"] = len(blob["days"])
    common.write_json(path, blob, compact=True)

    print("== 估值 %s:%d 檔上市普通股,有 PE %d、有 PB %d ==" % (date_iso, len(rows), n_pe, n_pb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
