'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only parsed evidence from successful, completed run attempts is persisted.
// Run indexes and failures are always fetched again. No tokens or signed URLs.
function createEvidenceClient({repo, token, fetchImpl = fetch, directory = '.research-cache/precore', maxRequests = 100, sleep = ms => new Promise(r => setTimeout(r, ms))}) {
  let requests = 0;
  async function request(endpoint, options = {}, text = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (++requests > maxRequests) throw new Error('GitHub request budget exhausted; evidence incomplete');
      const r = await fetchImpl('https://api.github.com/repos/' + repo + endpoint, {
        ...options, signal: AbortSignal.timeout(30000),
        headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(options.headers || {})}
      });
      if (r.ok) { const raw = await r.text(); return text ? raw : (raw ? JSON.parse(raw) : {}); }
      const retry = Number(r.headers.get('retry-after'));
      // Never spin on exhausted installation quota or permission errors.
      if (attempt === 0 && (r.status >= 500 || (r.status === 429 && retry > 0 && retry <= 5))) {
        await sleep(r.status === 429 ? retry * 1000 : 1000); continue;
      }
      throw new Error('GitHub ' + r.status + ' reset=' + (r.headers.get('x-ratelimit-reset') || 'unknown') + ': ' + await r.text());
    }
  }
  async function evidence(run, workflow, jobName, extract) {
    if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Evidence requires a completed successful run');
    const file = path.join(directory, repo, workflow, String(run.id) + '-' + (run.run_attempt || 1) + '.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.repo === repo && saved.run_id === run.id && saved.attempt === (run.run_attempt || 1) && saved.result?.ok === true) return saved.result;
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    const jobs = await request('/actions/runs/' + run.id + '/jobs?per_page=20');
    const job = (jobs.jobs || []).find(j => j.name === jobName);
    if (!job) throw new Error('Missing evidence job ' + jobName + ' for run ' + run.id);
    const result = extract(await request('/actions/jobs/' + job.id + '/logs', {}, true));
    if (!result || result.ok !== true) throw new Error('Invalid or missing evidence for run ' + run.id);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify({repo, run_id: run.id, attempt: run.run_attempt || 1, result}));
    fs.renameSync(file + '.tmp', file);
    return result;
  }
  return {request, evidence};
}
module.exports = {createEvidenceClient};
