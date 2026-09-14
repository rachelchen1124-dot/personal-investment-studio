import unittest

from policy_impact import Exposure, PolicyEvent, build_snapshot, calculate_policy_impacts


class PolicyImpactTests(unittest.TestCase):
    def test_upper_bound_when_scope_is_unknown(self):
        event = PolicyEvent(
            event_id="test",
            announcement_date="2026-07-20",
            effective_date="2026-08-22",
            country="Canada",
            iso3="CAN",
            sector="motor_vehicles_and_parts",
            policy_type="additional_ad_valorem_duty",
            tariff_delta_pct=50.0,
            status="active",
            quantifiable=True,
            coverage_note="certain products",
            source_url="https://example.com/event",
        )
        exposure = Exposure(
            country="Canada",
            iso3="CAN",
            sector="motor_vehicles_and_parts",
            exposure_year=2024,
            us_bound_exports_local_bn=75.567,
            gdp_local_bn=3108.55,
            exposure_to_us_gdp_pct=2.4309404706,
            scope_coverage=None,
            coverage_type="broad_category_upper_bound",
            notes="test",
            source_url="https://example.com/exposure",
        )

        result = calculate_policy_impacts([event], [exposure])[0]
        self.assertAlmostEqual(result.impact_pct_gdp_equivalent, -1.2154702353)
        self.assertEqual(result.estimate_type, "broad_category_upper_bound")
        self.assertFalse(result.tradable_signal)

        snapshot = build_snapshot([result])
        self.assertAlmostEqual(snapshot["relative_mexico_vs_canada"], 1.2155)
        self.assertFalse(snapshot["tradable_signal"])

    def test_explicit_scope_can_be_modelled(self):
        event = PolicyEvent(
            event_id="test",
            announcement_date="2026-07-20",
            effective_date="2026-08-22",
            country="Canada",
            iso3="CAN",
            sector="motor_vehicles_and_parts",
            policy_type="additional_ad_valorem_duty",
            tariff_delta_pct=50.0,
            status="active",
            quantifiable=True,
            coverage_note="mapped annex",
            source_url="https://example.com/event",
        )
        exposure = Exposure(
            country="Canada",
            iso3="CAN",
            sector="motor_vehicles_and_parts",
            exposure_year=2024,
            us_bound_exports_local_bn=75.567,
            gdp_local_bn=3108.55,
            exposure_to_us_gdp_pct=2.4309404706,
            scope_coverage=0.4,
            coverage_type="mapped_scope_estimate",
            notes="test",
            source_url="https://example.com/exposure",
        )

        result = calculate_policy_impacts([event], [exposure])[0]
        self.assertAlmostEqual(result.impact_pct_gdp_equivalent, -0.48618809412)
        self.assertEqual(result.estimate_type, "mapped_scope_estimate")
        self.assertTrue(result.tradable_signal)


if __name__ == "__main__":
    unittest.main()
