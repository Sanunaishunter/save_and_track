#!/usr/bin/env python3
"""
Kelly 相關係數(ρ)驗證工具(2026-09-15 加入)。純 CLI、不寫回任何 data/ 檔案、不打 API。

js/app.js 的 corrHaircut()(部位分頁 Kelly 計算機的多筆折減)註解寫死假設:
「台股同產業實測約 0.5~0.75,跨產業約 0.3,防禦股對電子接近 0」——但那是憑印象寫的
經驗值,沒有真的算過。這支工具直接用永久存檔(data/archive/prices,281 個交易日)
算逐日報酬,拿 stock_meta.json 的產業別分組,算「同產業兩檔股票的報酬相關係數」
跟「跨產業兩檔股票的報酬相關係數」實際分布,回頭對這個假設。

用法:python scripts/backtest_kelly_rho.py
"""

import random
import statistics
import sys

import common

MIN_OVERLAP_DAYS = 40   # 兩檔股票至少要有幾天重疊報酬才納入(太短的相關係數不可靠)
CROSS_INDUSTRY_SAMPLE = 4000  # 跨產業隨機抽幾對(全市場兩兩配對太多,抽樣就好)
RNG_SEED = 42


def build_returns(prices, dates):
    """回傳 {code: {date: pct_return}},只算連續交易日都有收盤價的那天。"""
    out = {}
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        day0, day1 = prices.get(d0) or {}, prices.get(d1) or {}
        for sid, row1 in day1.items():
            c1 = row1.get("close")
            row0 = day0.get(sid)
            c0 = row0.get("close") if row0 else None
            if not c0 or not c1:
                continue
            out.setdefault(sid, {})[d1] = (c1 - c0) / c0 * 100.0
    return out


def pearson(a, b):
    n = len(a)
    if n < 2:
        return None
    try:
        return statistics.correlation(a, b)
    except statistics.StatisticsError:
        return None


def paired_returns(returns, sid_a, sid_b):
    ra, rb = returns.get(sid_a) or {}, returns.get(sid_b) or {}
    common_dates = ra.keys() & rb.keys()
    if len(common_dates) < MIN_OVERLAP_DAYS:
        return None, None
    a = [ra[d] for d in common_dates]
    b = [rb[d] for d in common_dates]
    return a, b


def summarize(rhos):
    if not rhos:
        return None
    return {
        "n_pairs": len(rhos),
        "avg": round(statistics.fmean(rhos), 3),
        "median": round(statistics.median(rhos), 3),
        "stdev": round(statistics.pstdev(rhos), 3) if len(rhos) > 1 else None,
        "p25": round(sorted(rhos)[len(rhos) // 4], 3),
        "p75": round(sorted(rhos)[len(rhos) * 3 // 4], 3),
    }


def main():
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料", file=sys.stderr)
        return 1

    meta = common.read_json(common.META_FILE) or {}
    stocks_meta = meta.get("stocks") or {}
    industry_of = {}
    for sid, m in stocks_meta.items():
        if not common.LISTED_CODE.match(str(sid)):
            continue
        ind = m.get("industry")
        if ind:
            industry_of[sid] = ind

    returns = build_returns(prices, dates)
    print("== Kelly 相關係數(ρ)驗證:存檔 %s ~ %s(%d 天),%d 檔有報酬序列、%d 檔有產業別 ==\n" %
          (dates[0], dates[-1], len(dates), len(returns), len(industry_of)))

    by_industry = {}
    for sid, ind in industry_of.items():
        if sid in returns:
            by_industry.setdefault(ind, []).append(sid)

    # ---- 同產業 ----
    within_rhos = []
    within_by_industry = {}
    for ind, codes in by_industry.items():
        if len(codes) < 2:
            continue
        local = []
        for i in range(len(codes)):
            for j in range(i + 1, len(codes)):
                a, b = paired_returns(returns, codes[i], codes[j])
                if a is None:
                    continue
                r = pearson(a, b)
                if r is not None:
                    local.append(r)
        if local:
            within_rhos.extend(local)
            within_by_industry[ind] = summarize(local)

    # ---- 跨產業(隨機抽樣) ----
    rng = random.Random(RNG_SEED)
    all_codes_with_industry = list(industry_of.keys() & returns.keys())
    cross_rhos = []
    tries, max_tries = 0, CROSS_INDUSTRY_SAMPLE * 5
    while len(cross_rhos) < CROSS_INDUSTRY_SAMPLE and tries < max_tries:
        tries += 1
        a_sid = rng.choice(all_codes_with_industry)
        b_sid = rng.choice(all_codes_with_industry)
        if a_sid == b_sid or industry_of.get(a_sid) == industry_of.get(b_sid):
            continue
        a, b = paired_returns(returns, a_sid, b_sid)
        if a is None:
            continue
        r = pearson(a, b)
        if r is not None:
            cross_rhos.append(r)

    within_summary = summarize(within_rhos)
    cross_summary = summarize(cross_rhos)

    print("同產業(全部配對):", within_summary)
    print("跨產業(隨機抽樣 %d 對):" % CROSS_INDUSTRY_SAMPLE, cross_summary)
    print()
    print("app.js corrHaircut() 假設:同產業 0.5~0.75、跨產業 0.3")
    if within_summary:
        in_range = 0.5 <= within_summary["avg"] <= 0.75
        print("  → 實測同產業平均 %.3f,%s假設區間(0.5~0.75)" %
              (within_summary["avg"], "落在 " if in_range else "沒有落在 "))
    if cross_summary:
        diff = abs(cross_summary["avg"] - 0.3)
        print("  → 實測跨產業平均 %.3f,跟假設值 0.3 差 %.3f" % (cross_summary["avg"], diff))
    print()

    print("-- 各產業同組平均 ρ(至少 3 對才列,由高到低)--")
    rows = [(ind, s) for ind, s in within_by_industry.items() if s["n_pairs"] >= 3]
    rows.sort(key=lambda x: -x[1]["avg"])
    for ind, s in rows:
        print("  %-12s n_pairs=%-4d avg=%+.3f median=%+.3f" % (ind, s["n_pairs"], s["avg"], s["median"]))

    print("\n提醒:相關係數會隨窗口(現在是存檔全部 281 天)跟市場狀態變動,這是單一時間窗口的\n"
          "快照,不是穩定不變的常數;Kelly 折減公式本身(1/(1+(n-1)ρ))沒有問題,問題只在\n"
          "ρ 這個輸入值要不要換成這裡算出來的實測值。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
