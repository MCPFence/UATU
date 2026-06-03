use regex::RegexSet;
use std::sync::LazyLock;

static HEDGE_PATTERNS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(?i)\b(?:might|maybe|possibly|perhaps|probably)\b",
        r"(?i)\b(?:I think|I believe|it seems|not sure|not certain)\b",
        r"(?i)\b(?:unclear|ambiguous|uncertain|unsure)\b",
        r"(?i)\b(?:could be|may be|might be)\b",
        r"(?i)\b(?:I'm not (?:sure|certain|confident))\b",
        r"(?i)\b(?:it's (?:possible|likely|unlikely))\b",
        r"(?i)\b(?:hard to say|difficult to determine)\b",
        r"可能|或许|也许|大概|大约",
        r"不太确定|不太清楚|不太明确|不确定",
        r"似乎|好像|看起来像|应该是",
        r"我认为|我觉得|我猜",
    ])
    .expect("hedge patterns must compile")
});

static VERIFY_PATTERNS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(?i)\b(?:let me (?:check|verify|confirm|double.?check))\b",
        r"(?i)\b(?:I (?:realize|confirmed|verified))\b",
        r"(?i)\b(?:actually|wait|on second thought)\b",
        r"(?i)\b(?:after (?:checking|verifying|reviewing))\b",
        r"(?i)\b(?:upon (?:closer|further) (?:inspection|review|examination))\b",
        r"(?i)\b(?:I can confirm|I've confirmed|I've verified)\b",
        r"让我确认|让我核实|让我验证",
        r"经过(?:检查|核实|验证|审查)",
        r"重新审视|再看一下|仔细看",
    ])
    .expect("verify patterns must compile")
});

#[derive(Debug, Clone)]
pub struct HvrResult {
    pub hedge_count: usize,
    pub verify_count: usize,
    pub hvr_score: f64,
    pub gate_passed: bool,
}

pub struct HvrDetector;

impl HvrDetector {
    pub fn new() -> Self {
        LazyLock::force(&HEDGE_PATTERNS);
        LazyLock::force(&VERIFY_PATTERNS);
        Self
    }

    pub fn analyze(&self, text: &str) -> HvrResult {
        let hedge_count = HEDGE_PATTERNS.matches(text).iter().count();
        let verify_count = VERIFY_PATTERNS.matches(text).iter().count();

        if hedge_count == 0 {
            return HvrResult {
                hedge_count: 0,
                verify_count,
                hvr_score: 1.0,
                gate_passed: true,
            };
        }

        if verify_count > 0 {
            let score = verify_count as f64 / (hedge_count + verify_count) as f64;
            HvrResult {
                hedge_count,
                verify_count,
                hvr_score: score,
                gate_passed: score > 0.5,
            }
        } else {
            HvrResult {
                hedge_count,
                verify_count: 0,
                hvr_score: 0.0,
                gate_passed: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector() -> HvrDetector {
        HvrDetector::new()
    }

    #[test]
    fn test_confident_response() {
        let r = detector().analyze("The answer is 42. This is correct.");
        assert_eq!(r.hedge_count, 0);
        assert_eq!(r.hvr_score, 1.0);
        assert!(r.gate_passed);
    }

    #[test]
    fn test_hedging_no_verify() {
        let r = detector().analyze("I think maybe the answer might be 42.");
        assert!(r.hedge_count >= 2);
        assert_eq!(r.verify_count, 0);
        assert_eq!(r.hvr_score, 0.0);
        assert!(!r.gate_passed);
    }

    #[test]
    fn test_hedging_with_verify() {
        let r = detector().analyze(
            "I think the answer might be 42. Let me check. Actually, I can confirm it is 42.",
        );
        assert!(r.hedge_count > 0);
        assert!(r.verify_count > 0);
        assert!(r.hvr_score > 0.0);
    }

    #[test]
    fn test_chinese_hedging() {
        let r = detector().analyze("这个问题可能有多种解释，也许需要更多上下文。");
        assert!(r.hedge_count >= 1);
        assert!(!r.gate_passed);
    }

    #[test]
    fn test_chinese_verify() {
        let r = detector().analyze("可能是这样。让我确认一下，经过检查确实如此。");
        assert!(r.hedge_count >= 1);
        assert!(r.verify_count >= 1);
    }

    #[test]
    fn test_empty_text() {
        let r = detector().analyze("");
        assert_eq!(r.hedge_count, 0);
        assert!(r.gate_passed);
    }

    #[test]
    fn test_code_only_no_hedge() {
        let r = detector().analyze("fn main() { println!(\"hello\"); }");
        assert!(r.gate_passed);
    }

    #[test]
    fn test_many_hedges_some_verify() {
        let r = detector().analyze(
            "Maybe it could be X. It's possible. Perhaps not. \
             Actually, let me verify. After checking, I confirmed.",
        );
        assert!(r.hedge_count >= 2);
        assert!(r.verify_count >= 2);
        assert!(r.hvr_score > 0.0);
    }

    #[test]
    fn test_equal_hedge_and_verify_fails_gate() {
        // score = verify/(hedge+verify) = 1/2 = 0.5, gate requires > 0.5
        let r = detector().analyze("Maybe. Actually.");
        if r.hedge_count == 1 && r.verify_count == 1 {
            assert!((r.hvr_score - 0.5).abs() < 0.01);
            assert!(!r.gate_passed, "score exactly 0.5 should not pass gate (requires >0.5)");
        }
    }

    #[test]
    fn test_verify_dominates_passes_gate() {
        // 1 hedge, 2 verifies → score = 2/3 ≈ 0.667 > 0.5 → pass
        let r = detector().analyze(
            "Maybe. Actually, let me check. I've verified this.",
        );
        assert!(r.hedge_count >= 1);
        assert!(r.verify_count >= 2);
        assert!(r.gate_passed);
    }

    #[test]
    fn test_score_field_zero_when_no_verify() {
        let r = detector().analyze("I think it might be the case.");
        assert!(r.hedge_count > 0);
        assert_eq!(r.verify_count, 0);
        assert_eq!(r.hvr_score, 0.0);
    }

    #[test]
    fn test_score_is_1_when_no_hedges() {
        let r = detector().analyze("The answer is 42.");
        assert_eq!(r.hedge_count, 0);
        assert_eq!(r.hvr_score, 1.0);
        assert!(r.gate_passed);
    }
}
