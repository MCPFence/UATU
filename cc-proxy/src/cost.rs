// Cost estimation in RMB (元) per 1M tokens.
// Prices from JoyBuilder & 集团网关模型清单.
// For models with multiple providers, the cheapest price is used.
// Unknown models return 0.0.

struct ModelPrice {
    pattern: &'static str,
    input_per_mtok: f64,
    cache_per_mtok: f64,  // cache-hit read price; 0.0 means "same as input" (no discount)
    output_per_mtok: f64,
}

// Prices: RMB (元) per 1M tokens.
// cache_per_mtok = 0.0 means no published cache-read discount for that model.
// Ordered from most specific to least specific for matching.
static PRICE_TABLE: &[ModelPrice] = &[
    // --- Claude (Anthropic / AWS Bedrock) ---
    ModelPrice { pattern: "claude-opus-4",       input_per_mtok: 36.00,  cache_per_mtok: 0.0,   output_per_mtok: 180.00 },
    ModelPrice { pattern: "claude-opus-3",       input_per_mtok: 112.50, cache_per_mtok: 0.0,   output_per_mtok: 562.50 },
    ModelPrice { pattern: "claude-sonnet-4",     input_per_mtok: 22.50,  cache_per_mtok: 0.0,   output_per_mtok: 112.50 },
    ModelPrice { pattern: "claude-3-7-sonnet",   input_per_mtok: 22.50,  cache_per_mtok: 0.0,   output_per_mtok: 112.50 },
    ModelPrice { pattern: "claude-3-5-sonnet",   input_per_mtok: 22.50,  cache_per_mtok: 0.0,   output_per_mtok: 112.50 },
    ModelPrice { pattern: "claude-haiku-4",      input_per_mtok: 7.20,   cache_per_mtok: 0.0,   output_per_mtok: 36.00  },
    ModelPrice { pattern: "claude-3-5-haiku",    input_per_mtok: 7.50,   cache_per_mtok: 0.0,   output_per_mtok: 37.50  },
    ModelPrice { pattern: "claude-3-haiku",      input_per_mtok: 1.88,   cache_per_mtok: 0.0,   output_per_mtok: 9.38   },
    ModelPrice { pattern: "claude-opus",         input_per_mtok: 112.50, cache_per_mtok: 0.0,   output_per_mtok: 562.50 },
    ModelPrice { pattern: "claude-sonnet",       input_per_mtok: 22.50,  cache_per_mtok: 0.0,   output_per_mtok: 112.50 },
    ModelPrice { pattern: "claude-haiku",        input_per_mtok: 1.88,   cache_per_mtok: 0.0,   output_per_mtok: 9.38   },

    // --- GPT / OpenAI ---
    ModelPrice { pattern: "gpt-5.5",             input_per_mtok: 36.00,  cache_per_mtok: 3.60,  output_per_mtok: 216.00 },
    ModelPrice { pattern: "gpt-5.4",             input_per_mtok: 18.00,  cache_per_mtok: 0.0,   output_per_mtok: 108.00 },
    ModelPrice { pattern: "gpt-5.3",             input_per_mtok: 12.60,  cache_per_mtok: 0.0,   output_per_mtok: 100.80 },
    ModelPrice { pattern: "gpt-5.2",             input_per_mtok: 12.60,  cache_per_mtok: 0.0,   output_per_mtok: 100.80 },
    ModelPrice { pattern: "gpt-5.1",             input_per_mtok: 9.38,   cache_per_mtok: 0.0,   output_per_mtok: 75.00  },
    ModelPrice { pattern: "gpt-5-codex",         input_per_mtok: 9.38,   cache_per_mtok: 0.0,   output_per_mtok: 75.00  },
    ModelPrice { pattern: "gpt-5",               input_per_mtok: 9.38,   cache_per_mtok: 0.0,   output_per_mtok: 75.00  },
    ModelPrice { pattern: "gpt-4.5",             input_per_mtok: 562.50, cache_per_mtok: 0.0,   output_per_mtok: 1125.00},
    ModelPrice { pattern: "gpt-4.1",             input_per_mtok: 15.00,  cache_per_mtok: 0.0,   output_per_mtok: 60.00  },
    ModelPrice { pattern: "gpt-4o-mini",         input_per_mtok: 1.13,   cache_per_mtok: 0.0,   output_per_mtok: 4.50   },
    ModelPrice { pattern: "gpt-4o",              input_per_mtok: 18.75,  cache_per_mtok: 0.0,   output_per_mtok: 75.00  },
    ModelPrice { pattern: "o4-mini",             input_per_mtok: 8.03,   cache_per_mtok: 0.0,   output_per_mtok: 32.12  },
    ModelPrice { pattern: "o3-mini",             input_per_mtok: 8.25,   cache_per_mtok: 0.0,   output_per_mtok: 33.00  },
    ModelPrice { pattern: "o1-preview",          input_per_mtok: 22.50,  cache_per_mtok: 0.0,   output_per_mtok: 90.00  },
    ModelPrice { pattern: "o1-mini",             input_per_mtok: 112.50, cache_per_mtok: 0.0,   output_per_mtok: 450.00 },
    ModelPrice { pattern: "o1",                  input_per_mtok: 112.50, cache_per_mtok: 0.0,   output_per_mtok: 450.00 },

    // --- DeepSeek ---
    ModelPrice { pattern: "deepseek-v4-flash",   input_per_mtok: 1.00,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "deepseek-v4-pro",     input_per_mtok: 12.00,  cache_per_mtok: 0.0,   output_per_mtok: 24.00  },
    ModelPrice { pattern: "deepseek-v4",         input_per_mtok: 1.00,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "deepseek-r1-distill-qwen-7b",  input_per_mtok: 0.60,  cache_per_mtok: 0.0, output_per_mtok: 2.40 },
    ModelPrice { pattern: "deepseek-r1-distill-qwen-32b", input_per_mtok: 1.50,  cache_per_mtok: 0.0, output_per_mtok: 6.00 },
    ModelPrice { pattern: "deepseek-r1",         input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },
    ModelPrice { pattern: "deepseek-v3",         input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },
    ModelPrice { pattern: "deepseek-chat",       input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },
    ModelPrice { pattern: "deepseek-reasoner",   input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },

    // --- Kimi ---
    ModelPrice { pattern: "kimi-k2.6",           input_per_mtok: 6.50,   cache_per_mtok: 0.0,   output_per_mtok: 27.00  },
    ModelPrice { pattern: "kimi-k2",             input_per_mtok: 6.50,   cache_per_mtok: 0.0,   output_per_mtok: 27.00  },
    ModelPrice { pattern: "kimi",                input_per_mtok: 6.50,   cache_per_mtok: 0.0,   output_per_mtok: 27.00  },

    // --- Qwen ---
    ModelPrice { pattern: "qwen3.5-397b",        input_per_mtok: 1.20,   cache_per_mtok: 0.0,   output_per_mtok: 7.20   },
    ModelPrice { pattern: "qwen3-coder",         input_per_mtok: 15.00,  cache_per_mtok: 0.0,   output_per_mtok: 60.00  },
    ModelPrice { pattern: "qwen3-235b",          input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },
    ModelPrice { pattern: "qwen3-30b",           input_per_mtok: 0.75,   cache_per_mtok: 0.0,   output_per_mtok: 3.00   },
    ModelPrice { pattern: "qwen3-8b",            input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "qwen3-vl-8b",         input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "qwen3-vl-235",        input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },
    ModelPrice { pattern: "qwen2.5-vl-72b",      input_per_mtok: 16.00,  cache_per_mtok: 0.0,   output_per_mtok: 48.00  },
    ModelPrice { pattern: "qwen2.5-vl-7b",       input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 5.00   },
    ModelPrice { pattern: "qwen3",               input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },
    ModelPrice { pattern: "qwen",                input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 8.00   },

    // --- GLM (智谱) ---
    ModelPrice { pattern: "glm-5.1",             input_per_mtok: 6.00,   cache_per_mtok: 0.0,   output_per_mtok: 24.00  },
    ModelPrice { pattern: "glm-5",               input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },
    ModelPrice { pattern: "glm-4.7",             input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },
    ModelPrice { pattern: "glm-4.6v",            input_per_mtok: 2.00,   cache_per_mtok: 0.0,   output_per_mtok: 6.00   },
    ModelPrice { pattern: "glm-4.5",             input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },
    ModelPrice { pattern: "glm-4v-plus",         input_per_mtok: 10.00,  cache_per_mtok: 0.0,   output_per_mtok: 10.00  },
    ModelPrice { pattern: "glm-4v",              input_per_mtok: 50.00,  cache_per_mtok: 0.0,   output_per_mtok: 50.00  },
    ModelPrice { pattern: "glm-4-long",          input_per_mtok: 1.00,   cache_per_mtok: 0.0,   output_per_mtok: 1.00   },
    ModelPrice { pattern: "glm",                 input_per_mtok: 4.00,   cache_per_mtok: 0.0,   output_per_mtok: 16.00  },

    // --- Gemini ---
    ModelPrice { pattern: "gemini-3.1-flash-lite",  input_per_mtok: 1.80, cache_per_mtok: 0.0,  output_per_mtok: 10.80  },
    ModelPrice { pattern: "gemini-3.1-flash",    input_per_mtok: 3.60,   cache_per_mtok: 0.0,   output_per_mtok: 21.60  },
    ModelPrice { pattern: "gemini-3-flash",      input_per_mtok: 3.75,   cache_per_mtok: 0.0,   output_per_mtok: 22.50  },
    ModelPrice { pattern: "gemini-3-pro",        input_per_mtok: 15.00,  cache_per_mtok: 0.0,   output_per_mtok: 90.00  },
    ModelPrice { pattern: "gemini-2.5-flash",    input_per_mtok: 2.30,   cache_per_mtok: 0.0,   output_per_mtok: 18.75  },
    ModelPrice { pattern: "gemini-2.5-pro",      input_per_mtok: 20.00,  cache_per_mtok: 0.0,   output_per_mtok: 120.00 },
    ModelPrice { pattern: "gemini",              input_per_mtok: 2.30,   cache_per_mtok: 0.0,   output_per_mtok: 18.75  },

    // --- Doubao (字节) ---
    ModelPrice { pattern: "doubao",              input_per_mtok: 3.00,   cache_per_mtok: 0.0,   output_per_mtok: 9.00   },

    // --- MiniMax ---
    ModelPrice { pattern: "minimax-m2",          input_per_mtok: 2.10,   cache_per_mtok: 0.0,   output_per_mtok: 8.40   },
    ModelPrice { pattern: "minimax",             input_per_mtok: 2.10,   cache_per_mtok: 0.0,   output_per_mtok: 8.40   },

    // --- ERNIE (百度) ---
    ModelPrice { pattern: "ernie-4.5-turbo",     input_per_mtok: 0.80,   cache_per_mtok: 0.0,   output_per_mtok: 3.20   },
    ModelPrice { pattern: "ernie",               input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },

    // --- Others ---
    ModelPrice { pattern: "citrus",              input_per_mtok: 16.00,  cache_per_mtok: 0.0,   output_per_mtok: 48.00  },
    ModelPrice { pattern: "internvl3-38b",       input_per_mtok: 8.00,   cache_per_mtok: 0.0,   output_per_mtok: 24.00  },
    ModelPrice { pattern: "internvl",            input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "minicpm",             input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "eurollm",             input_per_mtok: 0.50,   cache_per_mtok: 0.0,   output_per_mtok: 2.00   },
    ModelPrice { pattern: "chatrhino",           input_per_mtok: 0.00,   cache_per_mtok: 0.0,   output_per_mtok: 0.00   },
];

fn lookup_price(model: &str) -> Option<&'static ModelPrice> {
    let m = model.to_lowercase();
    PRICE_TABLE.iter().find(|p| m.contains(p.pattern))
}

/// Returns estimated cost in RMB (元), treating all input tokens at full price.
pub fn estimate_cost(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let Some(price) = lookup_price(model) else {
        return 0.0;
    };
    let input_cost = (input_tokens as f64 / 1_000_000.0) * price.input_per_mtok;
    let output_cost = (output_tokens as f64 / 1_000_000.0) * price.output_per_mtok;
    input_cost + output_cost
}

/// Returns estimated cost in RMB (元) with cache-hit discount applied.
/// `cached_tokens` is the number of input tokens served from the KV cache
/// (from OpenAI's `usage.prompt_tokens_details.cached_tokens`).
/// When the model has no published cache price (`cache_per_mtok == 0.0`),
/// cached tokens are billed at the same rate as regular input tokens.
pub fn estimate_cost_with_cache(model: &str, input_tokens: u64, cached_tokens: u64, output_tokens: u64) -> f64 {
    let Some(price) = lookup_price(model) else {
        return 0.0;
    };
    let cached_tokens = cached_tokens.min(input_tokens);
    let non_cached = input_tokens - cached_tokens;
    let cache_rate = if price.cache_per_mtok > 0.0 {
        price.cache_per_mtok
    } else {
        price.input_per_mtok
    };
    let input_cost  = (non_cached    as f64 / 1_000_000.0) * price.input_per_mtok;
    let cache_cost  = (cached_tokens as f64 / 1_000_000.0) * cache_rate;
    let output_cost = (output_tokens as f64 / 1_000_000.0) * price.output_per_mtok;
    input_cost + cache_cost + output_cost
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unknown_model_returns_zero() {
        assert_eq!(estimate_cost("nonexistent-model", 1000, 1000), 0.0);
    }

    #[test]
    fn test_opus_4_cost() {
        let cost = estimate_cost("claude-opus-4-20250514", 1_000_000, 1_000_000);
        assert!((cost - 216.00).abs() < 0.01); // 36 + 180
    }

    #[test]
    fn test_sonnet_cost() {
        let cost = estimate_cost("claude-sonnet-4", 1_000_000, 0);
        assert!((cost - 22.50).abs() < 0.01);
    }

    #[test]
    fn test_kimi_cost() {
        let cost = estimate_cost("Kimi-K2.6", 1_000_000, 1_000_000);
        assert!((cost - 33.50).abs() < 0.01);
    }

    #[test]
    fn test_deepseek_v4_flash() {
        let cost = estimate_cost("DeepSeek-V4-Flash", 1_000_000, 1_000_000);
        assert!((cost - 3.00).abs() < 0.01);
    }

    #[test]
    fn test_zero_tokens_zero_cost() {
        assert_eq!(estimate_cost("claude-opus-4", 0, 0), 0.0);
    }

    #[test]
    fn test_case_insensitive() {
        let a = estimate_cost("Claude-Opus-4", 100, 100);
        let b = estimate_cost("claude-opus-4", 100, 100);
        assert_eq!(a, b);
    }

    #[test]
    fn test_bedrock_claude() {
        let cost = estimate_cost("anthropic.claude-sonnet-4-20250514-v1:0", 1_000_000, 0);
        assert!((cost - 22.50).abs() < 0.01);
    }

    #[test]
    fn test_glm_specific_submodel_not_matched_by_generic_glm() {
        // glm-4v-plus must match its own price row, not the fallback "glm" row
        let cost_4v_plus = estimate_cost("glm-4v-plus", 1_000_000, 0);
        let cost_glm_generic = estimate_cost("glm-unknown-model", 1_000_000, 0);
        assert!((cost_4v_plus - 10.00).abs() < 0.01, "glm-4v-plus input={}", cost_4v_plus);
        assert!((cost_glm_generic - 4.00).abs() < 0.01, "generic glm input={}", cost_glm_generic);
    }

    #[test]
    fn test_glm_5_1_cost() {
        let cost = estimate_cost("glm-5.1", 1_000_000, 1_000_000);
        assert!((cost - 30.00).abs() < 0.01); // 6 + 24
    }

    #[test]
    fn test_deepseek_r1_distill_32b_cost() {
        let cost = estimate_cost("deepseek-r1-distill-qwen-32b", 1_000_000, 0);
        assert!((cost - 1.50).abs() < 0.01);
    }

    #[test]
    fn test_deepseek_r1_distill_7b_not_matched_by_32b() {
        // 7b must not match the 32b price row (longer pattern listed first in table)
        let cost_7b  = estimate_cost("deepseek-r1-distill-qwen-7b",  1_000_000, 0);
        let cost_32b = estimate_cost("deepseek-r1-distill-qwen-32b", 1_000_000, 0);
        assert!((cost_7b  - 0.60).abs() < 0.01, "7b input={}", cost_7b);
        assert!((cost_32b - 1.50).abs() < 0.01, "32b input={}", cost_32b);
    }

    #[test]
    fn test_gemini_2_5_pro_cost() {
        let cost = estimate_cost("gemini-2.5-pro-latest", 1_000_000, 1_000_000);
        assert!((cost - 140.00).abs() < 0.01); // 20 + 120
    }

    #[test]
    fn test_gemini_generic_fallback() {
        let cost = estimate_cost("gemini-experimental-123", 1_000_000, 0);
        assert!((cost - 2.30).abs() < 0.01);
    }

    #[test]
    fn test_claude_opus_3_not_matched_by_opus_4() {
        // claude-opus-3 must not accidentally match claude-opus-4 row
        let cost3 = estimate_cost("claude-opus-3-20240229", 1_000_000, 0);
        let cost4 = estimate_cost("claude-opus-4-20250514", 1_000_000, 0);
        assert!((cost3 - 112.50).abs() < 0.01, "opus-3={}", cost3);
        assert!((cost4 - 36.00).abs() < 0.01, "opus-4={}", cost4);
    }

    #[test]
    fn test_gpt_4o_mini_not_matched_by_gpt_4o() {
        // gpt-4o-mini is cheaper; must not match gpt-4o row
        let mini = estimate_cost("gpt-4o-mini-2024-07-18", 1_000_000, 0);
        let full = estimate_cost("gpt-4o-2024-11-20",      1_000_000, 0);
        assert!((mini - 1.13).abs() < 0.01, "4o-mini={}", mini);
        assert!((full - 18.75).abs() < 0.01, "4o={}", full);
    }

    #[test]
    fn test_output_tokens_only() {
        let cost = estimate_cost("claude-opus-4", 0, 1_000_000);
        assert!((cost - 180.00).abs() < 0.01);
    }

    // ── GPT-5.5 価格 ─────────────────────────────────────────────────────────

    #[test]
    fn test_gpt55_input_price() {
        // 1K input tokens = 0.036 RMB → 1M = 36 RMB
        let cost = estimate_cost("gpt-5.5", 1_000_000, 0);
        assert!((cost - 36.00).abs() < 0.01, "gpt-5.5 input cost={}", cost);
    }

    #[test]
    fn test_gpt55_output_price() {
        // 1K output tokens = 0.216 RMB → 1M = 216 RMB
        let cost = estimate_cost("gpt-5.5", 0, 1_000_000);
        assert!((cost - 216.00).abs() < 0.01, "gpt-5.5 output cost={}", cost);
    }

    #[test]
    fn test_gpt55_full_price_no_cache() {
        // 1M input + 1M output = 36 + 216 = 252 RMB
        let cost = estimate_cost("gpt-5.5", 1_000_000, 1_000_000);
        assert!((cost - 252.00).abs() < 0.01, "gpt-5.5 total={}", cost);
    }

    // ── estimate_cost_with_cache ──────────────────────────────────────────────

    #[test]
    fn test_gpt55_cache_hit_price() {
        // 1K cache-hit tokens = 0.0036 RMB → 1M = 3.6 RMB
        // 1M cache-hit input only (all tokens from cache)
        let cost = estimate_cost_with_cache("gpt-5.5", 1_000_000, 1_000_000, 0);
        assert!((cost - 3.60).abs() < 0.01, "gpt-5.5 all-cache cost={}", cost);
    }

    #[test]
    fn test_gpt55_mixed_cache_and_non_cache() {
        // 1M total input, 800K cached, 200K non-cached, 500K output
        // cost = 200K * 36/M + 800K * 3.6/M + 500K * 216/M
        //      = 7.2 + 2.88 + 108 = 118.08 RMB
        let cost = estimate_cost_with_cache("gpt-5.5", 1_000_000, 800_000, 500_000);
        let expected = (200_000.0 / 1_000_000.0) * 36.0
            + (800_000.0 / 1_000_000.0) * 3.6
            + (500_000.0 / 1_000_000.0) * 216.0;
        assert!((cost - expected).abs() < 0.01, "mixed cache cost={} expected={}", cost, expected);
    }

    #[test]
    fn test_cache_with_no_discount_model_falls_back_to_input_rate() {
        // claude-opus-4 has cache_per_mtok=0.0 → cache tokens billed at full input rate
        let full  = estimate_cost("claude-opus-4", 1_000_000, 0);
        let cache = estimate_cost_with_cache("claude-opus-4", 1_000_000, 1_000_000, 0);
        assert!((full - cache).abs() < 0.001, "no-discount model: full={} cache={}", full, cache);
    }

    #[test]
    fn test_cache_zero_cached_tokens_same_as_estimate_cost() {
        // With 0 cached tokens, estimate_cost_with_cache must equal estimate_cost
        let a = estimate_cost("gpt-5.5", 500_000, 300_000);
        let b = estimate_cost_with_cache("gpt-5.5", 500_000, 0, 300_000);
        assert!((a - b).abs() < 0.001, "zero-cache: a={} b={}", a, b);
    }

    #[test]
    fn test_cache_unknown_model_returns_zero() {
        assert_eq!(estimate_cost_with_cache("nonexistent", 1_000_000, 500_000, 1_000_000), 0.0);
    }

    #[test]
    fn test_cache_tokens_clamped_at_input_tokens() {
        // cached_tokens > input_tokens should not produce negative non-cached
        // saturating_sub prevents underflow; non_cached becomes 0
        let cost = estimate_cost_with_cache("gpt-5.5", 100_000, 200_000, 0);
        // non_cached = 0, cached = 100_000 (clamped), output = 0
        let expected = (100_000.0 / 1_000_000.0) * 3.6;
        assert!((cost - expected).abs() < 0.001, "clamped cache cost={}", cost);
    }
}
