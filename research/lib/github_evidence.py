"""Bounded, checkpointed transport for immutable research evidence only."""
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
import zipfile


class EvidenceUnavailable(RuntimeError):
    """Quota, permissions or request budget prevented a complete evaluation."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubEvidence:
    def __init__(self, repo, token, directory='.research-cache/github', max_requests=160):
        self.repo = repo
        self.token = token
        self.directory = Path(directory) / repo
        self.max_requests = max_requests
        self.requests = 0

    def _file(self, key):
        return self.directory / hashlib.sha256(key.encode()).hexdigest()

    def _cached(self, key, loader):
        file = self._file(key)
        if file.exists():
            return file.read_bytes()
        data = loader()
        file.parent.mkdir(parents=True, exist_ok=True)
        temp = file.with_suffix('.tmp')
        temp.write_bytes(data)
        temp.replace(file)
        return data

    def _open(self, path, redirect=True):
        for attempt in range(2):
            self.requests += 1
            if self.requests > self.max_requests:
                raise EvidenceUnavailable('GitHub request budget exhausted; checkpoint saved, evaluation incomplete')
            req = urllib.request.Request('https://api.github.com/repos/' + self.repo + path,
                headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                         'User-Agent': 'proypers25-research-evidence/1.0'})
            try:
                opener = urllib.request.urlopen if redirect else urllib.request.build_opener(NoRedirect).open
                return opener(req, timeout=30)
            except urllib.error.HTTPError as error:
                if not redirect and error.code in (301, 302, 303, 307, 308):
                    return error
                try:
                    retry = float(error.headers.get('Retry-After', '0'))
                except ValueError:
                    retry = 0
                if attempt == 0 and (error.code >= 500 or (error.code == 429 and 0 < retry <= 5)):
                    error.close()
                    time.sleep(retry if error.code == 429 else 1)
                    continue
                if error.code in (401, 403, 429):
                    reset = error.headers.get('X-RateLimit-Reset', 'unknown')
                    error.close()
                    raise EvidenceUnavailable(f'GitHub HTTP {error.code}; quota/permissions blocked evidence; reset={reset}') from error
                raise

    def json(self, path, immutable_key=None):
        def load():
            with self._open(path) as response:
                data = response.read()
                json.loads(data)  # Never checkpoint malformed responses.
                return data
        return json.loads(self._cached(immutable_key, load) if immutable_key else load())

    def archive(self, artifact_id):
        def load():
            first = self._open(f'/actions/artifacts/{artifact_id}/zip', redirect=False)
            location = first.headers.get('Location')
            first.close()
            if not location or not location.startswith('https://'):
                raise EvidenceUnavailable(f'Artifact {artifact_id}: missing HTTPS signed URL')
            # Storage receives no GitHub Authorization header.
            with urllib.request.urlopen(urllib.request.Request(location,
                    headers={'User-Agent': 'proypers25-research-evidence/1.0'}), timeout=60) as response:
                blob = response.read()
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                if archive.testzip() is not None:
                    raise ValueError('Corrupt evidence archive')
            return blob
        return self._cached(f'archive:{artifact_id}', load)

    def successful_artifacts(self, workflow, prefix, limit=None):
        count = 0
        for page in range(1, 31):
            runs = self.json(f'/actions/workflows/{workflow}/runs?branch=main&status=success&per_page=100&page={page}').get('workflow_runs', [])
            for run in runs:
                if run.get('status') != 'completed' or run.get('conclusion') != 'success':
                    continue
                key = f"manifest:{run['id']}:{run.get('run_attempt', 1)}"
                manifest = self.json(f"/actions/runs/{run['id']}/artifacts?per_page=100", immutable_key=key)
                if manifest.get('total_count', 0) > 100:
                    raise EvidenceUnavailable('Artifact manifest exceeds one page; evaluation incomplete')
                for artifact in manifest.get('artifacts', []):
                    if not artifact.get('expired') and str(artifact.get('name', '')).startswith(prefix):
                        yield run, artifact
                count += 1
                if limit is not None and count >= limit:
                    return
            if len(runs) < 100:
                return
        raise EvidenceUnavailable('History exceeds 30 pages; evaluation incomplete, checkpoint saved')


def download_decisions(workflow, prefix, member, output):
    client = GitHubEvidence(os.environ.get('GITHUB_REPOSITORY', 'Famarquezh1/proypers25-backend'),
                            os.environ.get('GH_TOKEN', ''))
    for run, artifact in client.successful_artifacts(workflow, prefix, limit=100):
        with zipfile.ZipFile(io.BytesIO(client.archive(artifact['id']))) as archive:
            matches = [name for name in archive.namelist() if Path(name).name == member]
            if len(matches) != 1:
                raise EvidenceUnavailable(f"Artifact {artifact['id']}: expected one {member}")
            data = archive.read(matches[0])
            json.loads(data.decode('utf-8-sig'))
        target = Path(output) / f"{run['id']}-{run.get('run_attempt', 1)}" / member
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    for name in ('workflow', 'prefix', 'member', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    download_decisions(args.workflow, args.prefix, args.member, args.output)
