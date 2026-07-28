"""DynamoDB load generator script for hot partition demonstration.

This script generates concurrent UpdateItem requests against a DynamoDB table
to demonstrate the effects of hot partitions on provisioned throughput.
"""

import argparse
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


# --- Shared state for metrics (thread-safe) ---

_lock = threading.Lock()
success_count = 0
throttle_count = 0
latencies = []

# Per-second metrics for real-time reporting
_second_latencies = []
_second_success = 0
_second_throttle = 0


def _reset_counters():
    """Reset all shared counters. Used at the start of each test run."""
    global success_count, throttle_count, latencies
    global _second_latencies, _second_success, _second_throttle
    with _lock:
        success_count = 0
        throttle_count = 0
        latencies = []
        _second_latencies = []
        _second_success = 0
        _second_throttle = 0


def parse_args(argv=None):
    """Parse command line arguments.

    Args:
        argv: Argument list to parse. Defaults to sys.argv[1:].

    Returns:
        Parsed arguments namespace.
    """
    parser = argparse.ArgumentParser(
        description="DynamoDB load generator for hot partition demonstration"
    )

    parser.add_argument(
        "--table",
        required=True,
        help="DynamoDB table name (required)",
    )
    parser.add_argument(
        "--table-type",
        default="bad",
        choices=["bad", "good"],
        help="Table key schema type: 'bad' (hot partition) or 'good' (distributed) (default: bad)",
    )
    parser.add_argument(
        "--rps",
        type=int,
        default=1500,
        help="Target requests per second (default: 1500)",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=120,
        help="Test duration in seconds (default: 120)",
    )
    parser.add_argument(
        "--tokyo-ratio",
        type=float,
        default=0.7,
        help="Ratio of requests targeting WH-TOKYO warehouse (default: 0.7)",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=100,
        help="Number of concurrent threads (default: 100)",
    )
    parser.add_argument(
        "--region",
        default="us-west-2",
        help="AWS region (default: us-west-2)",
    )
    parser.add_argument(
        "--no-retry",
        action="store_true",
        help="Disable SDK automatic retries",
    )

    return parser.parse_args(argv)


def scan_sku_list(table_name, table_type, region, no_retry):
    """Scan DynamoDB table to retrieve the list of SKU/warehouse pairs.

    Scans the target table with pagination handling (up to 1,000 items)
    and extracts unique (warehouseId, itemId) pairs based on the table schema.

    Args:
        table_name: Name of the DynamoDB table to scan.
        table_type: 'bad' or 'good' indicating the key schema.
            - bad: PK=warehouseId, SK=itemId
            - good: PK=itemId, SK=warehouseId
        region: AWS region for the DynamoDB client.
        no_retry: If True, disable SDK automatic retries.

    Returns:
        List of dicts with 'warehouseId' and 'itemId' keys.
        Example: [{"warehouseId": "WH-TOKYO", "itemId": "SKU-001"}, ...]
    """
    config_kwargs = {}
    if no_retry:
        config_kwargs["retries"] = {"max_attempts": 0}

    dynamodb = boto3.resource(
        "dynamodb",
        region_name=region,
        config=Config(**config_kwargs) if config_kwargs else None,
    )
    table = dynamodb.Table(table_name)

    items = []
    scan_kwargs = {}
    max_items = 1000

    while len(items) < max_items:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    items = items[:max_items]

    if not items:
        print(f"ERROR: Table '{table_name}' is empty. No SKU data found.")
        print("Please seed the table with inventory data before running the load test.")
        sys.exit(1)

    # Extract unique (warehouseId, itemId) pairs based on table schema
    seen = set()
    sku_list = []

    for item in items:
        if table_type == "bad":
            warehouse_id = item.get("warehouseId", "")
            sku_id = item.get("itemId", "")
        else:
            sku_id = item.get("itemId", "")
            warehouse_id = item.get("warehouseId", "")

        pair = (warehouse_id, sku_id)
        if pair not in seen and warehouse_id and sku_id:
            seen.add(pair)
            sku_list.append({"warehouseId": warehouse_id, "itemId": sku_id})

    if not sku_list:
        print(f"ERROR: Could not extract valid SKU pairs from table '{table_name}'.")
        sys.exit(1)

    print(f"Loaded {len(sku_list)} unique SKU/warehouse pairs from '{table_name}'.")
    return sku_list


def select_sku_item(tokyo_items, other_items, tokyo_ratio):
    """Select a SKU item using weighted random selection based on tokyo_ratio.

    With probability `tokyo_ratio`, picks randomly from tokyo_items.
    With probability `1 - tokyo_ratio`, picks randomly from other_items.
    Handles edge cases where one group is empty.

    Args:
        tokyo_items: List of SKU dicts where warehouseId == "WH-TOKYO".
        other_items: List of SKU dicts where warehouseId != "WH-TOKYO".
        tokyo_ratio: Probability (0.0-1.0) of selecting from tokyo_items.

    Returns:
        A single SKU dict with 'warehouseId' and 'itemId' keys.
    """
    if not tokyo_items:
        return random.choice(other_items)
    if not other_items:
        return random.choice(tokyo_items)

    if random.random() < tokyo_ratio:
        return random.choice(tokyo_items)
    else:
        return random.choice(other_items)


def _do_update_item(client, table_name, table_type, sku_item):
    """Execute a single UpdateItem request and record metrics.

    Args:
        client: Low-level DynamoDB client (boto3.client).
        table_name: Target DynamoDB table name.
        table_type: 'bad' or 'good' (determines key structure).
        sku_item: Dict with 'warehouseId' and 'itemId' keys.
    """
    global success_count, throttle_count, latencies
    global _second_latencies, _second_success, _second_throttle

    warehouse = sku_item["warehouseId"]
    sku = sku_item["itemId"]

    if table_type == "bad":
        key = {
            "warehouseId": {"S": warehouse},
            "itemId": {"S": sku},
        }
    else:
        key = {
            "itemId": {"S": sku},
            "warehouseId": {"S": warehouse},
        }

    start = time.time()
    try:
        client.update_item(
            TableName=table_name,
            Key=key,
            UpdateExpression="ADD loadTestCounter :inc",
            ExpressionAttributeValues={":inc": {"N": "1"}},
        )
        elapsed = time.time() - start
        with _lock:
            success_count += 1
            latencies.append(elapsed)
            _second_success += 1
            _second_latencies.append(elapsed)
    except ClientError as e:
        elapsed = time.time() - start
        error_code = e.response["Error"]["Code"]
        if error_code == "ProvisionedThroughputExceededException":
            with _lock:
                throttle_count += 1
                latencies.append(elapsed)
                _second_throttle += 1
                _second_latencies.append(elapsed)
        else:
            # Re-raise unexpected errors after recording
            with _lock:
                latencies.append(elapsed)
                _second_latencies.append(elapsed)
            raise


def _percentile(sorted_data, pct):
    """Calculate percentile from a sorted list.

    Args:
        sorted_data: Pre-sorted list of numeric values.
        pct: Percentile to calculate (0-100).

    Returns:
        The percentile value, or 0.0 if the list is empty.
    """
    if not sorted_data:
        return 0.0
    idx = int(len(sorted_data) * pct / 100.0)
    idx = min(idx, len(sorted_data) - 1)
    return sorted_data[idx]


def _reporter_thread(stop_event, duration):
    """Daemon thread that prints per-second metrics.

    Wakes up every 1 second, reads and resets the per-second counters,
    then prints a formatted line with RPS, success, throttle, p50, p95.

    Args:
        stop_event: threading.Event signaling the thread to stop.
        duration: Total test duration (used for elapsed counter display).
    """
    global _second_latencies, _second_success, _second_throttle

    elapsed_seconds = 0

    while not stop_event.is_set():
        stop_event.wait(timeout=1.0)
        elapsed_seconds += 1

        # Atomically swap out the per-second metrics
        with _lock:
            sec_latencies = _second_latencies
            sec_success = _second_success
            sec_throttle = _second_throttle
            _second_latencies = []
            _second_success = 0
            _second_throttle = 0

        rps = sec_success + sec_throttle
        sorted_lats = sorted(sec_latencies)
        p50_ms = int(_percentile(sorted_lats, 50) * 1000)
        p95_ms = int(_percentile(sorted_lats, 95) * 1000)

        print(
            f"[{elapsed_seconds:3d}s] rps={rps:<5d} "
            f"success={sec_success:<5d} "
            f"throttle={sec_throttle:<5d}  "
            f"p50={p50_ms}ms  p95={p95_ms}ms"
        )


def print_summary(actual_duration):
    """Print a summary report at the end of the load test.

    Uses the global success_count, throttle_count, and latencies to
    calculate and display aggregate metrics including percentile latencies.

    Args:
        actual_duration: Elapsed time in seconds for the test run.
    """
    total = success_count + throttle_count

    print("\n=== SUMMARY ===")
    print(f"Duration: {actual_duration:.0f}s")

    if total == 0:
        print("No requests were completed.")
        return

    success_rate = success_count / total * 100
    throttle_rate = throttle_count / total * 100

    sorted_lats = sorted(latencies)
    p50_ms = int(_percentile(sorted_lats, 50) * 1000)
    p95_ms = int(_percentile(sorted_lats, 95) * 1000)
    p99_ms = int(_percentile(sorted_lats, 99) * 1000)

    print(f"Total: {total:,}")
    print(f"Success: {success_count:,} ({success_rate:.1f}%)")
    print(f"Throttle: {throttle_count:,} ({throttle_rate:.1f}%)")
    print(f"Latency: p50={p50_ms}ms  p95={p95_ms}ms  p99={p99_ms}ms")


def run_load_test(args, sku_list):
    """Run the load test using ThreadPoolExecutor.

    Creates a DynamoDB low-level client and submits UpdateItem requests
    at the target RPS for the specified duration using a thread pool.

    Args:
        args: Parsed command line arguments.
        sku_list: List of dicts with 'warehouseId' and 'itemId' keys.
    """
    _reset_counters()

    # Pre-compute tokyo/other split for weighted random selection
    tokyo_items = [item for item in sku_list if item["warehouseId"] == "WH-TOKYO"]
    other_items = [item for item in sku_list if item["warehouseId"] != "WH-TOKYO"]

    if not tokyo_items:
        print("WARNING: No WH-TOKYO items found. All requests will target other warehouses.")
    if not other_items:
        print("WARNING: No non-Tokyo items found. All requests will target WH-TOKYO.")

    print(f"  Tokyo items: {len(tokyo_items)}, Other items: {len(other_items)}")

    # Create low-level DynamoDB client
    config_kwargs = {}
    if args.no_retry:
        config_kwargs["retries"] = {"max_attempts": 0}

    client = boto3.client(
        "dynamodb",
        region_name=args.region,
        config=Config(**config_kwargs) if config_kwargs else None,
    )

    print(f"\nStarting load test: {args.rps} RPS × {args.duration}s "
          f"with {args.threads} threads")
    print(f"  Tokyo ratio: {args.tokyo_ratio}")
    print("-" * 60)

    # Start the per-second reporter thread
    stop_event = threading.Event()
    reporter = threading.Thread(
        target=_reporter_thread,
        args=(stop_event, args.duration),
        daemon=True,
    )
    reporter.start()

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        test_start = time.time()

        for second in range(args.duration):
            second_start = time.time()

            # Submit args.rps requests distributed evenly within this second
            # Use micro-batching: split RPS into small bursts spread across the second
            batch_count = min(args.rps, 10)  # Up to 10 batches per second
            requests_per_batch = args.rps // batch_count
            remainder = args.rps % batch_count
            interval = 1.0 / batch_count

            futures = []
            for batch_idx in range(batch_count):
                batch_start = time.time()
                count = requests_per_batch + (1 if batch_idx < remainder else 0)

                for _ in range(count):
                    sku_item = select_sku_item(tokyo_items, other_items, args.tokyo_ratio)
                    future = executor.submit(
                        _do_update_item,
                        client,
                        args.table,
                        args.table_type,
                        sku_item,
                    )
                    futures.append(future)

                # Sleep to spread requests evenly across the second
                elapsed_in_batch = time.time() - batch_start
                sleep_time = interval - elapsed_in_batch
                if sleep_time > 0 and batch_idx < batch_count - 1:
                    time.sleep(sleep_time)

            # Wait for all futures of this second to complete (best effort)
            # Don't block indefinitely - allow overlap into next second
            for future in futures:
                try:
                    future.result(timeout=5.0)
                except Exception:
                    pass

            # Check if we've exceeded the total duration
            total_elapsed = time.time() - test_start
            if total_elapsed >= args.duration:
                break

    # Stop the reporter thread cleanly
    stop_event.set()
    reporter.join(timeout=2.0)

    actual_duration = time.time() - test_start

    print("-" * 60)
    print("Load test completed.")

    print_summary(actual_duration)


def main(args):
    """Main entry point for load generation.

    Args:
        args: Parsed command line arguments.
    """
    print(f"Load test configuration:")
    print(f"  Table:       {args.table}")
    print(f"  Table type:  {args.table_type}")
    print(f"  Target RPS:  {args.rps}")
    print(f"  Duration:    {args.duration}s")
    print(f"  Tokyo ratio: {args.tokyo_ratio}")
    print(f"  Threads:     {args.threads}")
    print(f"  Region:      {args.region}")
    print(f"  No retry:    {args.no_retry}")

    # Scan the table to get SKU list for load generation
    sku_list = scan_sku_list(args.table, args.table_type, args.region, args.no_retry)
    print(f"  SKU pairs:   {len(sku_list)}")

    # Run load test
    run_load_test(args, sku_list)


if __name__ == "__main__":
    parsed_args = parse_args()
    main(parsed_args)
