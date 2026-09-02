#!/usr/bin/env python3
"""
一次性探測(用完即刪):TWSE OpenAPI 的完整端點目錄。

swagger.json 是之前 probe_8012.py 已經驗證過的真實可用端點
(當時只挑「資本/股數/市值/基本資料」關鍵字,找到 t187ap03_L 跟 BWIBBU_ALL)。
這次印出全部端點,依 tag 分組,看還有什麼免費資料可以用。
"""

import json
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def get(url, timeout=60):
    h = {"User-Agent": UA, "Accept": "application/json,*/*"}
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


def main():
    status, body = get("https://openapi.twse.com.tw/v1/swagger.json")
    print("HTTP: %s  長度: %d" % (status, len(body or "")))
    if not body:
        return 1

    try:
        spec = json.loads(body)
    except ValueError as e:
        print("不是 JSON:%r" % (e,))
        print(body[:500])
        return 1

    paths = spec.get("paths") or {}
    print("\n總端點數:%d\n" % len(paths))

    # 依 tag 分組(swagger 的 tags 通常對應 TWSE 網站上的分類,例如
    # 「盤後資訊」「基本資料」「三大法人」「信用交易」...)
    groups = {}
    for path, ops in paths.items():
        for method, op in ops.items():
            if not isinstance(op, dict):
                continue
            tags = op.get("tags") or ["(無 tag)"]
            summary = op.get("summary") or op.get("description") or ""
            for tag in tags:
                groups.setdefault(tag, []).append((path, summary))
            break  # 一個 path 通常只有一個 method(get),不重複列

    for tag in sorted(groups):
        items = groups[tag]
        print("=" * 70)
        print("[%s]  %d 個端點" % (tag, len(items)))
        for path, summary in sorted(items):
            print("   %-55s %s" % (path, summary[:60]))

    # 現有專案已經在用的端點,標出來對照
    used = {"/opendata/t187ap03_L", "/exchangeReport/BWIBBU_ALL",
            "/exchangeReport/STOCK_DAY_ALL"}
    print("\n" + "=" * 70)
    print("目前專案已經在用:%s" % "、".join(sorted(used)))

    print("\n探測結束。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
