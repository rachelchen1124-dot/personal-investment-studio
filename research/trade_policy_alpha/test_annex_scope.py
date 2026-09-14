import tempfile
import unittest
from pathlib import Path

from annex_scope import load_scope, load_trade_values, value_scope


class AnnexScopeTests(unittest.TestCase):
    def test_official_annex_scope_has_439_unique_codes(self):
        scope_path = Path(__file__).parent / "data" / "US_CA_MOTOR_2026_07_20_annex_ii_htsus8.txt"
        scope = load_scope(scope_path)
        self.assertEqual(len(scope), 439)
        self.assertEqual(len(scope), len(set(scope)))

    def test_incomplete_trade_mapping_is_not_a_point_estimate(self):
        scope = ["0409.00.00", "0505.10.00"]
        result = value_scope(
            scope,
            {"0409.00.00": 10.0},
            gdp_local=1000.0,
            tariff_delta_pct=50.0,
        )
        self.assertFalse(result["coverage_complete"])
        self.assertFalse(result["tradable_signal"])
        self.assertEqual(result["missing_code_count"], 1)

    def test_complete_scope_computes_gdp_equivalent_impact(self):
        scope = ["0409.00.00", "0505.10.00"]
        result = value_scope(
            scope,
            {"0409.00.00": 10.0, "0505.10.00": 30.0},
            gdp_local=1000.0,
            tariff_delta_pct=50.0,
        )
        self.assertTrue(result["coverage_complete"])
        self.assertAlmostEqual(result["exposure_pct_gdp"], 4.0)
        self.assertAlmostEqual(result["policy_impact_pct_gdp_equivalent"], -2.0)
        self.assertFalse(result["tradable_signal"])

    def test_normalized_trade_values_sum_duplicate_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trade.csv"
            path.write_text(
                "htsus_8,trade_value_local\n0409.00.00,\"1,000\"\n0409.00.00,500\n",
                encoding="utf-8",
            )
            values = load_trade_values(path)
            self.assertEqual(values["0409.00.00"], 1500.0)


if __name__ == "__main__":
    unittest.main()
