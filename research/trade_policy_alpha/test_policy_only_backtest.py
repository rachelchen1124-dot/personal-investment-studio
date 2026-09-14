import tempfile
import unittest
from pathlib import Path

from policy_only_backtest import (
    PanelRow,
    estimate_transmission,
    load_panel,
    research_gate,
    summarize_walk_forward,
    walk_forward_policy_only,
    within_event_sample,
)


class PolicyOnlyBacktestTests(unittest.TestCase):
    def synthetic_rows(self):
        rows = []
        impacts = [-0.6, -0.2, 0.1, 0.5]
        countries = ["A", "B", "C", "D"]
        for e in range(7):
            event_id = f"E{e+1}"
            date = f"2025-{e+1:02d}-15"
            common_fx = 0.10 * e
            common_rates = -0.5 * e
            for country, impact in zip(countries, impacts):
                rows.append(
                    PanelRow(
                        event_id=event_id,
                        announcement_date=date,
                        country=country,
                        policy_impact_pct_gdp=impact,
                        fx_return_1d_pct=common_fx - 2.0 * impact,
                        fx_return_5d_pct=common_fx - 1.5 * impact,
                        fx_return_10d_pct=common_fx - 1.0 * impact,
                        fx_return_20d_pct=common_fx - 0.5 * impact,
                        rates_change_1d_bp=common_rates + 3.0 * impact,
                        rates_change_5d_bp=common_rates + 2.0 * impact,
                        rates_change_10d_bp=common_rates + 1.0 * impact,
                        rates_change_20d_bp=common_rates + 0.5 * impact,
                    )
                )
        return rows

    def test_within_event_regression_removes_common_market_move(self):
        rows = self.synthetic_rows()
        fx = estimate_transmission(rows, "fx", 1, bootstrap_reps=100)
        rates = estimate_transmission(rows, "rates", 1, bootstrap_reps=100)
        self.assertAlmostEqual(fx.beta, -2.0, places=12)
        self.assertAlmostEqual(rates.beta, 3.0, places=12)
        self.assertEqual(fx.n_events, 7)
        self.assertEqual(fx.n_rows, 28)

    def test_single_country_event_does_not_identify_within_event_beta(self):
        rows = self.synthetic_rows()
        rows.append(
            PanelRow(
                event_id="SINGLE",
                announcement_date="2025-12-01",
                country="Z",
                policy_impact_pct_gdp=-5.0,
                fx_return_1d_pct=99.0,
            )
        )
        sample = within_event_sample(rows, "fx", 1)
        self.assertNotIn("SINGLE", {event_id for event_id, _, _ in sample})
        result = estimate_transmission(rows, "fx", 1, bootstrap_reps=100)
        self.assertAlmostEqual(result.beta, -2.0, places=12)

    def test_equal_impact_event_does_not_count_as_identifying(self):
        rows = self.synthetic_rows()
        rows.extend(
            [
                PanelRow(
                    event_id="EQUAL",
                    announcement_date="2025-12-10",
                    country="X",
                    policy_impact_pct_gdp=-0.3,
                    fx_return_1d_pct=0.2,
                ),
                PanelRow(
                    event_id="EQUAL",
                    announcement_date="2025-12-10",
                    country="Y",
                    policy_impact_pct_gdp=-0.3,
                    fx_return_1d_pct=-0.2,
                ),
            ]
        )
        sample = within_event_sample(rows, "fx", 1)
        self.assertNotIn("EQUAL", {event_id for event_id, _, _ in sample})
        gate = research_gate(rows, "fx", 1)
        self.assertEqual(gate["n_identifying_events"], 7)

    def test_research_gate_requires_event_count_and_rows(self):
        rows = self.synthetic_rows()
        gate = research_gate(rows, "fx", 1)
        self.assertTrue(gate["sample_sufficient_for_transmission_gate"])

        small = [row for row in rows if row.event_id in {"E1", "E2"}]
        small_gate = research_gate(small, "fx", 1)
        self.assertFalse(small_gate["sample_sufficient_for_transmission_gate"])

    def test_walk_forward_uses_only_prior_events(self):
        rows = self.synthetic_rows()
        trades = walk_forward_policy_only(rows, "fx", 1, min_train_events=5)
        self.assertGreater(len(trades), 0)
        self.assertTrue(all(t.training_events >= 5 for t in trades))
        self.assertTrue(all(t.announcement_date >= "2025-06-15" for t in trades))
        self.assertTrue(all(t.signed_policy_only_pnl > 0 for t in trades))
        summary = summarize_walk_forward(trades)
        self.assertEqual(summary["hit_rate"], 1.0)

    def test_csv_loader_rejects_duplicate_event_country(self):
        header = (
            "event_id,announcement_date,country,policy_impact_pct_gdp,"
            "fx_return_1d_pct\n"
        )
        body = "E1,2025-01-01,Canada,-0.4,0.5\nE1,2025-01-01,Canada,-0.4,0.6\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "panel.csv"
            path.write_text(header + body, encoding="utf-8")
            with self.assertRaises(ValueError):
                load_panel(path)


if __name__ == "__main__":
    unittest.main()
