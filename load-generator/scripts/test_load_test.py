"""Unit tests for load_test.py — pure logic functions only (no AWS calls)."""

import sys
import os
from unittest.mock import MagicMock

import pytest

# Ensure load_test module is importable from the same directory
sys.path.insert(0, os.path.dirname(__file__))

# Mock boto3 and botocore before importing load_test (not installed locally)
if "boto3" not in sys.modules:
    sys.modules["boto3"] = MagicMock()
    sys.modules["botocore"] = MagicMock()
    sys.modules["botocore.config"] = MagicMock()
    sys.modules["botocore.exceptions"] = MagicMock()

import load_test


# =============================================================================
# 1. Argument parsing tests
# =============================================================================


class TestParseArgs:
    """Tests for parse_args() argument parsing."""

    def test_parse_args_required_table(self):
        """--table is required, missing it should cause SystemExit."""
        with pytest.raises(SystemExit):
            load_test.parse_args([])

    def test_parse_args_defaults(self):
        """Default values when only --table is provided."""
        args = load_test.parse_args(["--table", "my-table"])
        assert args.table == "my-table"
        assert args.table_type == "bad"
        assert args.rps == 1500
        assert args.duration == 120
        assert args.tokyo_ratio == 0.7
        assert args.threads == 100
        assert args.region == "us-west-2"
        assert args.no_retry is False

    def test_parse_args_all_options(self):
        """All options specified should override defaults."""
        args = load_test.parse_args([
            "--table", "test-table",
            "--table-type", "good",
            "--rps", "3000",
            "--duration", "60",
            "--tokyo-ratio", "0.9",
            "--threads", "200",
            "--region", "ap-northeast-1",
            "--no-retry",
        ])
        assert args.table == "test-table"
        assert args.table_type == "good"
        assert args.rps == 3000
        assert args.duration == 60
        assert args.tokyo_ratio == 0.9
        assert args.threads == 200
        assert args.region == "ap-northeast-1"
        assert args.no_retry is True

    def test_parse_args_invalid_table_type(self):
        """Invalid --table-type should cause SystemExit."""
        with pytest.raises(SystemExit):
            load_test.parse_args(["--table", "t", "--table-type", "invalid"])

    def test_parse_args_no_retry_flag(self):
        """--no-retry should be True when specified."""
        args = load_test.parse_args(["--table", "t", "--no-retry"])
        assert args.no_retry is True


# =============================================================================
# 2. Report format tests
# =============================================================================


class TestPercentile:
    """Tests for _percentile() helper."""

    def test_percentile_empty(self):
        """_percentile with empty list returns 0.0."""
        assert load_test._percentile([], 50) == 0.0

    def test_percentile_single(self):
        """_percentile with single element returns that element."""
        assert load_test._percentile([0.5], 50) == 0.5
        assert load_test._percentile([0.5], 99) == 0.5

    def test_percentile_values(self):
        """_percentile calculates p50, p95, p99 correctly."""
        # Create a sorted list 0..99
        data = list(range(100))
        assert load_test._percentile(data, 50) == 50
        assert load_test._percentile(data, 95) == 95
        assert load_test._percentile(data, 99) == 99


class TestPrintSummary:
    """Tests for print_summary() output formatting."""

    def _reset_globals(self):
        """Reset module-level counters before each test."""
        load_test.success_count = 0
        load_test.throttle_count = 0
        load_test.latencies = []

    def test_print_summary_no_requests(self, capsys):
        """print_summary with 0 requests shows 'No requests were completed.'"""
        self._reset_globals()
        load_test.print_summary(10.0)
        captured = capsys.readouterr()
        assert "No requests were completed." in captured.out

    def test_print_summary_format(self, capsys):
        """print_summary outputs correct format with p50/p95/p99."""
        self._reset_globals()
        # Simulate 100 successful requests with latencies 0.001 to 0.100
        load_test.success_count = 80
        load_test.throttle_count = 20
        load_test.latencies = [i * 0.001 for i in range(1, 101)]

        load_test.print_summary(10.0)
        captured = capsys.readouterr()

        assert "=== SUMMARY ===" in captured.out
        assert "Duration: 10s" in captured.out
        assert "Total: 100" in captured.out
        assert "Success: 80 (80.0%)" in captured.out
        assert "Throttle: 20 (20.0%)" in captured.out
        assert "p50=" in captured.out
        assert "p95=" in captured.out
        assert "p99=" in captured.out


# =============================================================================
# 3. Weighted selection tests
# =============================================================================


class TestSelectSkuItem:
    """Tests for select_sku_item() weighted random selection."""

    def test_select_sku_item_tokyo_ratio(self):
        """With tokyo_ratio=0.7, ~70% should be WH-TOKYO."""
        tokyo_items = [{"warehouseId": "WH-TOKYO", "itemId": f"SKU-{i}"} for i in range(10)]
        other_items = [{"warehouseId": "WH-OSAKA", "itemId": f"SKU-{i}"} for i in range(10)]

        import random
        random.seed(42)

        n = 10000
        tokyo_count = sum(
            1
            for _ in range(n)
            if load_test.select_sku_item(tokyo_items, other_items, 0.7)["warehouseId"] == "WH-TOKYO"
        )

        ratio = tokyo_count / n
        # Allow reasonable statistical tolerance
        assert 0.65 <= ratio <= 0.75, f"Expected ~0.7, got {ratio}"

    def test_select_sku_item_no_tokyo_items(self):
        """When no tokyo items, always returns from other_items."""
        other_items = [{"warehouseId": "WH-OSAKA", "itemId": "SKU-001"}]

        for _ in range(100):
            result = load_test.select_sku_item([], other_items, 0.7)
            assert result["warehouseId"] == "WH-OSAKA"

    def test_select_sku_item_no_other_items(self):
        """When no other items, always returns from tokyo_items."""
        tokyo_items = [{"warehouseId": "WH-TOKYO", "itemId": "SKU-001"}]

        for _ in range(100):
            result = load_test.select_sku_item(tokyo_items, [], 0.7)
            assert result["warehouseId"] == "WH-TOKYO"
