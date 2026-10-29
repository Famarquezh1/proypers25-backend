import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from github_evidence import GitHubEvidence, EvidenceUnavailable


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = GitHubEvidence('owner/repo', 'secret', self.temp.name)

    def test_manifest_reused_but_attempt_and_index_refreshed(self):
        run = dict(id=1, run_attempt=1, status='completed', conclusion='success')
        def response(req, timeout):
            if '/runs?' in req.full_url:
                return io.BytesIO(json.dumps({'workflow_runs': [run]}).encode())
            return io.BytesIO(b'{"artifacts":[{"id":2,"name":"prefix-data"}]}')
        with patch('urllib.request.urlopen', side_effect=response) as fetch:
            self.assertEqual(len(list(self.client.successful_artifacts('workflow.yml', 'prefix-'))), 1)
            list(self.client.successful_artifacts('workflow.yml', 'prefix-'))
            self.assertEqual(fetch.call_count, 3)
            run['run_attempt'] = 2
            list(self.client.successful_artifacts('workflow.yml', 'prefix-'))
            self.assertEqual(fetch.call_count, 5)

    def test_archive_cached_without_token_forwarding(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('decision.json', '{"ok":true}')
        redirect = io.BytesIO()
        redirect.headers = {'Location': 'https://storage.example/signed'}
        with patch.object(self.client, '_open', return_value=redirect) as api, patch('urllib.request.urlopen', return_value=io.BytesIO(buffer.getvalue())) as storage:
            self.assertEqual(self.client.archive(2), self.client.archive(2))
            self.assertEqual(api.call_count, 1)
            self.assertNotIn('Authorization', storage.call_args.args[0].headers)
        for f in Path(self.temp.name).rglob('*'):
            if f.is_file():
                self.assertNotIn(b'secret', f.read_bytes())
                self.assertNotIn(b'https://storage.example', f.read_bytes())

    def test_quota_fails_without_retry_or_checkpoint(self):
        error = urllib.error.HTTPError('https://api.github.com', 403, 'quota', {'X-RateLimit-Reset': '123'}, io.BytesIO())
        with patch('urllib.request.urlopen', side_effect=error) as fetch:
            with self.assertRaisesRegex(EvidenceUnavailable, 'HTTP 403.*123'):
                self.client.json('/index', 'immutable')
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual(list(Path(self.temp.name).rglob('*')), [])

    def test_budget_and_single_transient_retry(self):
        self.client.max_requests = 2
        error = urllib.error.HTTPError('https://api.github.com', 503, 'busy', {}, io.BytesIO())
        with patch('urllib.request.urlopen', side_effect=[error, io.BytesIO(b'{}')]), patch('time.sleep') as sleep:
            self.assertEqual(self.client.json('/index'), {})
            sleep.assert_called_once_with(1)
            with self.assertRaisesRegex(EvidenceUnavailable, 'budget exhausted'):
                self.client.json('/index')

    def test_no_silent_manifest_truncation(self):
        run = dict(id=1, status='completed', conclusion='success')
        with patch.object(self.client, 'json', side_effect=[{'workflow_runs': [run]}, {'total_count': 101}]):
            with self.assertRaisesRegex(EvidenceUnavailable, 'exceeds one page'):
                list(self.client.successful_artifacts('workflow.yml', 'prefix'))


if __name__ == '__main__':
    unittest.main()
