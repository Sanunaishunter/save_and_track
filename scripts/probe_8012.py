#!/usr/bin/env python3
"""
一次性探測(用完即刪):8012 移植還缺的兩塊資料。

1. 產業別 —— FinMind TaiwanStockInfo 的實際欄位與 industry_category 值,
   要能對上 SH2 那邊的 44 種分類
2. 市值排名 —— B5 的分層是「組內相對排名」(ceil(n/3) 兩刀切),
   所以只需要一個市值排序,不需要精確億元數字。
   A2 說 SH2 的免費 fallback 是 shares × close,所以要找到發行股數來源。
   先把 TWSE OpenAPI 的端點清單抓下來找,不用猜。
"""

import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# SH2 那邊 research.db::stock_info 實際存在的 44 種產業
SH2_INDUSTRIES = set("""ETF 光電業 其他 其他電子業 其他電子類 創新板股票 化學工業 化學生技醫療
半導體業 塑膠工業 存託憑證 居家生活類 建材營造 數位雲端 數位雲端類 文化創意業 橡膠工業
水泥工業 汽車工業 油電燃氣業 玻璃陶瓷 生技醫療業 紡織纖維 綠能環保 綠能環保類 航運業
觀光餐旅 貿易百貨 資訊服務業 農業科技業 通信網路業 造紙工業 運動休閒 運動休閒類 金融保險
金融業 鋼鐵工業 電器電纜 電子工業 電子通路業 電子零組件業 電機機械 電腦及週邊設備業
食品工業""".split())


def get(url, headers=None, timeout=60):
    h = {"User-Agent": UA, "Accept": "application/json,*/*"}
    if headers:
        h.update(headers)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return None, "EXC: %r" % (e,)


def show_list(name, url, headers=None, limit=1):
    print("\n" + "=" * 70)
    print("[%s]" % name)
    print("URL: %s" % url[:150])
    status, body = get(url, headers)
    print("HTTP: %s  長度: %d" % (status, len(body or "")))
    if not body:
        return None
    try:
        data = json.loads(body)
    except ValueError:
        print("非 JSON,前 300 字:\n%s" % body[:300])
        return None
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        print("型態: %s  keys=%s" % (type(rows).__name__, list(data)[:15] if isinstance(data, dict) else ""))
        if isinstance(data, dict):
            print("msg=%s status=%s" % (data.get("msg"), data.get("status")))
        return None
    print("筆數 = %d" % len(rows))
    if rows:
        print("欄位 = %s" % sorted(rows[0].keys()))
        for r in rows[:limit]:
            print("範例 = %s" % json.dumps(r, ensure_ascii=False)[:400])
    return rows


def main():
    tok = (os.environ.get("FINMIND_TOKEN") or "").strip()
    hdr = {"Authorization": "Bearer " + tok} if tok else None
    print("FinMind token:%s" % ("已設定" if tok else "未設定(未註冊模式)"))

    # ---------- 1. 產業別 ----------
    rows = show_list("FinMind TaiwanStockInfo(產業別來源)",
                     "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo", hdr)
    if rows:
        inds = {}
        for r in rows:
            inds[r.get("industry_category")] = inds.get(r.get("industry_category"), 0) + 1
        print("\nindustry_category 共 %d 種:" % len(inds))
        for k, v in sorted(inds.items(), key=lambda x: -x[1]):
            mark = "" if k in SH2_INDUSTRIES else "  ← SH2 那 44 種裡沒有"
            print("   %-20s %5d 檔%s" % (k, v, mark))
        missing = SH2_INDUSTRIES - set(inds)
        print("\nSH2 有但這次沒出現的:%s" % ("、".join(sorted(missing)) or "無"))

    # ---------- 2. TWSE 端點清單,找發行股數/資本額 ----------
    print("\n" + "=" * 70)
    print("[TWSE OpenAPI 端點清單:搜尋 資本/股數/市值/基本資料]")
    status, body = get("https://openapi.twse.com.tw/v1/swagger.json")
    print("HTTP: %s  長度: %d" % (status, len(body or "")))
    try:
        spec = json.loads(body)
        hits = []
        for path, ops in (spec.get("paths") or {}).items():
            text = json.dumps(ops, ensure_ascii=False)
            if any(k in text for k in ("資本", "股數", "市值", "基本資料", "發行")):
                summary = ""
                for m in ops.values():
                    summary = m.get("summary") or m.get("description") or ""
                    break
                hits.append((path, summary[:70]))
        print("符合的端點 %d 個:" % len(hits))
        for p, s in hits[:25]:
            print("   %-45s %s" % (p, s))
    except Exception as e:
        print("解析 swagger 失敗:%r" % (e,))

    # ---------- 3. 最可能的兩個端點 ----------
    show_list("TWSE 上市公司基本資料 t187ap03_L",
              "https://openapi.twse.com.tw/v1/opendata/t187ap03_L")
    show_list("TWSE 本益比/殖利率/股價淨值比 BWIBBU_ALL",
              "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL")

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
