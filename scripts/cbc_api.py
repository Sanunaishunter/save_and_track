"""
央行(中央銀行)開放資料存取。只用標準函式庫,免 token、免額度。

新台幣/美元銀行間收盤匯率:FTDOpenData_Day 一次回應就是全部歷史(實測
2026-09-05 這天回了 4642 筆,回溯到 2008 年),不像 TWSE/TAIFEX 那些
「只給最新一兩天」的端點,不用自己每天存歷史 —— 每次重新抓、切最近
N 天即可。
"""

import json
import urllib.error
import urllib.request

FX_URL = "https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Day"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
TIMEOUT = 60


class CBCError(RuntimeError):
    pass


def _get_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise CBCError("HTTP %s" % e.code)
    except Exception as e:                      # noqa: BLE001 - 逾時/連線中斷/JSON 壞掉
        raise CBCError(repr(e))


def usd_twd_history(keep_days=30):
    """
    新台幣/美元銀行間收盤匯率,新到舊,最近 keep_days 筆。

    實測欄位是 {"日期":"20080102","NTD_USD":"32.443"} —— 日期是西元
    YYYYMMDD 字串(不是民國),NTD_USD 是字串數字。回傳
    [{date(西元 ISO), rate(float)}, ...]。
    """
    data = _get_json(FX_URL)
    if not isinstance(data, list) or not data:
        raise CBCError("FTDOpenData_Day 回傳空資料")

    out = []
    for r in data:
        d = str(r.get("日期") or "")
        rate = r.get("NTD_USD")
        if len(d) != 8 or rate is None:
            continue
        try:
            rate = float(rate)
        except (TypeError, ValueError):
            continue
        out.append({"date": "%s-%s-%s" % (d[:4], d[4:6], d[6:8]), "rate": rate})

    out.sort(key=lambda x: x["date"], reverse=True)
    return out[:keep_days]
