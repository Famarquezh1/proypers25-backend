"""Execute the actual download/guard shell blocks with an offline gh fixture."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


def block(source, name):
    lines = source.splitlines()
    start = next(i for i, line in enumerate(lines) if line == '      - name: ' + name)
    run = next(i for i in range(start + 1, len(lines)) if lines[i] == '        run: |')
    body = []
    for line in lines[run + 1:]:
        if line.strip() and not line.startswith('          '):
            break
        body.append(line)
    return textwrap.dedent('\n'.join(body))


class QpuEvidenceWorkflowTests(unittest.TestCase):
    def test_missing_source_is_valid_research_but_api_and_download_errors_fail(self):
        for version in ('v08', 'v09'):
            source = (ROOT / '.github/workflows' / f'qpu-{version}-consensus-shadow.yml').read_text()
            for mode in ('missing', 'quota', 'download_error', 'found'):
                with self.subTest(version=version, mode=mode), tempfile.TemporaryDirectory() as directory:
                    work = Path(directory)
                    gh = work / 'gh'
                    gh.write_text('''#!/bin/bash
if [ "$1" = api ]; then
  if [ "$MODE" = quota ]; then echo 'HTTP 403 quota' >&2; exit 1; fi
  if [ "$MODE" != missing ]; then echo 42; fi
elif [ "$MODE" = download_error ]; then
  echo 'HTTP 403 download' >&2; exit 1
fi
''')
                    gh.chmod(0o755)
                    output = work / 'output'
                    env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                           'MODE': mode, 'GITHUB_REPOSITORY': 'owner/repo', 'RUN_ID': '123', 'GITHUB_OUTPUT': str(output)}
                    result = subprocess.run(['bash', '-c', block(source, 'Download V10 QPU payload')], cwd=work, env=env, capture_output=True)
                    self.assertEqual(result.returncode == 0, mode in ('missing', 'found'))
                    decision = work / f'qpu-{version}-shadow-decision.json'
                    if mode == 'missing':
                        data = json.loads(decision.read_text())
                        self.assertFalse(data['scored'])
                        self.assertEqual(data['reason'], 'SOURCE_ARTIFACT_NOT_FOUND')
                        # Execute the semantic JSON assertion from the actual guard.
                        guard = block(source, 'Guard shadow isolation').splitlines()[1]
                        checked = subprocess.run(['bash', '-c', guard], cwd=work, env=env, capture_output=True)
                        self.assertEqual(checked.returncode, 0, checked.stderr)
                        decision.write_text('{"shadow_only":false,"no_order_created":true}')
                        rejected = subprocess.run(['bash', '-c', guard], cwd=work, env=env, capture_output=True)
                        self.assertNotEqual(rejected.returncode, 0)
                    else:
                        self.assertFalse(decision.exists())
                    if mode == 'found':
                        self.assertIn('found=true', output.read_text())


if __name__ == '__main__':
    unittest.main()
