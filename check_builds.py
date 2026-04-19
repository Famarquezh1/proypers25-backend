#!/usr/bin/env python
import subprocess
import json

try:
    result = subprocess.run(
        ['gcloud', 'builds', 'list', '--limit=5', '--format=json'],
        capture_output=True,
        text=True,
        timeout=30
    )
    
    if result.returncode == 0:
        builds = json.loads(result.stdout)
        print("\n=== RECENT BUILDS ===\n")
        for b in builds:
            build_id = b.get('id', 'N/A')[:8]
            status = b.get('status', 'UNKNOWN')
            create_time = b.get('createTime', 'N/A')[:10]
            print(f"Build {build_id} | Status: {status} | Created: {create_time}")
        print()
    else:
        print("Error:", result.stderr[:200])
except Exception as e:
    print(f"Exception: {e}")
