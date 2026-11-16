'use strict';

const MAX_RUNNING = Number(process.env.JOB_CONCURRENCY || 2);
const TTL_MS = 30 * 60 * 1000;
const MAX_LOG_LINES = 400;

const jobs = new Map();
const queue = [];
let running = 0;
let seq = 0;

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const { job, runner } = queue.shift();
    running += 1;
    job.status = 'running';
    job.startedAt = Date.now();

    const log = (line) => {
      if (job.log.length < MAX_LOG_LINES) job.log.push(line);
    };

    Promise.resolve()
      .then(() => runner(log))
      .then((result) => {
        if (result && result.ok) {
          job.status = 'done';
          job.result = result;
        } else {
          job.status = 'error';
          job.error = (result && result.error) || 'Engine selesai tanpa hasil.';
        }
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err.message || String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        running -= 1;
        pump();
      });
  }
}

function create(kind, runner) {
  const id = `${Date.now().toString(36)}${(seq += 1).toString(36)}`;
  const job = {
    id,
    kind,
    status: 'queued',
    log: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  queue.push({ job, runner });
  pump();
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

/** Job state for the client; the result body only appears once it is done. */
function view(job) {
  const elapsed = (job.finishedAt || Date.now()) - (job.startedAt || job.createdAt);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    log: job.log.slice(-40),
    elapsedMs: elapsed,
    error: job.error,
    result: job.status === 'done' ? job.result : null,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const end = job.finishedAt || job.createdAt;
    if (now - end > TTL_MS) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { create, get, view, stats: () => ({ running, queued: queue.length, total: jobs.size }) };
