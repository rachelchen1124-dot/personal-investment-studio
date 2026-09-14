import tempfile
import unittest
from pathlib import Path

from policy_only_backtest import (
    PanelRow,
    fit_transmission,
    leave_one_event_out,
    load_panel,
)


class PolicyOnlyBacktestTests(unittest.TestCase):
    def synthetic_rows(self):
        rows = []
        # Within each event y = 2*x + event-level constant. Event demeaning should
        # recover beta=2 exactly and ignore the broad event component.
        for event_id, level in [("E1", 10.0), ("E2", -5.0), ("E3", 3.0)]:
            for iso3, impact in [("AAA", -1.0), ("BBB", 0.0), ("CCC", 1.0)]:
                rows.append(
                    PanelRow(
                        event_id=event_id,
                        announcement_date="2020-01-01",
                        country=iso3,
                        iso3=iso3,
                        policy_impact_pct_gdp=impact,
                        fx_return_5d_pct=level + 2.0 * impact,
                    )
                )
        return rows

    def test_event_centering_recovers_cross_country_beta(self):
        result = fit_transmission(
            self.synthetic_rows(),
            "fx_return_5d_pct",
            bootstrap_replications=100,
            seed=1,
        )
        self.assertAlmostEqual(result.beta, 2.0, places=12)
        self.assertEqual(result.n_events, 3)
        self.assertEqual(result.n_rows, 9)
        self.assertIsNotNone(result.bootstrap_ci_95)
        self.assertAlmostEqual(result.bootstrap_ci_95[0], 2.0, places=12)
        self.assertAlmostEqual(result.bootstrap_ci_95[1], 2.0, places=12)

    def test_leave_one_event_out_is_perfect_on_stable_synthetic_relation(self):
        result = leave_one_event_out(self.synthetic_rows(), "fx_return_5d_pct")
        self.assertEqual(result.n_predictions, 9)
        self.assertAlmostEqual(result.sign_accuracy, 1.0, places=12)
        self.assertAlmostEqual(result.rmse, 0.0, places=12)

    def test_single_country_event_does_not_create_identification(self):
        rows = [
            PanelRow(
                event_id="SINGLE",
                announcement_date="2026-07-20",
                country="Canada",
                iso3="CAN",
                policy_impact_pct_gdp=-0.4247525946492328,
                fx_return_5d_pct=0.7135721421,
            )
        ]
        with self.assertRaisesRegex(ValueError, "No within-event PolicyImpact variation"):
            fit_transmission(rows, "fx_return_5d_pct", bootstrap_replications=10)

    def test_csv_loader_keeps_zero_impacts_and_missing_outcomes(self):
        csv_text = (
            "event_id,announcement_date,country,iso3,policy_impact_pct_gdp,fx_return_1d_pct\n"
            "E1,2020-01-01,A,AAA,0,\n"
            "E1,2020-01-01,B,BBB,-0.5,1.2\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "panel.csv"
            path.write_text(csv_text, encoding="utf-8")
            rows = load_panel(path)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].policy_impact_pct_gdp, 0.0)
        self.assertIsNone(rows[0].fx_return_1d_pct)
        self.assertEqual(rows[1].fx_return_1d_pct, 1.2)


if __name__ == "__main__":
    unittest.main()
