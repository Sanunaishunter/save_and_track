"""
8012 的分組、抽樣凍結與組內聚合。純函式,不碰檔案、不打網路。

移植自 SH2 的 aggregator,語意照抄:
  - 分層是「組內相對排名」滾動切三層,不是絕對市值門檻
    (絕對門檻 CAP_TIER_LARGE_MIN/MID_MIN 是 v1 deprecated 的做法)
  - 抽樣結果第一次算出來就凍結,之後永遠讀凍結表 ——
    市值變動不讓成員漂移,序列才有比較意義
  - 組內每日值是「算術平均」,缺值成員排除出當日分母,不計 0
"""

import tick_indicators

CAP_TIER_LARGE_MIN = 1000   # 億元。v1 deprecated 的絕對門檻,v2 不用,留著對照
CAP_TIER_MID_MIN = 100      # 億元。同上

SAMPLE_TARGET_PER_GROUP = 10   # 每組目標抽 10 檔,不足額全取
LOW_N_THRESHOLD = 10           # sample_count < 10 → low_n_flag=1

TIERS = ("大", "中", "小")


def assign_relative_tiers(candidates):
    """組內(單一產業內)依市值由大到小排序,滾動切三層。

    candidates: [(stock_code, market_cap_yi)],market_cap_yi 已保證非 None。
    切法:ceil(n/3) / ceil(2n/3) 兩刀切,避免無條件捨去讓某層多吃下一層的量。
    """
    ranked = sorted(candidates, key=lambda t: t[1], reverse=True)
    n = len(ranked)
    large_cut = -(-n // 3)       # ceil(n/3)
    mid_cut = -(-2 * n // 3)     # ceil(2n/3)
    return {
        "大": [c for c, _ in ranked[:large_cut]],
        "中": [c for c, _ in ranked[large_cut:mid_cut]],
        "小": [c for c, _ in ranked[mid_cut:]],
    }


def build_candidates(meta_stocks, closes):
    """{industry: [(code, market_cap_yi)]}。缺產業別或算不出市值的直接不進候選。"""
    groups = {}
    for code, rec in meta_stocks.items():
        industry = (rec or {}).get("industry")
        shares = (rec or {}).get("shares")
        close = closes.get(code)
        if not industry or not shares or close is None:
            continue
        cap_yi = round(shares * close / 1e8, 1)   # 元 → 億元,同 SH2
        groups.setdefault(industry, []).append((code, cap_yi))
    # 市值相同時 sorted 會保留輸入順序,先照代號排一次,結果才不隨字典順序跳動
    for industry in groups:
        groups[industry].sort(key=lambda t: t[0])
    return groups


def freeze_samples(frozen, candidates, target=SAMPLE_TARGET_PER_GROUP):
    """
    第一次遇到某 (industry, tier) 才挑成員並寫死;已凍結的原樣沿用。

    挑法:分層後那一層「依股票代號排序」取前 target 檔(不是依市值)。
    回傳 (新的凍結表, 這次新凍結的組數)。
    """
    out = dict(frozen)
    added = 0
    for industry, cands in candidates.items():
        tiers = assign_relative_tiers(cands)
        for tier in TIERS:
            key = "%s|%s" % (industry, tier)
            if key in out:
                continue
            members = sorted(tiers.get(tier) or [])[:target]
            if not members:
                continue
            caps = dict(cands)
            out[key] = {
                "industry": industry,
                "cap_tier": tier,
                "members": members,
                # 記下凍結當下的市值,之後想知道「當初憑什麼分這層」才查得到
                "frozen_caps_yi": [caps.get(c) for c in members],
                "pool_size": len(tiers.get(tier) or []),
            }
            added += 1
    return out, added


def series_for_members(members, per_code_counts, dates):
    """
    組內每日算術平均。dates 由新到舊,回傳等長的 list。

    缺值成員排除出當日分母,不計 0;整組當天無人有資料 → None。
    另外回傳每天實際貢獻分母的成員數(reporting_count 取 [0])。
    """
    vals = []
    reporting = []
    for d in dates:
        got = []
        for code in members:
            v = (per_code_counts.get(code) or {}).get(d)
            if v is not None:
                got.append(v)
        reporting.append(len(got))
        vals.append(sum(got) / len(got) if got else None)
    return vals, reporting


def group_row(entry, per_code_counts, dates):
    """一組 (industry, cap_tier) 當天要寫進 snapshot 的那一列。"""
    members = entry["members"]
    vals, reporting = series_for_members(members, per_code_counts, dates)
    metrics = tick_indicators.today_metrics(vals)

    sample_count = len(members)
    row = {
        "industry": entry["industry"],
        "cap_tier": entry["cap_tier"],
        "sample_count": sample_count,
        "reporting_count": reporting[0] if reporting else 0,
        "avg_tick_count_raw": vals[0] if vals else None,
        "low_n_flag": 1 if sample_count < LOW_N_THRESHOLD else 0,
        # 前端畫 30 天序列用;各指標由前端用同一組公式現算,不各存一份
        "series_raw": vals,
    }
    row.update(metrics)
    return row


def build_snapshot(frozen, per_code_counts, dates):
    """整份 snapshot 的列。產業列排序:三層 sample_count 加總,多的在前。"""
    rows = [group_row(e, per_code_counts, dates) for e in frozen.values()]

    totals = {}
    for r in rows:
        totals[r["industry"]] = totals.get(r["industry"], 0) + r["sample_count"]

    tier_order = {t: i for i, t in enumerate(TIERS)}
    rows.sort(key=lambda r: (-totals[r["industry"]], r["industry"],
                             tier_order.get(r["cap_tier"], 9)))
    return rows
